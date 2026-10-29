// The SQT mailbox over IMAP (user ask 2026-10-28) — the Hostinger mailbox
// SquareTrade writes to is the one the backend already sends from
// (HOSTINGER_SMTP_SUPPORT_USER / PASS; IMAP host imap.hostinger.com:993).
// SQT → Need Attention keeps only a pointer per email (sqt_case_emails:
// Message-ID + folder/uid) and reads the email from here when it's opened.
//
// Every read runs on an EXAMINE'd (read-only) folder, so nothing here can
// change an email's read status or flags — another automation owns those.
//
//   locate(messageId, { folder, uid })  -> { folder, uid } | null
//   resolveFolder("Cases Follow up")    -> "INBOX.Cases Follow up" | null
//   fetchParsed(folder, uid, messageId) -> mailparser ParsedMail (cached)
//   appendToSent(raw)                   -> { folder, uid } (a copy of a reply)
//   summarize(parsed)                   -> the fields a pointer record keeps
//   mailboxAddress()                    -> our address (to leave out of Cc)
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

// The folder the pickup automation moves follow-ups into; searched first.
const followUpFolderName = () => process.env.SQT_FOLLOWUP_FOLDER || "Cases Follow up";
const IDLE_MS = 5 * 60 * 1000;
const FOLDERS_TTL_MS = 10 * 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 20;
const CACHE_MAX_BYTES = 8 * 1024 * 1024;

function mailboxAddress() {
  return String(process.env.HOSTINGER_SMTP_SUPPORT_USER || "").trim();
}

function config() {
  const user = mailboxAddress();
  const pass = process.env.HOSTINGER_SMTP_SUPPORT_PASS;
  if (!user || !pass) {
    throw new Error("The SQT mailbox is not configured (HOSTINGER_SMTP_SUPPORT_* missing in .env).");
  }
  const host =
    process.env.HOSTINGER_IMAP_HOST ||
    String(process.env.HOSTINGER_SMTP_HOST || "").replace(/^smtp\./, "imap.") ||
    "imap.hostinger.com";
  return {
    host,
    port: Number(process.env.HOSTINGER_IMAP_PORT) || 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  };
}

// ── one shared connection, closed after 5 idle minutes ────────────────
let client = null;
let connecting = null;
let idleTimer = null;

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const c = client;
    client = null;
    if (c) c.logout().catch(() => {});
  }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

async function getClient() {
  if (client && client.usable) {
    touch();
    return client;
  }
  if (!connecting) {
    connecting = (async () => {
      const c = new ImapFlow(config());
      c.on("error", (err) => console.error("SQT mailbox IMAP error:", err.message));
      c.on("close", () => {
        if (client === c) client = null;
      });
      await c.connect();
      client = c;
      touch();
      return c;
    })().finally(() => {
      connecting = null;
    });
  }
  return connecting;
}

// Runs fn with `path` selected read-only; the lock queues other callers.
async function withFolder(path, fn) {
  const c = await getClient();
  const lock = await c.getMailboxLock(path, { readOnly: true });
  try {
    return await fn(c);
  } finally {
    lock.release();
  }
}

// ── folders ───────────────────────────────────────────────────────────
let folderCache = null;

async function folders() {
  if (folderCache && Date.now() - folderCache.at < FOLDERS_TTL_MS) return folderCache.list;
  const c = await getClient();
  const list = (await c.list()).map((f) => ({ path: f.path, name: f.name, specialUse: f.specialUse || null }));
  folderCache = { at: Date.now(), list };
  return list;
}

// "Cases Follow up" → "INBOX.Cases Follow up" (Hostinger nests under INBOX).
async function resolveFolder(name) {
  const want = String(name || "").trim().toLowerCase();
  if (!want) return null;
  const list = await folders();
  const hit =
    list.find((f) => f.path.toLowerCase() === want) ||
    list.find((f) => String(f.name).toLowerCase() === want);
  return hit ? hit.path : null;
}

// Where to look for a Message-ID: the hint, the follow-up folder, INBOX,
// then every other folder (an email may have been filed anywhere).
async function searchOrder(hintFolder) {
  const list = await folders();
  const first = [hintFolder, await resolveFolder(followUpFolderName()), "INBOX"].filter(Boolean);
  const rest = list.map((f) => f.path).filter((p) => !first.includes(p));
  return [...new Set([...first, ...rest])];
}

const normId = (id) => {
  const s = String(id || "").trim();
  if (!s) return "";
  return s.startsWith("<") ? s : `<${s}>`;
};
const sameId = (a, b) => normId(a).toLowerCase() === normId(b).toLowerCase();

// Where each Message-ID was last confirmed — skips the IMAP check when the
// same email is opened again within a few minutes.
const located = new Map(); // id -> { at, folder, uid }

async function locate(messageId, hint = {}) {
  const id = normId(messageId);
  if (!id) return null;
  const key = id.toLowerCase();
  const seen = located.get(key);
  if (seen && Date.now() - seen.at < CACHE_TTL_MS) return { folder: seen.folder, uid: seen.uid };
  const found = (where) => {
    located.set(key, { at: Date.now(), ...where });
    while (located.size > 500) located.delete(located.keys().next().value);
    return where;
  };
  if (hint.folder && hint.uid) {
    const ok = await withFolder(hint.folder, async (c) => {
      const m = await c.fetchOne(String(hint.uid), { envelope: true }, { uid: true });
      return !!(m && m.envelope && sameId(m.envelope.messageId, id));
    }).catch(() => false);
    if (ok) return found({ folder: hint.folder, uid: Number(hint.uid) });
  }
  for (const folder of await searchOrder(hint.folder)) {
    const uids = await withFolder(folder, (c) =>
      c.search({ header: { "message-id": id } }, { uid: true }),
    ).catch(() => null);
    if (uids && uids.length) return found({ folder, uid: Number(uids[uids.length - 1]) });
  }
  return null;
}

// ── reading ───────────────────────────────────────────────────────────
const cache = new Map(); // `${folder}#${uid}` -> { at, parsed }

async function fetchParsed(folder, uid) {
  const key = `${folder}#${uid}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.parsed;
  const source = await withFolder(folder, async (c) => {
    const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
    return m && m.source;
  });
  if (!source) return null;
  const parsed = await simpleParser(source);
  if (source.length <= CACHE_MAX_BYTES) {
    cache.set(key, { at: Date.now(), parsed });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return parsed;
}

// mailparser AddressObject(s) → [{ name, address }]
function addresses(obj) {
  const list = Array.isArray(obj) ? obj : obj ? [obj] : [];
  const out = [];
  for (const a of list) {
    for (const v of a.value || []) {
      if (v.address) out.push({ name: v.name || "", address: v.address });
      for (const g of v.group || []) if (g.address) out.push({ name: g.name || "", address: g.address });
    }
  }
  return out;
}

// The new part of an email — cut at the quoted history most clients add.
function newPart(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const out = [];
  for (const line of lines) {
    if (/^\s*On .+wrote:\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*From:\s.+/i.test(line) && out.length) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

const snippetOf = (text) =>
  newPart(text)
    .replace(/\[cid:[^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);

// Attachments people can open (inline images already sit in the HTML).
const listedAttachments = (parsed) =>
  (parsed.attachments || [])
    .map((a, index) => ({ a, index }))
    .filter(({ a }) => !a.related);

function summarize(parsed) {
  const refs = parsed.references;
  return {
    messageId: normId(parsed.messageId),
    subject: String(parsed.subject || "").slice(0, 300),
    from: addresses(parsed.from)[0] || null,
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    replyTo: addresses(parsed.replyTo),
    date: parsed.date || null,
    inReplyTo: parsed.inReplyTo ? normId(parsed.inReplyTo) : null,
    references: (Array.isArray(refs) ? refs : refs ? String(refs).split(/\s+/) : []).map(normId).filter(Boolean),
    snippet: snippetOf(parsed.text),
    attachmentCount: listedAttachments(parsed).length,
  };
}

// ── writing: a copy of a sent reply in the Sent folder ────────────────
async function appendToSent(raw) {
  const list = await folders();
  const sent =
    list.find((f) => f.specialUse === "\\Sent") ||
    list.find((f) => /^sent$/i.test(String(f.name)));
  if (!sent) throw new Error("No Sent folder in the mailbox");
  const c = await getClient();
  const r = await c.append(sent.path, raw, ["\\Seen"]);
  return { folder: sent.path, uid: r && r.uid ? Number(r.uid) : null };
}

module.exports = {
  locate,
  resolveFolder,
  fetchParsed,
  appendToSent,
  summarize,
  newPart,
  addresses,
  listedAttachments,
  mailboxAddress,
  normId,
  followUpFolderName,
};

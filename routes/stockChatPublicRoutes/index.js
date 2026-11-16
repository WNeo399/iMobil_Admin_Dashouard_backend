// Customer stock chat — the public side (2026-11-16).
//
// A customer on our enable list opens the link staff sent them on WhatsApp
// (/stock/<token> on the dashboard) and asks about our refurbished stock.
// The token is the whole credential: random, tied to one phone number,
// dead the moment staff disable that number or issue a new link.
//
//   GET  /stock-chat/:token        who the link is for + today's usage
//   POST /stock-chat/:token/ask    { messages: [{ role, text }] } → answer
//
// The AI never touches the database. It gets three fixed tools over the
// customer-safe stock view in utils/stockChat.js (model / storage / grade /
// colour / quantity / listed price — nothing else), and the rows shown to
// the customer are re-read from that view by the server, so a quantity or
// price can't be made up.

var express = require("express");
var router = express.Router();
var rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");
const { connectToDatabase } = require("../../utils/mongodb");
const SC = require("../../utils/stockChat");

const MODEL = process.env.STOCK_CHAT_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_ITERS = 6; // tool rounds per question
const MAX_TOKENS = 1500;
const MAX_QUESTION = 500; // characters
const MAX_HISTORY = 10; // earlier messages resent with each question
const ROWS_TO_MODEL = 80;
const ROWS_TO_CLIENT = 60; // cards
const ROWS_IN_LIST = 400; // a broad list (the whole stock is ~150 Model + Storage + Grade rows)
const TOKEN_RE = /^[A-Za-z0-9_-]{20,40}$/;

// Per link, not per IP: behind Railway's proxy every caller shares one IP.
const tokenKey = (req) => String(req.params.token || "");
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: tokenKey,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { success: false, message: "Too many requests — please wait a minute." },
});
const askLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  keyGenerator: tokenKey,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { success: false, message: "Too many questions at once — please wait a minute." },
});

const busy = new Set(); // one question at a time per link

async function customerFor(db, token) {
  if (!TOKEN_RE.test(String(token || ""))) return null;
  return db.collection(SC.CUSTOMERS).findOne({ token: String(token), enabled: true });
}

async function usedToday(db, customerId) {
  return db.collection(SC.LOG).countDocuments({ customerId, day: SC.melbourneDay() });
}

const NOT_ACTIVE = "This link isn't active. Please message us on WhatsApp for a new one.";

// ── GET /stock-chat/:token ──────────────────────────────────────────
router.get("/:token", readLimiter, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const c = await customerFor(db, req.params.token);
    if (!c) return res.status(404).json({ success: false, message: NOT_ACTIVE });
    const settings = await SC.getSettings(db);
    return res.json({
      success: true,
      name: c.name || "",
      priceNote: settings.priceNote || "",
      used: await usedToday(db, c._id),
      limit: settings.dailyLimit,
    });
  } catch (e) {
    console.error("Stock chat session error:", e);
    return res.status(500).json({ success: false, message: "Something went wrong — please try again." });
  }
});

// ── the AI's tools ───────────────────────────────────────────────────
const TOOLS = [
  {
    name: "list_models",
    description:
      "Every model currently in stock with its total quantity and the storages and grades available. " +
      "Use it for broad questions ('what iPads do you have?') and to find a model's exact name before search_stock.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional words the brand or model name must contain, e.g. 'ipad', 'samsung', 'iphone 13'." },
      },
    },
  },
  {
    name: "search_stock",
    description:
      "In-stock devices matching the filters: one row per Model + Storage + Grade + Colour with the quantity and the listed price " +
      "('Contact us' when there is no listed price).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words the brand or model name must ALL contain, e.g. 'iphone 14 pro', 'ipad 9th gen cellular'." },
        storage: { type: "string", description: "Optional exact storage, e.g. '128GB'." },
        grade: { type: "string", description: "Optional exact grade as listed, e.g. 'A++', 'A+', 'A', 'B', or 'Ungraded'." },
        color: { type: "string", description: "Optional colour words, e.g. 'black'." },
      },
    },
  },
  {
    name: "reply",
    description:
      "Send your answer to the customer — always finish with this. The page shows `text`, then the stock rows with " +
      "quantities and prices filled in live by the system: picked one by one in `show`, or every row matching `show_matching`.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "A short answer in the customer's language. Don't repeat every row — the page shows them.",
        },
        layout: {
          type: "string",
          enum: ["cards", "list"],
          description:
            "cards: a few rows about one or two specific models (shows colours). " +
            "list: a compact list grouped by model, for broad questions — all stock, a brand, a category like iPads, or many models.",
        },
        show_matching: {
          type: "object",
          description:
            "For broad questions: list EVERY in-stock row matching these filters (same filters as search_stock; {} = all stock). " +
            "Use with layout 'list' instead of naming rows one by one.",
          properties: {
            query: { type: "string" },
            storage: { type: "string" },
            grade: { type: "string" },
            color: { type: "string" },
          },
        },
        show: {
          type: "array",
          description: "Specific stock rows to show (exact model / storage / grade from the tool results). Empty when nothing matches.",
          items: {
            type: "object",
            properties: {
              model: { type: "string" },
              storage: { type: "string", description: "Leave empty to show every storage of the model." },
              grade: { type: "string", description: "Leave empty to show every grade." },
              color: { type: "string", description: "Leave empty to combine all colours in one row." },
            },
            required: ["model"],
          },
        },
      },
      required: ["text"],
    },
  },
];

function systemPrompt(settings) {
  return [
    "You are the stock assistant for iMobile, an Australian wholesaler of refurbished phones, tablets and accessories. " +
      "Wholesale customers use you to check what iMobile has in stock right now and the listed prices.",
    "",
    "How to answer:",
    "- Use the tools for every stock question. Every model, quantity and price you mention must come from a tool result in this turn — never guess, estimate or remember.",
    "- Model names in stock can be written loosely (e.g. 'IPAD 9' and 'iPad 9th Gen WiFi', or 'PRO1 耳机' for AirPods Pro). If a search finds nothing, try list_models and shorter words before saying it's not in stock.",
    "- Storage goes in the storage filter, not in the query words.",
    "- A row without a listed price shows 'Contact us' — tell the customer to message iMobile on WhatsApp for that price. Never quote a price that isn't listed.",
    `- Listed prices: ${settings.priceNote || "as shown"}.`,
    "- Grades are as listed (e.g. A++, A+, A, B). 'Ungraded' means the unit hasn't been graded yet. Don't explain what a grade means beyond that — suggest asking iMobile.",
    "- You can't take orders, hold stock, give discounts or promise delivery. To buy or reserve, the customer messages iMobile on WhatsApp.",
    "- Only talk about iMobile's current stock and prices. Politely decline anything else in one sentence.",
    "- You only know model, storage, grade, colour, quantity and listed price. You have no costs, suppliers, IMEIs or warehouse details — say so if asked.",
    "- Reply in the customer's language. Keep it short and friendly.",
    "- Always finish by calling reply: a short text plus the stock to show — never write the stock out in the text.",
    "  · One or two specific models: layout 'cards' with the rows in `show`.",
    "  · Broad questions (everything in stock, a brand, all iPads / iPhones, many models): layout 'list' with `show_matching` " +
      "(e.g. {} for all stock, {query: 'ipad'} for iPads) — the page lists every matching row grouped by model.",
  ].join("\n");
}

const words = (q) => SC.clean(q).toLowerCase().split(/[\s,/]+/).filter(Boolean);
const STORAGE_WORD = /^\d+(gb|tb)$/i;

function matchesWords(g, ws) {
  if (!ws.length) return true;
  const hay = `${g.brand} ${g.model}`.toLowerCase();
  const compact = hay.replace(/[^a-z0-9]/g, "");
  return ws.every((w) => {
    if (hay.includes(w)) return true;
    const wc = w.replace(/[^a-z0-9]/g, "");
    return !!wc && compact.includes(wc);
  });
}

const gradeLabel = (g) => g || "Ungraded";
const gradeInputKey = (v) => {
  const k = SC.gradeKey(v);
  return k === "UNGRADED" || k === "NONE" || k === "-" ? "" : k;
};
const priceText = (g) => (g.price != null ? `${g.currency || "AUD"} ${Number(g.price).toFixed(2)}` : "Contact us");

function toolListModels(groups, input) {
  const ws = words(input && input.query);
  const by = new Map();
  for (const g of groups) {
    if (!matchesWords(g, ws)) continue;
    const k = SC.modelKey(g.model);
    let m = by.get(k);
    if (!m) { m = { brand: g.brand, model: g.model, qty: 0, storages: new Set(), grades: new Set() }; by.set(k, m); }
    m.qty += g.qty;
    if (g.storage) m.storages.add(g.storage);
    m.grades.add(gradeLabel(g.grade));
  }
  const models = [...by.values()].map((m) => ({
    brand: m.brand, model: m.model, qty: m.qty, storages: [...m.storages], grades: [...m.grades],
  }));
  return { models, count: models.length };
}

// The search_stock filters (also reply's show_matching): every word in the
// brand + model, exact storage / grade, colour words.
function filterGroups(groups, input) {
  const i = input || {};
  let ws = words(i.query);
  let storage = i.storage ? SC.storageKey(i.storage) : "";
  // "iphone 13 128gb" — a storage word in the query is a storage filter
  const st = ws.find((w) => STORAGE_WORD.test(w));
  if (st && !storage) storage = SC.storageKey(st);
  ws = ws.filter((w) => !STORAGE_WORD.test(w));
  const grade = i.grade != null && String(i.grade).trim() !== "" ? gradeInputKey(i.grade) : null;
  const color = i.color ? SC.colorKey(i.color) : "";
  const hits = groups.filter(
    (g) =>
      matchesWords(g, ws) &&
      (!storage || SC.storageKey(g.storage) === storage) &&
      (grade === null || SC.gradeKey(g.grade) === grade) &&
      (!color || SC.colorKey(g.color).includes(color)),
  );
  return { hits, ws };
}

function toolSearch(groups, input) {
  const { hits, ws } = filterGroups(groups, input);
  const rows = hits.slice(0, ROWS_TO_MODEL).map((g) => ({
    model: g.model, storage: g.storage, grade: gradeLabel(g.grade), color: g.color, qty: g.qty, price: priceText(g),
  }));
  const out = { rows, matchingRows: hits.length, units: hits.reduce((s, g) => s + g.qty, 0) };
  if (hits.length > ROWS_TO_MODEL) out.note = `Showing the first ${ROWS_TO_MODEL} of ${hits.length} rows — narrow the search for the rest.`;
  if (!hits.length && ws.length) {
    // Nothing: offer the models sharing any word, to try again with.
    out.similarModels = toolListModels(groups, {}).models
      .filter((m) => ws.some((w) => `${m.brand} ${m.model}`.toLowerCase().includes(w)))
      .slice(0, 20)
      .map((m) => m.model);
  }
  return out;
}

// Best grade first; ungraded last.
const GRADE_RANK = { "A++": 0, "A+": 1, A: 2, "B+": 3, B: 4, "C+": 5, C: 6 };
const gradeRank = (g) => (g === "Ungraded" ? 99 : GRADE_RANK[SC.gradeKey(g)] !== undefined ? GRADE_RANK[SC.gradeKey(g)] : 50);
const storageGb = (s) => {
  const m = String(s || "").match(/([\d.]+)\s*(TB|GB)/i);
  return m ? Number(m[1]) * (/tb/i.test(m[2]) ? 1024 : 1) : 0;
};
// A broad list reads by category: phones, tablets, then the rest.
const CATEGORY = [/^(apple\s+)?iphone|^se\s*\d/i, /ipad/i, /galaxy|samsung|^sm-/i, /pixel/i, /macbook/i, /watch/i, /airpods|pencil|耳机/i];
const categoryRank = (m) => {
  const i = CATEGORY.findIndex((re) => re.test(m));
  return i < 0 ? CATEGORY.length : i;
};
function sortRows(rows) {
  return rows.sort(
    (a, b) =>
      categoryRank(a.model) - categoryRank(b.model) ||
      a.model.localeCompare(b.model, "en", { numeric: true, sensitivity: "base" }) ||
      storageGb(a.storage) - storageGb(b.storage) ||
      gradeRank(a.grade) - gradeRank(b.grade),
  );
}

// The price is part of a row's identity: units of one Model + Storage +
// Grade can be split into priced ones and "Contact us" (below cost) ones,
// and those must never merge.
const priceKey = (g) => (g.price == null ? "-" : `${g.currency || ""}${g.price}`);
const rowKey = (r) => [SC.modelKey(r.model), SC.storageKey(r.storage), SC.gradeKey(r.grade === "Ungraded" ? "" : r.grade), priceKey(r)].join("|");

// Every matching row, colours combined: one per Model + Storage + Grade (+ price).
function combineByGrade(hits) {
  const by = new Map();
  for (const g of hits) {
    const k = [SC.modelKey(g.model), SC.storageKey(g.storage), SC.gradeKey(g.grade), priceKey(g)].join("|");
    let r = by.get(k);
    if (!r) {
      r = { model: g.model, storage: g.storage, grade: gradeLabel(g.grade), colors: [], qty: 0, price: g.price, currency: g.currency };
      by.set(k, r);
    }
    r.qty += g.qty;
    if (g.color && !r.colors.includes(g.color)) r.colors.push(g.color);
  }
  return [...by.values()];
}

// What the page shows for a reply — always read back from the stock view,
// never taken from the model: cards for a few picked rows, a list for broad
// questions (show_matching = every matching row).
function buildReply(groups, input) {
  const i = input || {};
  const hasMatching = i.show_matching && typeof i.show_matching === "object";
  const layout = i.layout === "list" || i.layout === "cards" ? i.layout : hasMatching ? "list" : "cards";
  let rows = resolveShow(groups, i.show, layout === "list" ? ROWS_IN_LIST : ROWS_TO_CLIENT);
  if (hasMatching) {
    const have = new Set(rows.map(rowKey));
    const more = combineByGrade(filterGroups(groups, i.show_matching).hits).filter((r) => !have.has(rowKey(r)));
    rows = sortRows(rows.concat(more));
  }
  const cap = layout === "list" ? ROWS_IN_LIST : ROWS_TO_CLIENT;
  return { rows: rows.slice(0, cap), layout, more: Math.max(rows.length - cap, 0) };
}

// The reply's picked rows, read back from the stock view (never from the
// model): colours combine into one row unless a colour was asked for.
function resolveShow(groups, show, cap = ROWS_TO_CLIENT) {
  const rows = [];
  const seen = new Set();
  for (const s of (Array.isArray(show) ? show : []).slice(0, cap)) {
    if (!s || !s.model) continue;
    const m = SC.modelKey(s.model);
    const st = s.storage ? SC.storageKey(s.storage) : null;
    const gr = s.grade != null && String(s.grade).trim() !== "" ? gradeInputKey(s.grade) : null;
    const c = s.color ? SC.colorKey(s.color) : null;
    const by = new Map();
    for (const g of groups) {
      if (SC.modelKey(g.model) !== m) continue;
      if (st !== null && SC.storageKey(g.storage) !== st) continue;
      if (gr !== null && SC.gradeKey(g.grade) !== gr) continue;
      if (c !== null && SC.colorKey(g.color) !== c) continue;
      const k = [m, SC.storageKey(g.storage), SC.gradeKey(g.grade), priceKey(g), c === null ? "" : SC.colorKey(g.color)].join("|");
      if (seen.has(k)) continue;
      let r = by.get(k);
      if (!r) {
        r = { model: g.model, storage: g.storage, grade: gradeLabel(g.grade), colors: [], qty: 0, price: g.price, currency: g.currency };
        by.set(k, r);
      }
      r.qty += g.qty;
      if (g.color && !r.colors.includes(g.color)) r.colors.push(g.color);
    }
    // a picked model's storages / grades in a sensible order
    for (const [k, r] of [...by.entries()].sort((a, b) => storageGb(a[1].storage) - storageGb(b[1].storage) || gradeRank(a[1].grade) - gradeRank(b[1].grade))) {
      seen.add(k);
      rows.push(r);
    }
  }
  return rows.slice(0, cap);
}

// Earlier turns as plain text (the client keeps them), alternating and
// starting with the customer, ending with the new question.
function buildMessages(raw) {
  const list = (Array.isArray(raw) ? raw : [])
    .map((m) => ({
      role: m && m.role === "assistant" ? "assistant" : "user",
      text: SC.clean(m && m.text).slice(0, m && m.role === "assistant" ? 2000 : MAX_QUESTION),
    }))
    .filter((m) => m.text)
    .slice(-(MAX_HISTORY + 1));
  const out = [];
  for (const m of list) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.text;
    else out.push({ role: m.role, content: m.text });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

// ── POST /stock-chat/:token/ask ─────────────────────────────────────
router.post("/:token/ask", askLimiter, async (req, res) => {
  const token = String(req.params.token || "");
  const started = Date.now();
  let db;
  let customer;
  let question = "";
  const log = { tools: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  try {
    db = await connectToDatabase();
    customer = await customerFor(db, token);
    if (!customer) return res.status(404).json({ success: false, message: NOT_ACTIVE });

    const messages = buildMessages(req.body && req.body.messages);
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user") {
      return res.status(400).json({ success: false, message: "Type a question first." });
    }
    question = String(last.content).slice(0, MAX_QUESTION);
    if (String(last.content).length > MAX_QUESTION + 200) {
      return res.status(400).json({ success: false, message: `Please keep questions under ${MAX_QUESTION} characters.` });
    }

    const settings = await SC.getSettings(db);
    const used = await usedToday(db, customer._id);
    if (settings.dailyLimit > 0 && used >= settings.dailyLimit) {
      return res.status(429).json({
        success: false,
        message: "You've reached today's question limit. Please message us on WhatsApp, or try again tomorrow.",
        used,
        limit: settings.dailyLimit,
      });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ success: false, message: "The stock assistant isn't available right now." });
    }
    if (busy.has(token)) {
      return res.status(429).json({ success: false, message: "Still answering your last question…" });
    }
    busy.add(token);

    try {
      const stock = await SC.pricedStock();
      const groups = stock.groups;
      const client = new Anthropic();
      let answer = "";
      let rows = [];
      let layout = "cards";
      let done = false;

      for (let i = 0; i < MAX_ITERS && !done; i++) {
        // On the last round only `reply` is offered, so the answer always lands.
        const lastRound = i === MAX_ITERS - 1;
        const resp = await client.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: [{ type: "text", text: systemPrompt(settings), cache_control: { type: "ephemeral" } }],
          tools: TOOLS,
          tool_choice: lastRound ? { type: "tool", name: "reply" } : { type: "any" },
          messages,
        });
        const u = resp.usage || {};
        log.usage.input += u.input_tokens || 0;
        log.usage.output += u.output_tokens || 0;
        log.usage.cacheRead += u.cache_read_input_tokens || 0;
        log.usage.cacheWrite += u.cache_creation_input_tokens || 0;
        messages.push({ role: "assistant", content: resp.content });

        const calls = resp.content.filter((b) => b.type === "tool_use");
        if (!calls.length) {
          answer = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
          break;
        }
        const results = [];
        for (const call of calls) {
          log.tools.push({ name: call.name, input: call.input });
          if (call.name === "reply") {
            answer = SC.clean(call.input && call.input.text) ? String(call.input.text).trim() : "";
            const built = buildReply(groups, call.input);
            rows = built.rows;
            layout = built.layout;
            done = true;
            results.push({ type: "tool_result", tool_use_id: call.id, content: "Sent." });
          } else {
            let out;
            if (call.name === "list_models") out = toolListModels(groups, call.input);
            else if (call.name === "search_stock") out = toolSearch(groups, call.input);
            else out = { error: `Unknown tool ${call.name}` };
            results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(out) });
          }
        }
        if (!done) messages.push({ role: "user", content: results });
      }

      if (!answer && !rows.length) answer = "Sorry, I couldn't work that out — please try asking another way.";
      log.answer = answer;
      log.rows = rows.length;
      const nowUsed = used + 1;
      await db.collection(SC.LOG).insertOne({
        customerId: customer._id,
        phone: customer.phone,
        name: customer.name || "",
        day: SC.melbourneDay(),
        at: new Date(),
        question,
        answer,
        rows: rows.length,
        layout,
        tools: log.tools,
        usage: log.usage,
        model: MODEL,
        ms: Date.now() - started,
      });
      await db.collection(SC.CUSTOMERS).updateOne({ _id: customer._id }, { $set: { lastUsedAt: new Date() } });
      return res.json({
        success: true,
        answer,
        rows,
        layout,
        priceNote: settings.priceNote || "",
        used: nowUsed,
        limit: settings.dailyLimit,
      });
    } finally {
      busy.delete(token);
    }
  } catch (e) {
    console.error("Stock chat ask error:", e);
    let message = "Something went wrong — please try again.";
    if (e && (e.status === 429 || e.status === 529)) message = "The assistant is busy — please try again in a minute.";
    // A failed question is logged (for staff) but not counted against the day.
    if (db && customer) {
      db.collection(SC.LOG).insertOne({
        customerId: customer._id, phone: customer.phone, name: customer.name || "", day: null, failedDay: SC.melbourneDay(),
        at: new Date(), question, error: (e && e.message) || String(e), tools: log.tools, usage: log.usage, model: MODEL,
        ms: Date.now() - started,
      }).catch(() => {});
    }
    return res.status(500).json({ success: false, message });
  }
});

module.exports = router;
// exposed for the offline tests
module.exports._internals = { toolSearch, toolListModels, resolveShow, buildReply, buildMessages, matchesWords, TOOLS, systemPrompt };

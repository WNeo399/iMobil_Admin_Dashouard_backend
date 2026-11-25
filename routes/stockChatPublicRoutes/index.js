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
// Ordering from the page (2026-11-25) — the same chat orders as the
// WhatsApp API below (utils/stockChatOrders.js), channel "web":
//
//   POST /stock-chat/:token/orders                   { items, note?, clientRef, dryRun? } → { order }
//   GET  /stock-chat/:token/orders                   the customer's orders, newest first
//   POST /stock-chat/:token/orders/:orderNo/cancel   { reason? } (pending only)
//
// Server API (2026-11-18) for our WhatsApp helper, which answers customers
// inside WhatsApp. Authenticated by the X-API-Key header (env
// STOCK_CHAT_API_KEY, comma-separated to allow a rotation overlap); the
// customer is the phone number WhatsApp gives that server.
//
//   POST /stock-chat/customer      { phone } → { enabled, name }
//   POST /stock-chat/ask           { phone, channel: "whatsapp", messages } → answer
//
// Chat orders (2026-11-25, utils/stockChatOrders.js) — separate from the
// normal sales orders; by Model + Storage + Grade (+ Colour) and quantity:
//
//   POST /stock-chat/orders         { phone, items, note?, clientRef, dryRun? } → { order }
//   POST /stock-chat/orders/list    { phone, status?, limit? } → { orders }
//   POST /stock-chat/orders/status  { phone, orderNo } → { order }
//   POST /stock-chat/orders/cancel  { phone, orderNo, reason? } → { order } (pending only)
//
// Refusals carry a `code` (BAD_API_KEY, NOT_A_CUSTOMER, DISABLED, ...); only
// that server calls these, never the dashboard's axios client.
//
// The AI never touches the database. It gets three fixed tools over the
// customer-safe stock view in utils/stockChat.js (model / storage / grade /
// colour / quantity / listed price — nothing else), and the rows shown to
// the customer are re-read from that view by the server, so a quantity or
// price can't be made up.

var express = require("express");
var router = express.Router();
var rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { connectToDatabase } = require("../../utils/mongodb");
const SC = require("../../utils/stockChat");
const CO = require("../../utils/stockChatOrders");

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

const webOrderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: tokenKey,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { success: false, code: "TOO_MANY_REQUESTS", message: "Too many order requests — please wait a minute." },
});

const busy = new Set(); // one question at a time per customer (web and WhatsApp share it)

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
      // how long an order from the page holds its stock (2026-11-25)
      orderHoldHours: settings.orderHoldHours,
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
        // What the customer wants + the products they mean (2026-11-25, for
        // the WhatsApp helper's buttons); the server adds availability.
        intent: {
          type: "string",
          enum: ["greeting", "stock_query", "full_list", "order_intent", "price_negotiation", "order_status", "human", "other"],
          description:
            "What the customer mainly wants with THIS message — one value. greeting: hello / small talk, no request. " +
            "stock_query: stock, price, colour or grade of something. full_list: everything in stock or a whole category. " +
            "order_intent: clearly wants to buy, order or reserve ('5 of the A++ please', 'I'll take it', 'hold 3 for me'). " +
            "price_negotiation: a discount, a better or bulk price. order_status: an existing order, dispatch, delivery. " +
            "human: wants a person, a complaint, after-sales. other: none of these. " +
            "Several at once → the main one ('any iPhone 15? if so 5 of them' = order_intent).",
        },
        items: {
          type: "array",
          description:
            "The products this message is about, COMPLETED FROM THE CONVERSATION: if they asked about iPhone 15 128GB and now say " +
            "'the A++ ones, 5 please', give model iPhone 15, storage 128GB, grade A++, qty 5. Give what the CUSTOMER asked for, " +
            "even when we don't have it (they ask for 256GB and we only have 128GB → storage 256GB; the system works out " +
            "availability). Spell model, storage, grade and colour as in the tool results when they are there. Leave out what the " +
            "customer didn't say or you can't tell; leave model out rather than guess one. [] when no specific product " +
            "(greetings, order status, a whole category).",
          items: {
            type: "object",
            properties: {
              model: { type: "string" },
              storage: { type: "string" },
              grade: { type: "string", description: "A++, A+, A, B+, B, C+, C or Ungraded." },
              color: { type: "string" },
              qty: { type: "integer", description: "How many they want, only when they said a number." },
            },
          },
        },
      },
      required: ["text", "intent"],
    },
  },
];

// Where the customer reaches our team: the web page sends them to WhatsApp;
// on WhatsApp they're already talking to us.
function contactLine(channel) {
  return channel === "whatsapp" ? "ask our team here in this WhatsApp chat" : "message iMobile on WhatsApp";
}

function systemPrompt(settings, channel = "web") {
  const contact = contactLine(channel);
  return [
    "You are the stock assistant for iMobile, an Australian wholesaler of refurbished phones, tablets and accessories. " +
      "Wholesale customers use you to check what iMobile has in stock right now and the listed prices.",
    "",
    "How to answer:",
    "- Use the tools for every stock question. Every model, quantity and price you mention must come from a tool result in this turn — never guess, estimate or remember.",
    "- Model names in stock can be written loosely (e.g. 'IPAD 9' and 'iPad 9th Gen WiFi', or 'PRO1 耳机' for AirPods Pro). If a search finds nothing, try list_models and shorter words before saying it's not in stock.",
    "- Storage goes in the storage filter, not in the query words.",
    channel === "web"
      ? "- A row without a listed price shows 'Contact us' — the customer can still add it to an order and our team will quote the price, or message iMobile on WhatsApp. Never quote a price that isn't listed."
      : `- A row without a listed price shows 'Contact us' — tell the customer to ${contact} for that price. Never quote a price that isn't listed.`,
    `- Listed prices: ${settings.priceNote || "as shown"}.`,
    "- Grades are as listed (e.g. A++, A+, A, B). 'Ungraded' means the unit hasn't been graded yet. Don't explain what a grade means beyond that — suggest asking iMobile.",
    channel === "web"
      ? "- You can't place orders yourself, hold stock, give discounts or promise delivery. To order, the customer taps 'Add' on the stock you show, then 'Place order' in the order bar at the bottom of the page; " +
        "our team confirms it and arranges delivery and payment. When someone wants to buy, show the rows they want (cards) so they can add them."
      : `- You can't take orders, hold stock, give discounts or promise delivery. To buy or reserve, the customer should ${contact}.`,
    "- Only talk about iMobile's current stock and prices. Politely decline anything else in one sentence.",
    "- You only know model, storage, grade, colour, quantity and listed price. You have no costs, suppliers, IMEIs or warehouse details — say so if asked.",
    "- Reply in the customer's language. Keep it short and friendly.",
    "- Always finish by calling reply: a short text plus the stock to show — never write the stock out in the text.",
    "  · Always set intent (what the customer mainly wants with this message) and items (the products they mean, completed from earlier messages).",
    "  · One or two specific models: layout 'cards' with the rows in `show`.",
    "  · Broad questions (everything in stock, a brand, all iPads / iPhones, many models): layout 'list' with `show_matching` " +
      "(e.g. {} for all stock, {query: 'ipad'} for iPads) — the page lists every matching row grouped by model.",
    ...(channel === "whatsapp"
      ? [
          "- This customer is on WhatsApp: the rows are listed under your text as a WhatsApp message. Write plain text — no markdown, " +
            "headings or tables — and don't say 'cards', 'below on the page' or 'click'.",
        ]
      : []),
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

// The reply's intent + items (2026-11-25, asked for by the WhatsApp helper
// to pick its buttons): the AI names what the customer wants and the
// products they mean; the server writes those in our stock's own spelling
// and decides availability from the same stock view as the rows —
//   available "yes" (enough, or in stock when no qty), "partial" (some, not
//   qty), "no" (none / not a model we have), null (no model to check);
//   availableQty = the units that fit.
const INTENTS = ["greeting", "stock_query", "full_list", "order_intent", "price_negotiation", "order_status", "human", "other"];
const MAX_INTENT_ITEMS = 10;

function intentItems(groups, input) {
  const i = input || {};
  const intent = INTENTS.includes(i.intent) ? i.intent : null;
  const opt = (v, n) => (v == null || SC.clean(v) === "" ? null : SC.clean(v).slice(0, n));
  const items = (Array.isArray(i.items) ? i.items : []).slice(0, MAX_INTENT_ITEMS).map((x) => {
    const it = x && typeof x === "object" ? x : {};
    let model = opt(it.model, 120);
    let storage = opt(it.storage, 40);
    let grade = opt(it.grade, 20);
    let color = opt(it.color, 60);
    const q = Number(it.qty);
    const qty = it.qty == null || it.qty === "" || !Number.isInteger(q) || q < 1 ? null : q;
    if (grade !== null) grade = gradeInputKey(grade) || "Ungraded";
    if (!model) return { model: null, storage, grade, color, qty, available: null, availableQty: null };

    let c = groups.filter((g) => SC.modelKey(g.model) === SC.modelKey(model));
    if (c.length) model = c[0].model;
    if (storage !== null) {
      c = c.filter((g) => SC.storageKey(g.storage) === SC.storageKey(storage));
      if (c.length) storage = c[0].storage;
    }
    if (grade !== null) c = c.filter((g) => SC.gradeKey(g.grade) === gradeInputKey(grade));
    if (color !== null) {
      // the stock's own colour name: exact first, then a part of it ("black" → "Black Titanium")
      const want = SC.colorKey(color);
      let cc = c.filter((g) => SC.colorKey(g.color) === want);
      if (!cc.length) cc = c.filter((g) => SC.colorKey(g.color).includes(want));
      const names = [...new Set(cc.map((g) => g.color))];
      if (names.length === 1) color = names[0];
      c = cc;
    }
    const availableQty = c.reduce((s, g) => s + g.qty, 0);
    const available = availableQty === 0 ? "no" : qty === null || qty <= availableQty ? "yes" : "partial";
    return { model, storage, grade, color, qty, available, availableQty };
  });
  return { intent, items };
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

// A refusal with an HTTP status, a machine-readable code (server API only)
// and a message the customer can read.
class AskError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

const AI_BUSY = "The assistant is busy — please try again in a minute.";
const AI_FAILED = "Something went wrong — please try again.";

// Answers one question for one customer — shared by the web page (link
// token) and the server API (phone number). Returns the reply body or
// throws an AskError. Every answered question is logged and counted for the
// day; a failed one is logged for staff but not counted.
async function answerQuestion(db, customer, rawMessages, channel) {
  const started = Date.now();
  // Checked on the raw text: buildMessages already cuts it to MAX_QUESTION.
  // A little over is trimmed; a long paste is refused.
  const raw = Array.isArray(rawMessages) ? rawMessages : [];
  const rawLast = raw[raw.length - 1];
  if (rawLast && rawLast.role !== "assistant" && SC.clean(rawLast.text).length > MAX_QUESTION + 200) {
    throw new AskError(400, "BAD_REQUEST", `Please keep questions under ${MAX_QUESTION} characters.`);
  }
  const messages = buildMessages(raw);
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") throw new AskError(400, "BAD_REQUEST", "Type a question first.");
  const question = String(last.content).slice(0, MAX_QUESTION);

  const settings = await SC.getSettings(db);
  const used = await usedToday(db, customer._id);
  if (settings.dailyLimit > 0 && used >= settings.dailyLimit) {
    throw new AskError(
      429,
      "LIMIT_REACHED",
      channel === "whatsapp"
        ? "You've reached today's question limit. Please try again tomorrow."
        : "You've reached today's question limit. Please message us on WhatsApp, or try again tomorrow.",
      { used, limit: settings.dailyLimit },
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AskError(503, "UNAVAILABLE", "The stock assistant isn't available right now.");
  }
  const lock = String(customer._id);
  if (busy.has(lock)) throw new AskError(429, "BUSY", "Still answering your last question…");
  busy.add(lock);

  const log = { tools: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const who = { customerId: customer._id, phone: customer.phone, name: customer.name || "", channel };
  try {
    const stock = await SC.pricedStock();
    const groups = stock.groups;
    const client = new Anthropic();
    let answer = "";
    let rows = [];
    let layout = "cards";
    let more = 0;
    let intent = null;
    let items = [];
    let done = false;

    for (let i = 0; i < MAX_ITERS && !done; i++) {
      // On the last round only `reply` is offered, so the answer always lands.
      const lastRound = i === MAX_ITERS - 1;
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: systemPrompt(settings, channel), cache_control: { type: "ephemeral" } }],
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
          more = built.more;
          ({ intent, items } = intentItems(groups, call.input));
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
    await db.collection(SC.LOG).insertOne({
      ...who,
      day: SC.melbourneDay(),
      at: new Date(),
      question,
      answer,
      rows: rows.length,
      layout,
      intent,
      items,
      tools: log.tools,
      usage: log.usage,
      model: MODEL,
      ms: Date.now() - started,
    });
    await db.collection(SC.CUSTOMERS).updateOne({ _id: customer._id }, { $set: { lastUsedAt: new Date() } });
    return {
      answer,
      rows,
      layout,
      more,
      // what the customer wants + the products they mean (null / [] when the AI gave none)
      intent,
      items,
      priceNote: settings.priceNote || "",
      used: used + 1,
      limit: settings.dailyLimit,
    };
  } catch (e) {
    console.error("Stock chat ask error:", e);
    db.collection(SC.LOG)
      .insertOne({
        ...who, day: null, failedDay: SC.melbourneDay(), at: new Date(), question,
        error: (e && e.message) || String(e), tools: log.tools, usage: log.usage, model: MODEL, ms: Date.now() - started,
      })
      .catch(() => {});
    if (e && (e.status === 429 || e.status === 529)) throw new AskError(503, "UNAVAILABLE", AI_BUSY);
    throw new AskError(500, "ERROR", AI_FAILED);
  } finally {
    busy.delete(lock);
  }
}

// ── POST /stock-chat/:token/ask ─────────────────────────────────────
// The web page's body has no `code` and keeps its old statuses (an AI
// overload stays a 500 there).
router.post("/:token/ask", askLimiter, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const customer = await customerFor(db, req.params.token);
    if (!customer) return res.status(404).json({ success: false, message: NOT_ACTIVE });
    const out = await answerQuestion(db, customer, req.body && req.body.messages, "web");
    return res.json({ success: true, ...out });
  } catch (e) {
    if (e instanceof AskError) {
      const status = e.code === "UNAVAILABLE" && e.message === AI_BUSY ? 500 : e.status;
      return res.status(status).json({ success: false, message: e.message, ...e.extra });
    }
    console.error("Stock chat ask error:", e);
    return res.status(500).json({ success: false, message: AI_FAILED });
  }
});

// ── server API (WhatsApp helper) ─────────────────────────────────────
const API_CHANNELS = ["whatsapp"];

function apiKeys() {
  return String(process.env.STOCK_CHAT_API_KEY || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length >= 16);
}

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest();

// Compares hashes so the check takes the same time whatever was sent.
function apiKeyMatches(given) {
  if (!given) return false;
  const g = sha256(given);
  let ok = false;
  for (const k of apiKeys()) if (crypto.timingSafeEqual(g, sha256(k))) ok = true;
  return ok;
}

function apiFail(res, status, code, message, extra) {
  return res.status(status).json({ success: false, code, message, ...(extra || {}) });
}

function requireApiKey(req, res, next) {
  if (!apiKeys().length) return apiFail(res, 503, "UNAVAILABLE", "The server API isn't set up yet.");
  if (!apiKeyMatches(req.get("X-API-Key"))) return apiFail(res, 401, "BAD_API_KEY", "Missing or wrong X-API-Key.");
  return next();
}

const phoneOf = (req) => SC.normalizePhone(req.body && req.body.phone);

const apiLimit = (max, keyGenerator, message) =>
  rateLimit({
    windowMs: 60 * 1000,
    max,
    keyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    message: { success: false, code: "TOO_MANY_REQUESTS", message },
  });
// After the key check, so callers without the key can't use up the budget.
const apiAllLimiter = apiLimit(300, () => "server-api", "Too many requests — please wait a minute.");
const apiAskLimiter = apiLimit(8, (req) => "phone:" + (phoneOf(req) || "-"), "Too many questions from this number — please wait a minute.");

// The customer's own web page (the link staff send), e.g. for "see the
// full list" under a long WhatsApp answer.
function pageLinkFor(customer) {
  const base = String(process.env.STOCK_CHAT_PAGE_URL || "https://imbadmin.up.railway.app").replace(/\/+$/, "");
  return customer.token ? `${base}/stock/${customer.token}` : null;
}

// ── POST /stock-chat/customer ────────────────────────────────────────
router.post("/customer", requireApiKey, apiAllLimiter, async (req, res) => {
  try {
    const phone = phoneOf(req);
    if (!phone) return apiFail(res, 400, "BAD_REQUEST", "phone is missing or not a valid number.");
    const db = await connectToDatabase();
    const c = await db.collection(SC.CUSTOMERS).findOne({ phone }, { projection: { name: 1, enabled: 1 } });
    if (!c) return apiFail(res, 404, "NOT_A_CUSTOMER", "This number isn't on the Stock Chat list.", { phone });
    return res.json({ success: true, phone, enabled: c.enabled === true, name: c.name || "" });
  } catch (e) {
    console.error("Stock chat customer lookup error:", e);
    return apiFail(res, 500, "ERROR", AI_FAILED);
  }
});

// ── POST /stock-chat/ask ─────────────────────────────────────────────
router.post("/ask", requireApiKey, apiAllLimiter, apiAskLimiter, async (req, res) => {
  try {
    const phone = phoneOf(req);
    if (!phone) return apiFail(res, 400, "BAD_REQUEST", "phone is missing or not a valid number.");
    const channel = req.body.channel == null || req.body.channel === "" ? "whatsapp" : String(req.body.channel);
    if (!API_CHANNELS.includes(channel)) return apiFail(res, 400, "BAD_REQUEST", `channel must be one of: ${API_CHANNELS.join(", ")}.`);
    const db = await connectToDatabase();
    const customer = await db.collection(SC.CUSTOMERS).findOne({ phone });
    if (!customer) return apiFail(res, 404, "NOT_A_CUSTOMER", "This number isn't on the Stock Chat list.", { phone });
    const who = { name: customer.name || "", enabled: customer.enabled === true };
    if (customer.enabled !== true) return apiFail(res, 403, "DISABLED", "This number is switched off for Stock Chat.", { customer: who });
    const out = await answerQuestion(db, customer, req.body.messages, channel);
    return res.json({ success: true, ...out, link: pageLinkFor(customer), customer: who });
  } catch (e) {
    if (e instanceof AskError) return apiFail(res, e.status, e.code, e.message, e.extra);
    console.error("Stock chat API ask error:", e);
    return apiFail(res, 500, "ERROR", AI_FAILED);
  }
});

// ── chat orders (2026-11-25) ─────────────────────────────────────────
const apiOrderLimiter = apiLimit(20, (req) => "order:" + (phoneOf(req) || "-"), "Too many order requests from this number — please wait a minute.");
const ORDER_FAILED = "Something went wrong with the order — please try again.";

// The caller's customer, or the refusal already sent (null). Placing an
// order needs the number switched on; reading / cancelling its own orders
// doesn't.
async function apiCustomer(db, req, res, mustBeEnabled) {
  const phone = phoneOf(req);
  if (!phone) { apiFail(res, 400, "BAD_REQUEST", "phone is missing or not a valid number."); return null; }
  const customer = await db.collection(SC.CUSTOMERS).findOne({ phone });
  if (!customer) { apiFail(res, 404, "NOT_A_CUSTOMER", "This number isn't on the Stock Chat list.", { phone }); return null; }
  if (mustBeEnabled && customer.enabled !== true) {
    apiFail(res, 403, "DISABLED", "This number is switched off for Stock Chat.", { customer: { name: customer.name || "", enabled: false } });
    return null;
  }
  return customer;
}

function orderFail(res, e, what) {
  if (e instanceof CO.OrderError) return apiFail(res, e.status, e.code, e.message, e.extra);
  console.error(`Stock chat order ${what} error:`, e);
  return apiFail(res, 500, "ERROR", ORDER_FAILED);
}

// ── POST /stock-chat/orders ──────────────────────────────────────────
router.post("/orders", requireApiKey, apiAllLimiter, apiOrderLimiter, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const customer = await apiCustomer(db, req, res, true);
    if (!customer) return;
    const channel = req.body.channel == null || req.body.channel === "" ? "whatsapp" : String(req.body.channel);
    if (!API_CHANNELS.includes(channel)) return apiFail(res, 400, "BAD_REQUEST", `channel must be one of: ${API_CHANNELS.join(", ")}.`);
    const out = await CO.placeOrder(db, customer, req.body, { channel });
    const body = { success: true, order: CO.publicOrder(out.order) };
    if (out.dryRun) body.dryRun = true;
    if (out.duplicate) body.duplicate = true;
    return res.json(body);
  } catch (e) {
    return orderFail(res, e, "place");
  }
});

// ── POST /stock-chat/orders/list ─────────────────────────────────────
router.post("/orders/list", requireApiKey, apiAllLimiter, apiOrderLimiter, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const customer = await apiCustomer(db, req, res, false);
    if (!customer) return;
    const status = req.body.status == null || req.body.status === "" ? null : String(req.body.status);
    const orders = await CO.customerOrders(db, customer.phone, { status, limit: req.body.limit });
    return res.json({ success: true, orders: orders.map(CO.publicOrder) });
  } catch (e) {
    return orderFail(res, e, "list");
  }
});

// ── POST /stock-chat/orders/status ───────────────────────────────────
router.post("/orders/status", requireApiKey, apiAllLimiter, apiOrderLimiter, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const customer = await apiCustomer(db, req, res, false);
    if (!customer) return;
    const o = await CO.customerOrder(db, customer.phone, req.body.orderNo);
    return res.json({ success: true, order: CO.publicOrder(o) });
  } catch (e) {
    return orderFail(res, e, "status");
  }
});

// ── POST /stock-chat/orders/cancel ───────────────────────────────────
router.post("/orders/cancel", requireApiKey, apiAllLimiter, apiOrderLimiter, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const customer = await apiCustomer(db, req, res, false);
    if (!customer) return;
    const out = await CO.customerCancel(db, customer.phone, req.body.orderNo, req.body.reason);
    const body = { success: true, order: CO.publicOrder(out.order) };
    if (out.already) body.already = true;
    return res.json(body);
  } catch (e) {
    return orderFail(res, e, "cancel");
  }
});

// ── ordering from the customer's page (2026-11-25) ───────────────────
// The link is the credential, as for asking; a switched-off number's link
// is dead, so these answer 404 too. Refusals carry `code` (the page reads
// it with plain fetch, never the dashboard's axios client).
function webOrderFail(res, e, what) {
  if (e instanceof CO.OrderError) return res.status(e.status).json({ success: false, code: e.code, message: e.message, ...e.extra });
  console.error(`Stock chat web order ${what} error:`, e);
  return res.status(500).json({ success: false, code: "ERROR", message: ORDER_FAILED });
}

router.post("/:token/orders", webOrderLimiter, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const customer = await customerFor(db, req.params.token);
    if (!customer) return res.status(404).json({ success: false, code: "NOT_ACTIVE", message: NOT_ACTIVE });
    const out = await CO.placeOrder(db, customer, req.body, { channel: "web" });
    const body = { success: true, order: CO.publicOrder(out.order) };
    if (out.dryRun) body.dryRun = true;
    if (out.duplicate) body.duplicate = true;
    return res.json(body);
  } catch (e) {
    return webOrderFail(res, e, "place");
  }
});

router.get("/:token/orders", readLimiter, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const customer = await customerFor(db, req.params.token);
    if (!customer) return res.status(404).json({ success: false, code: "NOT_ACTIVE", message: NOT_ACTIVE });
    const orders = await CO.customerOrders(db, customer.phone, { limit: 20 });
    return res.json({ success: true, orders: orders.map(CO.publicOrder) });
  } catch (e) {
    return webOrderFail(res, e, "list");
  }
});

router.post("/:token/orders/:orderNo/cancel", webOrderLimiter, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const customer = await customerFor(db, req.params.token);
    if (!customer) return res.status(404).json({ success: false, code: "NOT_ACTIVE", message: NOT_ACTIVE });
    const out = await CO.customerCancel(db, customer.phone, req.params.orderNo, (req.body || {}).reason);
    return res.json({ success: true, order: CO.publicOrder(out.order), ...(out.already ? { already: true } : {}) });
  } catch (e) {
    return webOrderFail(res, e, "cancel");
  }
});

module.exports = router;
// exposed for the offline tests
module.exports._internals = {
  toolSearch, toolListModels, resolveShow, buildReply, buildMessages, matchesWords, TOOLS, systemPrompt, apiKeyMatches, intentItems,
};

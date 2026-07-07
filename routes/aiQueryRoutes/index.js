// "Ask the Data" — an agentic Claude chat that answers questions about the
// scraper marketplace data by running read-only SQL. Claude drives a tool-use
// loop with a single `run_sql` tool; we execute each query through the strict
// read-only safety layer (utils/aiSql) and feed the rows back until it answers.
//
//   POST /aiQuery/ask  { messages: [{ role, content }] }  → { answer, steps }
//
// Gated by ai:query:use. Model + key come from env; if the key is absent the
// endpoint returns a clear "not configured" response instead of erroring.

var express = require("express");
var router = express.Router();
const Anthropic = require("@anthropic-ai/sdk");
const { requirePermission } = require("../../middleware/auth");
const { runReadOnlySql } = require("../../utils/aiSql");

const VIEW = requirePermission("ai:query:use");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
const MAX_ITERS = 6; // max run_sql rounds per question
const MAX_TOKENS = 4096;
const ROWS_TO_MODEL = 50; // rows fed back to Claude per query (token budget)
const ROWS_TO_CLIENT = 200; // rows kept per step for the UI table

// Attachment guardrails for user-message content blocks.
const ALLOWED_IMG = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMG_B64 = 5 * 1024 * 1024; // ~3.75 MB decoded per image
const MAX_TEXT_BLOCK = 200 * 1024; // per text block (e.g. a parsed spreadsheet)
const MAX_IMAGES = 8;

// Normalise a message's `content` to a string, or a validated block array
// (text + base64 image only — anything else is dropped). Returns null for empty
// content. `onImage` is called once per accepted image so the caller can cap
// the total across the conversation.
function normalizeContent(content, onImage) {
  if (typeof content === "string") {
    const t = content.trim();
    return t || null;
  }
  if (!Array.isArray(content)) return null;
  const blocks = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      blocks.push({ type: "text", text: b.text.slice(0, MAX_TEXT_BLOCK) });
    } else if (
      b.type === "image" &&
      b.source && b.source.type === "base64" &&
      ALLOWED_IMG.has(b.source.media_type) &&
      typeof b.source.data === "string" && b.source.data
    ) {
      if (b.source.data.length > MAX_IMG_B64) {
        throw new Error("An attached image is too large — please use a smaller one.");
      }
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: b.source.media_type, data: b.source.data },
      });
      if (onImage) onImage();
    }
    // unknown block types are dropped
  }
  return blocks.length ? blocks : null;
}

const SYSTEM_PROMPT = `You are "Ask the Data", a careful data analyst for an Australian phone & electronics reseller. You answer questions by querying a READ-ONLY MySQL database with the run_sql tool, then summarising what you found.

The user may attach images (screenshots, photos, receipts) or spreadsheet data (included as text). Read them and use them together with the database when helpful — e.g. compare an attached price list against current offers, or identify a device from a photo then look it up. If an attachment alone answers the question, you don't need to run SQL.

How to work:
- Use run_sql to fetch data. It runs a single read-only SELECT (or WITH … SELECT) only; writes are impossible. Call it several times if needed: explore, then answer.
- Both tables hold ONE ROW PER OFFER PER SCRAPE DATE. For "current" / "right now" questions, restrict to the latest snapshot, e.g. scraped_date = (SELECT MAX(scraped_date) FROM stg_reebelo_offers). Only look across dates when the user asks about trends or changes over time.
- Prices are AUD. Grades (condition) are: 'Brand New', 'Like New', 'Very Good', 'Good'.
- Put a sensible LIMIT on row-returning queries (e.g. 50); use GROUP BY / aggregates for counts and averages.
- If a query errors, read the message, fix the SQL, and retry.

Answering:
- Give a short, direct answer in plain prose with the specific numbers (prices, counts, models, sellers).
- Do NOT paste SQL or large tables into your answer — the exact queries and their result rows are shown to the user separately. Refer to the findings, not the query. Do not narrate your reasoning; just give the answer.
- If the data cannot answer the question, say so briefly.

Database: jb_marketplace (MySQL 8).

Table stg_reebelo_offers — refurbished phone/device offers from the Reebelo marketplace (one row per offer per scrape date):
  id, reebelo_offer_id, scraped_date (DATE), scraped_at (DATETIME),
  reebelo_sku_id, reebelo_slug, slug, title, primary_title, category,
  brand, model, variant_colour, internal_memory, battery_health,
  grade, price (AUD), sold_by (seller name), seller_id, vendor_sku,
  stock (int), reebelo_detail_url, detail_url.

Table jb_hifi_scrape — JB Hi-Fi product listing snapshots (no scraped_date column; use scraped_at for recency, e.g. DATE(scraped_at)):
  id, title, primary_title, category, price (AUD), sold_by, scraped_at (DATETIME),
  seller_id, brand, model, variant_colour, internal_memory, grade, sku,
  stock_status, availability_statement, available_now,
  can_buy_online (0/1), delivery_status, display_product (0/1).`;

const TOOLS = [
  {
    name: "run_sql",
    description:
      "Run a single read-only MySQL SELECT (or WITH … SELECT) against the jb_marketplace database and get the resulting rows. Only SELECT is possible — no writes, no other statements. Use it to answer the user's question; you may call it multiple times to explore then answer.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "One MySQL SELECT statement." },
      },
      required: ["query"],
    },
  },
];

router.post("/ask", VIEW, async function (req, res) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      success: false,
      code: "not_configured",
      message:
        "AI querying isn't configured yet — add ANTHROPIC_API_KEY to the backend .env, then restart.",
    });
  }

  const raw = Array.isArray(req.body && req.body.messages)
    ? req.body.messages.slice(-20) // cap history length
    : [];
  const messages = [];
  let imageCount = 0;
  try {
    for (const m of raw) {
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
      const content = normalizeContent(m.content, () => { imageCount += 1; });
      if (content == null) continue;
      messages.push({ role: m.role, content });
    }
  } catch (e) {
    return res.status(400).json({ success: false, message: e.message || "Bad message content." });
  }
  if (imageCount > MAX_IMAGES) {
    return res
      .status(400)
      .json({ success: false, message: `Too many images attached (max ${MAX_IMAGES}).` });
  }
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res
      .status(400)
      .json({ success: false, message: "The last message must be from the user." });
  }

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const steps = [];

  try {
    for (let i = 0; i < MAX_ITERS; i++) {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages,
      });
      // Echo the assistant turn back verbatim (preserves tool_use + any thinking).
      messages.push({ role: "assistant", content: resp.content });

      if (resp.stop_reason !== "tool_use") {
        const answer = resp.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return res.json({ success: true, answer, steps, model: resp.model });
      }

      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        if (block.name !== "run_sql") {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Unknown tool.",
            is_error: true,
          });
          continue;
        }
        const q = block.input && block.input.query;
        try {
          const { sql, rows } = await runReadOnlySql(q);
          steps.push({ sql, rowCount: rows.length, rows: rows.slice(0, ROWS_TO_CLIENT) });
          const payload = { rowCount: rows.length, rows: rows.slice(0, ROWS_TO_MODEL) };
          if (rows.length > ROWS_TO_MODEL) {
            payload.note = `showing first ${ROWS_TO_MODEL} of ${rows.length} rows`;
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(payload),
          });
        } catch (e) {
          steps.push({ sql: typeof q === "string" ? q : "", error: e.message });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Error: ${e.message}`,
            is_error: true,
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
    }

    return res.json({
      success: true,
      answer:
        "I couldn't finish within the query limit for this question — try narrowing it down.",
      steps,
      model: MODEL,
      truncated: true,
    });
  } catch (e) {
    console.error("aiQuery error:", e && e.message ? e.message : e);
    let message = (e && e.message) || "AI query failed.";
    if (e && e.status === 401) message = "Anthropic API key is invalid.";
    else if (e && e.status === 429) message = "Rate limited by Anthropic — try again shortly.";
    const status = e && e.status >= 400 && e.status < 600 ? e.status : 502;
    return res.status(status).json({ success: false, message });
  }
});

module.exports = router;

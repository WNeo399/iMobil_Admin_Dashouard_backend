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
const { ObjectId } = require("mongodb");
const Anthropic = require("@anthropic-ai/sdk");
const { requirePermission } = require("../../middleware/auth");
const { runReadOnlySql } = require("../../utils/aiSql");
const { connectToDatabase } = require("../../utils/mongodb");

const VIEW = requirePermission("ai:query:use");
// The skill knowledge base is managed separately from using the chat — e.g.
// the Phone Supplier role can ask questions but must not see the skills.
const SKILLS = requirePermission("ai:skills:manage");

// Knowledge base of reusable "skills" — admin-authored guidance, structured
// three levels deep:
//   core   — Core Guidelines: rules applied to EVERY question (injected in full)
//   domain — a subject area (e.g. refurbished_phones) with its own rules; the
//            agent identifies the question's domain and pulls its rules
//   skill  — sub skill for a specific kind of question, belonging to a domain;
//            surfaced inside its domain's guidance and pulled on demand
const SKILLS_COLLECTION = "ai_agent_skills";

async function loadSkills(db) {
  try {
    return await db
      .collection(SKILLS_COLLECTION)
      .find({ enabled: { $ne: false } })
      .sort({ name: 1 })
      .toArray();
  } catch (e) {
    console.error("loadSkills failed:", e && e.message ? e.message : e);
    return [];
  }
}

// Level of a skill doc; legacy docs carried `always` instead of `type`.
function skillType(s) {
  if (s && (s.type === "core" || s.type === "domain" || s.type === "skill")) return s.type;
  return s && s.always === true ? "core" : "skill";
}

function skillsBlock(skills) {
  if (!skills || !skills.length) return "";
  let out = "";
  const cores = skills.filter((s) => skillType(s) === "core");
  const domains = skills.filter((s) => skillType(s) === "domain");
  const domainNames = new Set(domains.map((d) => String(d.name || "").toLowerCase()));
  // Sub skills whose domain doesn't exist (yet) — still discoverable.
  const orphans = skills.filter(
    (s) => skillType(s) === "skill" && !domainNames.has(String(s.domain || "").toLowerCase()),
  );

  if (cores.length) {
    out +=
      "\n\nCORE GUIDELINES — always follow these for every question:\n" +
      cores.map((s) => `## ${s.name}\n${s.body || ""}`).join("\n\n");
  }
  if (domains.length) {
    out +=
      "\n\nDOMAINS — every question belongs to one of these domains. Identify the domain, then call use_skill with the domain's exact name to read its rules BEFORE answering. The domain guidance also lists its sub skills — call use_skill again for any that match the question:\n" +
      domains.map((d) => `- ${d.name}: ${d.description || ""}`).join("\n");
  }
  if (orphans.length) {
    out +=
      "\n\nOTHER SKILLS — call use_skill with the exact name when relevant:\n" +
      orphans.map((s) => `- ${s.name}: ${s.description || ""}`).join("\n");
  }
  return out;
}

// The tool_result content for use_skill(name): a domain answers with its rules
// plus its sub-skill index; a sub skill answers with its guidance body.
function skillLookup(skills, wanted) {
  const w = String(wanted || "").trim().toLowerCase();
  const hit = skills.find((s) => String(s.name || "").trim().toLowerCase() === w);
  if (!hit) return null;
  if (skillType(hit) === "domain") {
    const subs = skills.filter(
      (s) => skillType(s) === "skill" && String(s.domain || "").toLowerCase() === String(hit.name || "").toLowerCase(),
    );
    let content = String(hit.body || "");
    content += subs.length
      ? "\n\nSub skills in this domain (call use_skill with the exact name when one matches the question):\n" +
        subs.map((s) => `- ${s.name}: ${s.description || ""}`).join("\n")
      : "\n\n(This domain has no sub skills yet.)";
    return { skill: hit, content };
  }
  return { skill: hit, content: String(hit.body || "") };
}

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
const MAX_ITERS = 20; // max tool rounds per question (safety cap vs runaway cost) — multi-model margin lists eat many rounds
const MAX_TOKENS = 8192; // present_answer tables from multi-model questions can be large
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

Answering — ALWAYS finish by calling the present_answer tool exactly once. Never write the answer as prose or paste SQL/tables into text; the query + full rows are already shown to the user separately. Keep it simple.
- view "table": a list or comparison of several items (e.g. cheapest offers, offers per seller). Pick the most useful columns (Model, Grade, Price, Seller, …) — not every column — and only the rows that matter.
- view "card": the details of ONE specific product, or ANY factual answer — lay the facts out as labelled fields (title, subtitle, fields like Price / Seller / Grade / Stock…). Prefer a card over plain text: even a single number reads better as a card with a label.
- view "chart": a trend over time or a numeric comparison across categories — supply charts: 1–3 chart objects {type, title, xLabels, series}. ALSO supply a card with the key facts (model, period, net change, units sold, …) — it is shown above the chart. Metrics with different scales (e.g. stock vs price) go in SEPARATE charts, not one. Use 'line' for time series, 'bar' for category comparisons.
- view "text": ONLY for out-of-scope declines, refusals, or when the data can't answer — never for a factual answer that could be a card.
- Always set a one-sentence \`summary\`. If the data can't answer the question, use view "text" and say so briefly.
- Size limit: keep any table to at most ~40 rows. If the full result is larger, present the most relevant rows and state in the summary how many were omitted — the user can narrow the question or ask for the rest.

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
  {
    name: "use_skill",
    description:
      "Read the full guidance for one of the knowledge-base skills listed in the system prompt. Call it when a skill looks relevant, BEFORE answering, then follow what it says.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "The exact skill name." } },
      required: ["name"],
    },
  },
  {
    name: "present_answer",
    description:
      "Present the final answer to the user. Call this exactly once, at the end, INSTEAD of writing a prose answer. Pick the view that fits the question: 'table' for a list/comparison of several items; 'card' for the details of ONE specific product OR any factual answer (present the facts as labelled fields — preferred over text); 'chart' for a trend over time or a numeric comparison (rendered as a line/bar chart); 'text' ONLY for declines or when there is genuinely nothing to structure.",
    input_schema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["table", "card", "text", "chart"], description: "How to display the answer." },
        summary: { type: "string", description: "One short sentence summarising the answer." },
        columns: {
          type: "array",
          items: { type: "string" },
          description: "table view: the most useful column headers (e.g. Model, Grade, Price, Seller) — not every column.",
        },
        rows: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
          description: "table view: each row as an array of cell values aligned to `columns`.",
        },
        card: {
          type: "object",
          description:
            "card view: details of one product / the key facts. Also include with view 'chart' — the key figures (model, period, units sold, net change …) shown above the chart.",
          properties: {
            title: { type: "string" },
            subtitle: { type: "string" },
            fields: {
              type: "array",
              items: {
                type: "object",
                properties: { label: { type: "string" }, value: { type: "string" } },
                required: ["label", "value"],
              },
            },
          },
        },
        charts: {
          type: "array",
          description:
            "chart view: 1–3 charts, each a line/bar chart. Use SEPARATE charts for metrics with different scales (e.g. one for stock, one for price). Use 'line' for time series, 'bar' for category comparisons.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["line", "bar"] },
              title: { type: "string" },
              xLabels: { type: "array", items: { type: "string" }, description: "X-axis labels (dates or categories)." },
              yLabel: { type: "string" },
              series: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    data: { type: "array", items: { type: ["number", "string", "null"] }, description: "One value per xLabel." },
                  },
                  required: ["name", "data"],
                },
              },
            },
            required: ["type", "xLabels", "series"],
          },
        },
      },
      required: ["view", "summary"],
    },
  },
];

// Coerce Claude's present_answer input into a safe, bounded shape for the UI.
function sanitizeResult(input) {
  const inp = input && typeof input === "object" ? input : {};
  const view = ["table", "card", "text", "chart"].includes(inp.view) ? inp.view : "text";
  const str = (v, n) => (v == null ? "" : String(v).slice(0, n));
  const out = { view, summary: str(inp.summary, 2000) };
  const sanitizeCard = (card) => ({
    title: str(card.title, 200),
    subtitle: str(card.subtitle, 200),
    fields: Array.isArray(card.fields)
      ? card.fields
          .slice(0, 24)
          .filter((f) => f && typeof f === "object")
          .map((f) => ({ label: str(f.label, 80), value: str(f.value, 300) }))
      : [],
  });
  if (view === "table") {
    out.columns = Array.isArray(inp.columns) ? inp.columns.slice(0, 12).map((c) => str(c, 80)) : [];
    const width = out.columns.length || 12;
    out.rows = Array.isArray(inp.rows)
      ? inp.rows.slice(0, 100).map((r) => (Array.isArray(r) ? r.slice(0, width).map((c) => str(c, 300)) : []))
      : [];
  } else if (view === "card") {
    out.card = sanitizeCard(inp.card && typeof inp.card === "object" ? inp.card : {});
    // Degenerate payload guard: a "card" with nothing on it renders as an
    // empty box — fall back to plain text (the summary carries the answer).
    if (!out.card.title && !out.card.subtitle && !out.card.fields.length) {
      out.view = "text";
      delete out.card;
    }
  } else if (view === "chart") {
    // A chart answer may also carry a card of key facts (model, window,
    // units sold, …) shown above the chart(s).
    if (inp.card && typeof inp.card === "object") out.card = sanitizeCard(inp.card);
    const sanitizeChart = (c) => {
      if (!c || typeof c !== "object") return null;
      const xLabels = Array.isArray(c.xLabels) ? c.xLabels.slice(0, 60).map((v) => str(v, 40)) : [];
      const series = Array.isArray(c.series)
        ? c.series
            .slice(0, 8) // room for per-colour splits
            .filter((s) => s && typeof s === "object")
            .map((s) => ({
              name: str(s.name, 60),
              data: (Array.isArray(s.data) ? s.data.slice(0, xLabels.length || 60) : []).map((v) => {
                const n = Number(v);
                return Number.isFinite(n) ? n : null;
              }),
            }))
        : [];
      if (!xLabels.length || !series.length) return null;
      return { type: c.type === "bar" ? "bar" : "line", title: str(c.title, 120), yLabel: str(c.yLabel, 60), xLabels, series };
    };
    const list = Array.isArray(inp.charts) ? inp.charts : inp.chart ? [inp.chart] : [];
    out.charts = list.slice(0, 3).map(sanitizeChart).filter(Boolean);
  }
  return out;
}

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
    ? req.body.messages.slice(-10) // cap history: last 10 messages (~5 Q/A pairs)
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

  // Load the knowledge-base skills and fold their index into the system prompt.
  let skills = [];
  try {
    const db = await connectToDatabase();
    skills = await loadSkills(db);
  } catch (e) {
    console.error("skills load (ask) failed:", e && e.message ? e.message : e);
  }
  const systemText = SYSTEM_PROMPT + skillsBlock(skills);

  // Stream newline-delimited JSON so the client can show live progress as the
  // agent moves through its query rounds:
  //   {type:"progress", label}  · {type:"result", ...}  · {type:"error", message}
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  let aborted = false;
  req.on("close", () => { aborted = true; });

  try {
    let queryNo = 0;
    let retriedOversize = false;
    for (let i = 0; i < MAX_ITERS; i++) {
      if (aborted) return;
      send({ type: "progress", label: i === 0 ? "Thinking…" : "Analysing results…" });

      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages,
      });
      if (aborted) return;
      // Echo the assistant turn back verbatim (preserves tool_use + any thinking).
      messages.push({ role: "assistant", content: resp.content });

      if (resp.stop_reason !== "tool_use") {
        let answer = resp.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        // Degenerate ending: max_tokens truncating the present_answer JSON.
        if (!answer && resp.stop_reason === "max_tokens" && !retriedOversize) {
          // If the truncated turn still carries a present_answer whose input
          // survived parsing AND actually has content (truncation often strips
          // the rows, leaving an empty shell), deliver it rather than retrying.
          const partial = resp.content.find(
            (b) => b.type === "tool_use" && b.name === "present_answer" &&
              b.input && b.input.view && b.input.summary,
          );
          if (partial) {
            const result = sanitizeResult(partial.input);
            const usable =
              result.view === "text" ||
              (result.view === "table" && result.rows && result.rows.length > 0) ||
              (result.view === "card" && result.card) ||
              (result.view === "chart" && result.charts && result.charts.length > 0);
            if (usable) {
              result.summary = (result.summary + " (Answer truncated — ask for fewer items for the full list.)").trim();
              send({ type: "result", success: true, answer: result.summary, result, steps, model: resp.model });
              return res.end();
            }
          }
          // Otherwise retry once, asking for a condensed version. Any tool_use
          // blocks in the truncated turn MUST be answered with tool_results in
          // the next message or the API rejects the replay.
          retriedOversize = true;
          console.warn("aiQuery answer hit max_tokens — retrying condensed");
          if (!resp.content.length) {
            // API rejects an empty assistant content array — drop the turn.
            messages.pop();
            messages.push({
              role: "user",
              content:
                "Your previous answer exceeded the output limit and was lost. Present a CONDENSED version now via present_answer: keep any table to the ~30 most relevant rows, state in the summary how many rows were omitted, and keep everything else short. Do not run any more queries.",
            });
          } else {
            const closeOut = resp.content
              .filter((b) => b.type === "tool_use")
              .map((b) => ({
                type: "tool_result",
                tool_use_id: b.id,
                content: "Skipped — your answer exceeded the output limit.",
                is_error: true,
              }));
            closeOut.push({
              type: "text",
              text:
                "That answer exceeded the output limit and was lost. Present a CONDENSED version now via present_answer: keep any table to the ~30 most relevant rows, state in the summary how many rows were omitted, and keep everything else short. Do not run any more queries.",
            });
            messages.push({ role: "user", content: closeOut });
          }
          send({ type: "progress", label: "Condensing the answer…" });
          continue;
        }
        if (!answer) {
          console.warn("aiQuery empty final answer, stop_reason:", resp.stop_reason);
          answer =
            resp.stop_reason === "max_tokens"
              ? "The answer got too long to deliver in one go — try asking about fewer items at once."
              : "I couldn't produce an answer for that — please try rephrasing the question.";
        }
        send({ type: "result", success: true, answer, steps, model: resp.model });
        return res.end();
      }

      // present_answer is terminal — it carries the final structured answer.
      const present = resp.content.find(
        (b) => b.type === "tool_use" && b.name === "present_answer",
      );
      if (present) {
        const result = sanitizeResult(present.input);
        send({ type: "result", success: true, answer: result.summary || "", result, steps, model: resp.model });
        return res.end();
      }

      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        if (block.name === "use_skill") {
          const found = skillLookup(skills, block.input && block.input.name);
          send({ type: "progress", label: found ? `Consulting: ${found.skill.name}…` : "Looking up a skill…" });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: found ? found.content : "No skill by that name.",
          });
          continue;
        }
        if (block.name !== "run_sql") {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Unknown tool.",
            is_error: true,
          });
          continue;
        }
        queryNo += 1;
        send({ type: "progress", label: `Running query ${queryNo}…` });
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

    send({
      type: "result",
      success: true,
      answer: "I couldn't finish within the query limit for this question — try narrowing it down.",
      steps,
      model: MODEL,
      truncated: true,
    });
    return res.end();
  } catch (e) {
    console.error("aiQuery error:", e && e.message ? e.message : e);
    let message = (e && e.message) || "AI query failed.";
    if (e && e.status === 401) message = "Anthropic API key is invalid.";
    else if (e && e.status === 429) message = "Rate limited by Anthropic — try again shortly.";
    if (!res.headersSent) {
      const status = e && e.status >= 400 && e.status < 600 ? e.status : 502;
      return res.status(status).json({ success: false, message });
    }
    send({ type: "error", message });
    return res.end();
  }
});

// ── Skill knowledge base — CRUD (admin) ─────────────────────────────
function skillPayload(b) {
  const name = String((b && b.name) || "").trim();
  const body = String((b && b.body) || "").trim();
  return {
    name,
    body,
    description: String((b && b.description) || "").trim(),
    tags: Array.isArray(b && b.tags)
      ? b.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
      : [],
    enabled: !(b && b.enabled === false),
    // Hierarchy level: core (always applied) | domain (subject area with rules)
    // | skill (sub skill belonging to a domain).
    type: ["core", "domain", "skill"].includes(b && b.type) ? b.type : "skill",
    domain: String((b && b.domain) || "").trim(),
  };
}

router.get("/skills", SKILLS, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const skills = await db.collection(SKILLS_COLLECTION).find({}).sort({ name: 1 }).toArray();
    return res.json({ success: true, skills });
  } catch (e) {
    console.error("skill list error:", e);
    return res.status(500).json({ success: false, message: "Failed to load skills" });
  }
});

router.post("/skills", SKILLS, async function (req, res) {
  try {
    const p = skillPayload(req.body);
    if (!p.name) return res.status(400).json({ success: false, message: "Name is required." });
    if (!p.body) return res.status(400).json({ success: false, message: "Guidance is required." });
    const now = new Date();
    const doc = {
      ...p,
      createdBy: (req.user && (req.user.username || req.user.email)) || null,
      createdAt: now,
      updatedAt: now,
    };
    const db = await connectToDatabase();
    const r = await db.collection(SKILLS_COLLECTION).insertOne(doc);
    return res.json({ success: true, skill: { _id: r.insertedId, ...doc } });
  } catch (e) {
    console.error("skill create error:", e);
    return res.status(500).json({ success: false, message: "Failed to create skill" });
  }
});

router.put("/skills/:id", SKILLS, async function (req, res) {
  try {
    let _id;
    try { _id = new ObjectId(req.params.id); } catch (e) {
      return res.status(400).json({ success: false, message: "invalid id." });
    }
    const b = req.body || {};
    const set = { updatedAt: new Date() };
    if (b.name != null) {
      const n = String(b.name).trim();
      if (!n) return res.status(400).json({ success: false, message: "Name cannot be empty." });
      set.name = n;
    }
    if (b.body != null) {
      const bb = String(b.body).trim();
      if (!bb) return res.status(400).json({ success: false, message: "Guidance cannot be empty." });
      set.body = bb;
    }
    if (b.description != null) set.description = String(b.description).trim();
    if (b.tags != null) {
      set.tags = Array.isArray(b.tags) ? b.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20) : [];
    }
    if (b.enabled != null) set.enabled = b.enabled !== false;
    if (b.type != null && ["core", "domain", "skill"].includes(b.type)) set.type = b.type;
    if (b.domain != null) set.domain = String(b.domain).trim();

    const db = await connectToDatabase();
    const r = await db.collection(SKILLS_COLLECTION).updateOne({ _id }, { $set: set });
    if (!r.matchedCount) return res.status(404).json({ success: false, message: "Skill not found." });
    return res.json({ success: true });
  } catch (e) {
    console.error("skill update error:", e);
    return res.status(500).json({ success: false, message: "Failed to update skill" });
  }
});

router.delete("/skills/:id", SKILLS, async function (req, res) {
  try {
    let _id;
    try { _id = new ObjectId(req.params.id); } catch (e) {
      return res.status(400).json({ success: false, message: "invalid id." });
    }
    const db = await connectToDatabase();
    const r = await db.collection(SKILLS_COLLECTION).deleteOne({ _id });
    if (!r.deletedCount) return res.status(404).json({ success: false, message: "Skill not found." });
    return res.json({ success: true });
  } catch (e) {
    console.error("skill delete error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete skill" });
  }
});

module.exports = router;

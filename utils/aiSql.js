// Safety layer for the AI "Ask the Data" chat: validate and run a single
// read-only SQL query against the scraper MySQL. This is the security boundary
// for AI-generated SQL, so it is deliberately strict and defence-in-depth:
//
//   1. Validation (below): single statement only; must start with SELECT/WITH;
//      no INTO (blocks OUTFILE/DUMPFILE/@var), no user-variable assignment,
//      no DoS/file functions, no sensitive schemas. Checks run on a sanitized
//      view with comments + string/identifier literals blanked, so a legitimate
//      SELECT that merely *mentions* a keyword in a string (e.g. LIKE '%drop%')
//      is NOT rejected.
//   2. Execution: runs inside `START TRANSACTION READ ONLY`, so even if a write
//      somehow slipped past validation the database itself rejects it. The pool
//      has multipleStatements off (mysql2 default), and max_execution_time caps
//      runaway queries.
//
// For production, also give this a dedicated read-only MySQL user (belt and
// braces over the current admin login).

const { getPool } = require("./scraperDb");

const ROW_CAP = 1000; // hard cap on rows returned from any single query
const MAX_EXEC_MS = 8000; // per-query time budget

function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/#[^\n]*/g, " ");
}

// Comment-free view with string literals and backtick identifiers blanked, so
// keyword/`;` checks never trip on data that merely contains those characters.
function sanitizeForScan(s) {
  return stripComments(s)
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    .replace(/`[^`]*`/g, "``");
}

function validateReadOnlySql(rawSql) {
  if (typeof rawSql !== "string" || !rawSql.trim()) {
    throw new Error("Empty SQL.");
  }
  const sql = rawSql.trim().replace(/;\s*$/, ""); // drop a single trailing ;
  const scan = sanitizeForScan(sql).trim();
  if (!scan) throw new Error("Empty SQL.");
  if (scan.includes(";")) throw new Error("Only a single statement is allowed.");
  if (!/^\(*\s*(select|with)\b/i.test(scan)) {
    throw new Error("Only SELECT queries are allowed.");
  }
  if (/\binto\b/i.test(scan)) throw new Error("SELECT ... INTO is not allowed.");
  if (/:=/.test(scan)) throw new Error("Variable assignment is not allowed.");
  if (/\b(sleep|benchmark|get_lock|release_lock|load_file)\s*\(/i.test(scan)) {
    throw new Error("That function is not allowed.");
  }
  if (/\b(mysql|information_schema|performance_schema|sys)\s*\./i.test(scan)) {
    throw new Error("That schema is not accessible.");
  }
  return sql;
}

// Validate, bound with a LIMIT if the model omitted one, and run inside a
// read-only transaction. Returns { sql, rows } (sql = the query actually run).
async function runReadOnlySql(rawSql) {
  const sql = validateReadOnlySql(rawSql);
  const hasLimit = /\blimit\s+\d+/i.test(sanitizeForScan(sql));
  const bounded = hasLimit ? sql : `${sql} LIMIT ${ROW_CAP}`;

  const conn = await getPool().getConnection();
  try {
    await conn.query(`SET SESSION max_execution_time = ${MAX_EXEC_MS}`);
    await conn.query("START TRANSACTION READ ONLY");
    const [rows] = await conn.query(bounded);
    await conn.query("COMMIT");
    return { sql: bounded, rows: Array.isArray(rows) ? rows.slice(0, ROW_CAP) : rows };
  } catch (e) {
    try { await conn.query("ROLLBACK"); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { validateReadOnlySql, runReadOnlySql, ROW_CAP };

// Read-only connection to the ExEngine (Exyon) MySQL database, kept separate
// from the app's MongoDB. Configured via EX_DB_HOST / EX_DB_USER /
// EX_DB_PASSWORD (+ optional EX_DB_NAME / EX_DB_PORT) in the env.
const mysql = require("mysql2/promise");

let pool;

function getExPool() {
  if (!pool) {
    if (!process.env.EX_DB_HOST) {
      throw new Error("ExEngine DB not configured (set EX_DB_HOST / EX_DB_USER / EX_DB_PASSWORD).");
    }
    pool = mysql.createPool({
      host: process.env.EX_DB_HOST,
      user: process.env.EX_DB_USER,
      password: process.env.EX_DB_PASSWORD,
      database: process.env.EX_DB_NAME || "exyon_au",
      port: Number(process.env.EX_DB_PORT) || 3306,
      waitForConnections: true,
      connectionLimit: 4,
      connectTimeout: 20000,
      // Decimals as JS numbers (unit_price etc.) rather than strings.
      decimalNumbers: true,
    });
  }
  return pool;
}

async function exQuery(sql, params) {
  const [rows] = await getExPool().query(sql, params || []);
  return rows;
}

module.exports = { getExPool, exQuery };

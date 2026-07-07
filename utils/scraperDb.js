// Read-only connection to the external "scraper" MySQL DB (AWS RDS) that holds
// the Reebelo/JB marketplace snapshots. Separate from our MongoDB. Credentials
// come from the SCRAPER_DB_* env vars. Lazily-created pool so the app still
// starts if the DB is unreachable — only the Refurbished Phones endpoints use it.

const mysql = require("mysql2/promise");

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.SCRAPER_DB_HOST,
      port: Number(process.env.SCRAPER_DB_PORT) || 3306,
      user: process.env.SCRAPER_DB_USER,
      password: process.env.SCRAPER_DB_PASSWORD,
      database: process.env.SCRAPER_DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 15000,
      // Return DATE/DATETIME as strings so we don't get timezone-shifted values.
      dateStrings: true,
    });
  }
  return pool;
}

async function query(sql, params) {
  const [rows] = await getPool().query(sql, params || []);
  return rows;
}

module.exports = { getPool, query };

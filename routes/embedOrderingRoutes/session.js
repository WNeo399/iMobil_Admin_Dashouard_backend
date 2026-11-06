// Embed Ordering — customer sessions for the ordering widget (Mongo: embed_ordering_sessions).
//
// A signed-in customer holds a random token (kept in the widget's
// localStorage on the distributor's site). Only its sha256 is stored, so a
// copy of the collection can't be used to sign in. Sessions last 30 days and
// a TTL index clears them; signing out deletes one at once. The customer and
// distributor are re-checked on every request (routes/embedOrderingRoutes/widget.js),
// so setting either inactive locks the customer out straight away.
//
// DEMO (user, 2026-11-06): the widget signs in by email alone — no code, no
// password. The token / session side here stays the same when email codes
// arrive; only how a session is granted changes.

const crypto = require("crypto");

const SESSIONS = "embed_ordering_sessions";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
// lastUsedAt is written at most this often, not on every request.
const TOUCH_MS = 10 * 60 * 1000;

const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

let _indexed = false;
async function ensureSessionIndexes(db) {
  if (_indexed) return;
  try {
    const col = db.collection(SESSIONS);
    await col.createIndex({ tokenHash: 1 }, { unique: true, name: "token_hash_unique" });
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "expires_ttl" });
    await col.createIndex({ customerId: 1 }, { name: "customer" });
    _indexed = true;
  } catch (e) {
    console.warn("Embed Ordering session indexes not created:", (e && e.message) || e);
  }
}

async function createSession(db, { customerId, distributorId, ip, userAgent }) {
  await ensureSessionIndexes(db);
  const token = "eos_" + crypto.randomBytes(32).toString("hex");
  const now = new Date();
  await db.collection(SESSIONS).insertOne({
    tokenHash: hashToken(token),
    customerId,
    distributorId,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + TTL_MS),
    ip: ip || null,
    userAgent: userAgent || null,
  });
  return token;
}

// The live session for a token, or null. The TTL index deletes expired rows
// within a minute or so; the date check covers that gap.
async function findSession(db, token) {
  if (!token || typeof token !== "string" || token.length > 200) return null;
  const s = await db.collection(SESSIONS).findOne({ tokenHash: hashToken(token) });
  if (!s || !s.expiresAt || new Date(s.expiresAt).getTime() <= Date.now()) return null;
  if (Date.now() - new Date(s.lastUsedAt || 0).getTime() > TOUCH_MS) {
    db.collection(SESSIONS)
      .updateOne({ _id: s._id }, { $set: { lastUsedAt: new Date() } })
      .catch(() => {});
  }
  return s;
}

async function deleteSession(db, token) {
  if (!token || typeof token !== "string") return 0;
  const r = await db.collection(SESSIONS).deleteOne({ tokenHash: hashToken(token) });
  return r.deletedCount || 0;
}

module.exports = { SESSIONS, createSession, findSession, deleteSession, hashToken, ensureSessionIndexes };

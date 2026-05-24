#!/usr/bin/env node

// One-off script to provision the first Admin account.
//
//   node bin/seedAdmin.js
//
// Reads ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD from the environment,
// falling back to sensible defaults. Safe to re-run: it will not create a
// duplicate if a user with the same username or email already exists.

require("dotenv").config();

const {
  connectToDatabase,
  closeDatabaseConnection,
} = require("../utils/mongodb");
const { hashPassword } = require("../utils/authToken");
const { ROLES } = require("../constants/roles");

async function main() {
  const username = process.env.ADMIN_USERNAME || "admin";
  const email = (process.env.ADMIN_EMAIL || "admin@imobile.local").toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "ChangeMe123!";

  const db = await connectToDatabase();
  const users = db.collection("users");

  const existing = await users.findOne({
    $or: [{ username }, { email }],
  });
  if (existing) {
    console.log(
      `ℹ️  A user with username "${username}" or email "${email}" already exists (id ${existing._id}). No changes made.`,
    );
    return;
  }

  const now = new Date();
  const doc = {
    username,
    email,
    passwordHash: await hashPassword(password),
    role: ROLES.ADMIN,
    shopIds: [],
    active: true,
    createdAt: now,
    updatedAt: now,
  };

  const result = await users.insertOne(doc);
  console.log("✅ Admin account created:");
  console.log(`   id:       ${result.insertedId}`);
  console.log(`   username: ${username}`);
  console.log(`   email:    ${email}`);
  console.log(`   password: ${password}`);
  console.log(
    "\n⚠️  Change this password after first login (and set ADMIN_PASSWORD in .env to avoid the default).",
  );
}

main()
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabaseConnection();
    process.exit();
  });

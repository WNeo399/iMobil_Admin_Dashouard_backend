// iMobile Accountant — what customers owe iMobile, read from Zoho Inventory
// (user ask 2026-09-30: a new "iMobile Accountant" role and menu).
//
//   /accountant/myfone/...             the My Fone shops (./myfone.js)
//
// The first page, a Dashboard of every unpaid invoice
// (GET /accountant/unpaid-invoices), was taken out on 2026-10-01 — not
// needed yet. Its list still lives on in utils/accountantInvoices, which
// My Fone reads for what each shop owes. acct:* — admin and the iMobile
// Accountant role only.

const express = require("express");
const router = express.Router();

router.use("/myfone", require("./myfone"));

module.exports = router;

// Admin-side endpoints for reviewing widget Special Order submissions.
//
// Separate router from /widget (which is the PUBLIC submission path
// the widget hits) — these endpoints are mounted under the authenticated
// chain in app.js so only dashboard users with the right permission can
// browse and triage what came in.
//
// Reads + writes the imb_special_orders collection populated by
// routes/widgetRoutes/specialOrder.js.

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { requireAnyPermission } = require("../../middleware/auth");
const { connectToDatabase } = require("../../utils/mongodb");

const COLLECTION = "imb_special_orders";

// ANY of: the original zoho gate (admin / iMobile Admin — same group who
// triages credit notes) OR the dedicated po:specialOrder:view held by the
// iMobile Purchase role (covered by its po:*:* grant).
const GATE = requireAnyPermission("zoho:salesOrder:create", "po:specialOrder:view");

// Status lifecycle:
//   new        just landed from the widget
//   reviewed   triage done, in progress
//   fulfilled  closed out successfully
//   rejected   closed out without fulfilment (out of scope / spam / etc.)
const ALLOWED_STATUSES = ["new", "reviewed", "fulfilled", "rejected"];

// ── GET /specialOrder/list ──────────────────────────────────────────
// Paginated list. Same shape as /creditNote/list so the frontend's
// review-page pattern can be reused near-verbatim:
//   ?status=<new|reviewed|fulfilled|rejected>  optional status filter
//   ?search=<name substring>                   optional case-insensitive
//                                              regex match on `name`
//   ?page=N&pageSize=M                         standard paging
//
// Counts respect the search filter but ignore the status filter so
// picking a status doesn't hide the other tabs' totals.
router.get("/list", GATE, async function (req, res) {
  try {
    const { status, search } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(req.query.pageSize, 10) || 20, 1);

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    // fullFilter = search + status (used for the visible page + total).
    // The tree-panel counts intentionally ignore BOTH search and status
    // so the per-status badges show true totals and don't jump around
    // as the user types in the search box.
    const fullFilter = {};
    if (search) {
      // Escape regex metacharacters so a "." or "+" in a name can't
      // change the search semantics.
      const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      fullFilter.name = { $regex: safe, $options: "i" };
    }
    if (status) {
      if (!ALLOWED_STATUSES.includes(String(status))) {
        return res
          .status(400)
          .json({ success: false, message: `Unknown status "${status}"` });
      }
      fullFilter.status = String(status);
    }

    const [data, total, countsRaw] = await Promise.all([
      collection
        .find(fullFilter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      collection.countDocuments(fullFilter),
      // Counts over ALL documents — no search/status filter — so the
      // tree badges are stable totals.
      collection
        .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])
        .toArray(),
    ]);

    const counts = { all: 0 };
    for (const s of ALLOWED_STATUSES) counts[s] = 0;
    for (const c of countsRaw) {
      const key = c._id || "unknown";
      // Don't add unknown statuses into the named buckets — keep them
      // separate so a stray value surfaces in the all rollup but
      // doesn't silently inflate a known tab.
      if (Object.prototype.hasOwnProperty.call(counts, key)) {
        counts[key] = c.count;
      }
      counts.all += c.count;
    }

    return res.json({
      success: true,
      data,
      total,
      page,
      pageSize,
      counts,
    });
  } catch (error) {
    console.error("List special orders error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to list special orders" });
  }
});

// ── PATCH /specialOrder/:id ─────────────────────────────────────────
// Partial update — currently just `status`. Open it up later if we
// want admin notes etc. without a schema migration.
//
// Body:
//   { status: 'new' | 'reviewed' | 'fulfilled' | 'rejected' }
//
// Returns the updated row so the caller can sync its local cache.
router.patch("/:id", GATE, async function (req, res) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const body = req.body || {};
    const update = {};

    if (Object.prototype.hasOwnProperty.call(body, "status")) {
      const next = String(body.status || "").trim();
      if (!ALLOWED_STATUSES.includes(next)) {
        return res.status(400).json({
          success: false,
          message: `status must be one of: ${ALLOWED_STATUSES.join(", ")}`,
        });
      }
      update.status = next;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        success: false,
        message: "Nothing to update — provide a status",
      });
    }

    update.updatedAt = new Date();

    const db = await connectToDatabase();
    const result = await db
      .collection(COLLECTION)
      .findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: update },
        { returnDocument: "after" },
      );
    const updatedRow = result && (result.value || result);
    if (!updatedRow || !updatedRow._id) {
      return res
        .status(404)
        .json({ success: false, message: "Special order not found" });
    }

    return res.json({ success: true, data: updatedRow });
  } catch (error) {
    console.error("Patch special order error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update special order" });
  }
});

module.exports = router;

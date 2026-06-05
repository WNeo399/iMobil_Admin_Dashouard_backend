// Admin CRUD for the per-widget origin allowlist.
//
// Reads + writes the imb_widget_origins collection that the public
// /widget/* endpoints consult on every submission. Every mutating
// route invalidates the lookup cache so the change propagates to
// the widget endpoints without waiting for the 60s TTL.
//
// Permission gate: system:user:manage — same admin-tier permission
// the Users page uses, since both control who can talk to the
// backend.

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { requirePermission } = require("../../middleware/auth");
const { connectToDatabase } = require("../../utils/mongodb");
const {
  COLLECTION,
  invalidateCache,
  normalizeOrigin,
} = require("../../utils/widgetOrigins");

const GATE = requirePermission("system:user:manage");

// ── GET /widgetOrigin/list ──────────────────────────────────────────
// Paginated. Accepts:
//   ?widget=<name>     filter by widget (e.g. "special-order")
//   ?search=<text>     case-insensitive substring on origin OR label
//   ?page=N&pageSize=M standard paging
//
// Also returns `widgets` — the distinct widget names currently in the
// collection — so the page's widget filter dropdown can render them
// without a second round trip.
router.get("/list", GATE, async function (req, res) {
  try {
    const { widget, search } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(req.query.pageSize, 10) || 50, 1);

    const filter = {};
    if (widget) filter.widget = String(widget);
    if (search) {
      const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { origin: { $regex: safe, $options: "i" } },
        { label: { $regex: safe, $options: "i" } },
      ];
    }

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);
    // We need the distinct widget names in the collection so the
    // page's filter dropdown can render them. `collection.distinct()`
    // would be the natural fit but it's NOT in MongoDB Stable API
    // V1 — and utils/mongodb.js enables `strict: true`, so calling
    // it returns APIStrictError. A $group aggregation gives the same
    // result and IS in V1.
    const [data, total, widgetGroups] = await Promise.all([
      collection
        .find(filter)
        .sort({ widget: 1, origin: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      collection.countDocuments(filter),
      collection
        .aggregate([{ $group: { _id: "$widget" } }])
        .toArray(),
    ]);

    return res.json({
      success: true,
      data,
      total,
      page,
      pageSize,
      widgets: (widgetGroups || [])
        .map((g) => g._id)
        .filter(Boolean)
        .sort(),
    });
  } catch (error) {
    console.error("List widget origins error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to list widget origins" });
  }
});

// ── POST /widgetOrigin ──────────────────────────────────────────────
// Body: { widget, origin, label?, enabled? }
// Origin is normalised (URL.origin form) before storage to keep
// "https://Example.com/" / "https://example.com" from being two
// different rows. The (widget, origin) compound index turns a
// duplicate insert into a 409.
router.post("/", GATE, async function (req, res) {
  try {
    const body = req.body || {};
    const widget = String(body.widget || "").trim();
    if (!widget) {
      return res
        .status(400)
        .json({ success: false, message: "widget is required" });
    }
    const origin = normalizeOrigin(body.origin);
    if (!origin) {
      return res.status(400).json({
        success: false,
        message:
          "origin must be a valid URL like https://example.com (no path, no trailing slash)",
      });
    }
    const label =
      body.label != null && String(body.label).trim() !== ""
        ? String(body.label).trim()
        : null;
    // Default to enabled — the typical add flow is "I want this
    // origin to work now"; the admin can untick it explicitly to
    // stage a disabled entry.
    const enabled = body.enabled === false ? false : true;

    const now = new Date();
    const doc = {
      widget,
      origin,
      label,
      enabled,
      createdAt: now,
      updatedAt: now,
      // Resolved from the JWT by the authenticate middleware. We
      // record both creator and last-mutator so the audit trail
      // doesn't lose who set up a long-lived entry vs who last
      // toggled it.
      createdBy: (req.user && req.user.id) || null,
      updatedBy: (req.user && req.user.id) || null,
    };

    const db = await connectToDatabase();
    try {
      const result = await db.collection(COLLECTION).insertOne(doc);
      invalidateCache(widget);
      return res.json({
        success: true,
        data: { ...doc, _id: result.insertedId },
      });
    } catch (e) {
      // Duplicate-key error from the (widget, origin) unique index.
      if (e && e.code === 11000) {
        return res.status(409).json({
          success: false,
          message: `Origin "${origin}" is already configured for widget "${widget}".`,
        });
      }
      throw e;
    }
  } catch (error) {
    console.error("Create widget origin error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create widget origin" });
  }
});

// ── PATCH /widgetOrigin/:id ─────────────────────────────────────────
// Body accepts any subset of { origin, label, enabled }. `widget` is
// intentionally immutable — moving an origin to a different widget
// is conceptually a delete + create, and would risk silently changing
// what an existing origin entry means.
router.patch("/:id", GATE, async function (req, res) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const body = req.body || {};
    const update = {};

    if (Object.prototype.hasOwnProperty.call(body, "origin")) {
      const origin = normalizeOrigin(body.origin);
      if (!origin) {
        return res.status(400).json({
          success: false,
          message: "origin must be a valid URL like https://example.com",
        });
      }
      update.origin = origin;
    }
    if (Object.prototype.hasOwnProperty.call(body, "label")) {
      const label =
        body.label != null && String(body.label).trim() !== ""
          ? String(body.label).trim()
          : null;
      update.label = label;
    }
    if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
      update.enabled = body.enabled === true;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        success: false,
        message: "Nothing to update — provide origin, label, and/or enabled",
      });
    }

    update.updatedAt = new Date();
    update.updatedBy = (req.user && req.user.id) || null;

    const db = await connectToDatabase();
    try {
      const result = await db.collection(COLLECTION).findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: update },
        { returnDocument: "after" },
      );
      // Driver-version unwrap — newer drivers return the doc directly,
      // older ones wrap in { value: doc }. Same defensive read as
      // PATCH /creditNote/:id.
      const updatedRow = result && (result.value || result);
      if (!updatedRow || !updatedRow._id) {
        return res
          .status(404)
          .json({ success: false, message: "Widget origin not found" });
      }
      // Invalidate the cache for THIS row's widget. If origin moved
      // (it can't move widget, see above) the cache key stays the
      // same so a single invalidation covers it.
      invalidateCache(updatedRow.widget);
      return res.json({ success: true, data: updatedRow });
    } catch (e) {
      if (e && e.code === 11000) {
        return res.status(409).json({
          success: false,
          message: `That origin is already configured for this widget.`,
        });
      }
      throw e;
    }
  } catch (error) {
    console.error("Patch widget origin error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update widget origin" });
  }
});

// ── DELETE /widgetOrigin/:id ────────────────────────────────────────
router.delete("/:id", GATE, async function (req, res) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }
    const db = await connectToDatabase();
    // Read first so we know which widget cache to invalidate; without
    // this the deletion would silently leave a stale cache entry up
    // to the TTL.
    const collection = db.collection(COLLECTION);
    const row = await collection.findOne({ _id: new ObjectId(id) });
    if (!row) {
      return res
        .status(404)
        .json({ success: false, message: "Widget origin not found" });
    }
    await collection.deleteOne({ _id: new ObjectId(id) });
    invalidateCache(row.widget);
    return res.json({ success: true });
  } catch (error) {
    console.error("Delete widget origin error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete widget origin" });
  }
});

module.exports = router;

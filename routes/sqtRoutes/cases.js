var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { handleZohoInventoryPostRequest } = require("../../utils/zohoRequest");

const ZOHO_ORG_ID = "746138234";
const ZOHO_PRICEBOOK_ID_WHOLESALE = "2591985000000103011";
const ZOHO_TEMPLATE_ID = "2591985000314129187";
const ZOHO_CUSTOMFIELD_CASE_ID = "2591985000317492543";
const ZOHO_CUSTOMFIELD_TICKET_ID = "2591985000317627125";

const COLLECTION = "sqt_cases";

const VALID_STATUSES = [
  "pending",
  "waiting-for-parts",
  "parts-arrived",
  "waiting-for-drop-off",
  "repairing",
  "repaired",
  "repaired-and-collected",
  "unrepairable",
  "ber",
  "completed",
  "cancelled",
];

function toDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function toObjectIdOrNull(v) {
  if (!v) return null;
  return ObjectId.isValid(v) ? new ObjectId(v) : null;
}

function buildCaseDoc(body, { isUpdate = false, shop = null, model = null } = {}) {
  const doc = {};

  if (body.serviceRequestId !== undefined) {
    doc.serviceRequestId = body.serviceRequestId
      ? String(body.serviceRequestId).trim()
      : null;
  }
  if (body.caseId !== undefined) {
    doc.caseId = body.caseId ? String(body.caseId).trim() : null;
  }
  if (body.repairDeskTicketId !== undefined) {
    doc.repairDeskTicketId = body.repairDeskTicketId
      ? String(body.repairDeskTicketId).trim()
      : null;
  }
  if (body.repairDeskTicketNumber !== undefined) {
    doc.repairDeskTicketNumber = body.repairDeskTicketNumber
      ? String(body.repairDeskTicketNumber).trim()
      : null;
  }

  if (shop !== null) {
    if (shop) {
      doc.shopId = shop._id;
      doc.shopName = shop.storeName;
    } else if (body.shopId === null || body.shopId === "") {
      doc.shopId = null;
      doc.shopName = null;
    }
  }

  if (body.retailer !== undefined) {
    doc.retailer = body.retailer ? String(body.retailer).trim() : null;
  }

  if (body.customer !== undefined) {
    const c = body.customer || {};
    doc.customer = {
      firstName: c.firstName || null,
      lastName: c.lastName || null,
      address: c.address || null,
      phone: c.phone || null,
      email: c.email ? String(c.email).trim().toLowerCase() : null,
    };
  }

  if (body.device !== undefined) {
    const d = body.device || {};
    doc.device = {
      category: d.category || null,
      description: d.description || null,
      imei: d.imei ? String(d.imei).trim() : null,
      brand: d.brand || null,
      purchasePrice:
        d.purchasePrice === null || d.purchasePrice === "" || d.purchasePrice === undefined
          ? null
          : Number(d.purchasePrice),
      purchaseDate: toDateOrNull(d.purchaseDate),
      modelId: model ? model._id : toObjectIdOrNull(d.modelId),
      modelName: model ? model.name : d.modelName || null,
    };
  }

  if (body.describedFault !== undefined) {
    doc.describedFault = body.describedFault || null;
  }

  if (body.source !== undefined) {
    const s = body.source || {};
    doc.source = {
      emailSubject: s.emailSubject || null,
      emailFrom: s.emailFrom || null,
      emailTo: s.emailTo || null,
      receivedAt: toDateOrNull(s.receivedAt),
    };
  }

  const now = new Date();
  if (!isUpdate) doc.createdAt = now;
  doc.updatedAt = now;

  return doc;
}

async function resolveShop(db, shopId) {
  if (!shopId) return null;
  if (!ObjectId.isValid(shopId)) return null;
  return db.collection("sqt_shops").findOne({ _id: new ObjectId(shopId) });
}

async function resolveModel(db, modelId) {
  if (!modelId) return null;
  if (!ObjectId.isValid(modelId)) return null;
  return db.collection("sqt_models").findOne({ _id: new ObjectId(modelId) });
}

router.get("/list", async function (req, res, next) {
  try {
    const { status, shopId, search } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(req.query.pageSize, 10) || 20, 1);

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const query = {};

    if (status) {
      const arr =
        typeof status === "string" ? status.split(",") : Array.isArray(status) ? status : [status];
      query.status = { $in: arr };
    }

    if (shopId && ObjectId.isValid(shopId)) {
      query.shopId = new ObjectId(shopId);
    }

    if (search) {
      const re = { $regex: String(search), $options: "i" };
      query.$or = [
        { serviceRequestId: re },
        { caseId: re },
        { repairDeskTicketNumber: re },
        { "customer.firstName": re },
        { "customer.lastName": re },
        { "customer.email": re },
        { "customer.phone": re },
        { "device.imei": re },
        { "device.description": re },
        { retailer: re },
      ];
    }

    const totalDocs = await collection.countDocuments(query);
    const data = await collection
      .find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();

    return res.json({
      success: true,
      totalDocs,
      page,
      pageSize,
      totalPages: Math.ceil(totalDocs / pageSize),
      data,
    });
  } catch (error) {
    console.error("List cases error:", error);
    return res.status(500).json({ success: false, message: "Failed to list cases" });
  }
});

// Counts per status — for the sidebar tree
router.get("/counts", async function (req, res, next) {
  try {
    const db = await connectToDatabase();
    const result = await db
      .collection(COLLECTION)
      .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])
      .toArray();

    const counts = {};
    let total = 0;
    for (const s of VALID_STATUSES) counts[s] = 0;
    for (const row of result) {
      if (row._id) {
        counts[row._id] = row.count;
        total += row.count;
      }
    }

    return res.json({ success: true, data: { total, byStatus: counts } });
  } catch (error) {
    console.error("Case counts error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch counts" });
  }
});

router.get("/detail/:id", async function (req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid case id" });
    }
    const db = await connectToDatabase();
    const data = await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!data) {
      return res.status(404).json({ success: false, message: "Case not found" });
    }
    return res.json({ success: true, data });
  } catch (error) {
    console.error("Get case detail error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch case" });
  }
});

router.post("/create", async function (req, res, next) {
  try {
    const { serviceRequestId } = req.body;
    if (!serviceRequestId) {
      return res
        .status(400)
        .json({ success: false, message: "serviceRequestId is required" });
    }

    const status = req.body.status && VALID_STATUSES.includes(req.body.status)
      ? req.body.status
      : "pending";

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    // Uniqueness — serviceRequestId always; caseId / repairDesk IDs when provided
    const orClauses = [{ serviceRequestId: String(serviceRequestId).trim() }];
    if (req.body.caseId) orClauses.push({ caseId: String(req.body.caseId).trim() });
    if (req.body.repairDeskTicketId)
      orClauses.push({ repairDeskTicketId: String(req.body.repairDeskTicketId).trim() });
    if (req.body.repairDeskTicketNumber)
      orClauses.push({ repairDeskTicketNumber: String(req.body.repairDeskTicketNumber).trim() });

    const dup = await collection.findOne({ $or: orClauses });
    if (dup) {
      return res
        .status(409)
        .json({ success: false, message: "A case with one of these identifiers already exists" });
    }

    const shop = await resolveShop(db, req.body.shopId);
    const model = await resolveModel(db, req.body.device && req.body.device.modelId);

    const doc = buildCaseDoc(req.body, { isUpdate: false, shop, model });
    const now = new Date();

    doc.status = status;
    doc.statusHistory = [
      {
        status,
        at: now,
        updatedBy: req.body.updatedBy || "system",
        note: req.body.statusNote || "Case created",
      },
    ];
    // Initialize collection arrays / objects (empty for now)
    doc.zohoOrders = Array.isArray(req.body.zohoOrders) ? req.body.zohoOrders : [];
    doc.partsForInvoice = Array.isArray(req.body.partsForInvoice) ? req.body.partsForInvoice : [];
    doc.sqtInvoice = {
      id: null,
      number: null,
      invoicedAt: null,
      paidAt: null,
      amount: null,
    };
    doc.shopPayment = {
      id: null,
      ref: null,
      paidAt: null,
      amount: null,
    };

    const result = await collection.insertOne(doc);
    return res
      .status(201)
      .json({ success: true, message: "Case created", data: { _id: result.insertedId, ...doc } });
  } catch (error) {
    console.error("Create case error:", error);
    return res.status(500).json({ success: false, message: "Failed to create case" });
  }
});

router.put("/update/:id", async function (req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid case id" });
    }
    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    // Reject status changes here — use /status/:id
    if (req.body.status !== undefined) {
      delete req.body.status;
    }
    delete req.body.statusHistory;

    // Uniqueness for editable identifiers
    const checkDup = async (field) => {
      const val = req.body[field];
      if (!val) return null;
      return collection.findOne({
        [field]: String(val).trim(),
        _id: { $ne: new ObjectId(id) },
      });
    };
    for (const f of ["serviceRequestId", "caseId", "repairDeskTicketId", "repairDeskTicketNumber"]) {
      const dup = await checkDup(f);
      if (dup) {
        return res
          .status(409)
          .json({ success: false, message: `${f} is already used by another case` });
      }
    }

    let shop = null;
    if (req.body.shopId !== undefined) {
      shop = req.body.shopId ? await resolveShop(db, req.body.shopId) : false;
      // false → caller passed empty/null, we'll clear the field
    }

    let model = null;
    if (req.body.device && req.body.device.modelId !== undefined) {
      model = req.body.device.modelId
        ? await resolveModel(db, req.body.device.modelId)
        : null;
    }

    const update = buildCaseDoc(req.body, {
      isUpdate: true,
      shop: shop === false ? null : shop,
      model,
    });

    const result = await collection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: update },
      { returnDocument: "after" },
    );

    const updated = result.value || result;
    if (!updated) {
      return res.status(404).json({ success: false, message: "Case not found" });
    }
    return res.json({ success: true, message: "Case updated", data: updated });
  } catch (error) {
    console.error("Update case error:", error);
    return res.status(500).json({ success: false, message: "Failed to update case" });
  }
});

router.post("/status/:id", async function (req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid case id" });
    }
    const { status, note, updatedBy } = req.body;
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `status must be one of: ${VALID_STATUSES.join(", ")}`,
      });
    }

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const now = new Date();
    const historyEntry = {
      status,
      at: now,
      updatedBy: updatedBy || "Admin",
      note: note || null,
    };

    const result = await collection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: { status, updatedAt: now },
        $push: { statusHistory: historyEntry },
      },
      { returnDocument: "after" },
    );

    const updated = result.value || result;
    if (!updated) {
      return res.status(404).json({ success: false, message: "Case not found" });
    }
    return res.json({ success: true, message: "Status updated", data: updated });
  } catch (error) {
    console.error("Change status error:", error);
    return res.status(500).json({ success: false, message: "Failed to change status" });
  }
});

router.post("/:id/sendParts", async function (req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid case id" });
    }

    const products = Array.isArray(req.body && req.body.products) ? req.body.products : [];
    const lineItems = products
      .filter((p) => p && p.product_id)
      .map((p) => ({ item_id: String(p.product_id), quantity: 1 }));

    if (lineItems.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "At least one product with a product_id is required" });
    }

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const theCase = await collection.findOne({ _id: new ObjectId(id) });
    if (!theCase) {
      return res.status(404).json({ success: false, message: "Case not found" });
    }
    if (!theCase.shopId) {
      return res
        .status(400)
        .json({ success: false, message: "Case has no shop assigned" });
    }

    const shop = await db.collection("sqt_shops").findOne({ _id: theCase.shopId });
    if (!shop) {
      return res.status(404).json({ success: false, message: "Shop not found" });
    }
    const customerId = shop.externalIds && shop.externalIds.zohoId;
    if (!customerId) {
      return res.status(400).json({
        success: false,
        message: `Shop "${shop.storeName}" has no Zoho ID configured`,
      });
    }

    // Build notes from whatever identifiers exist (skip empty parts)
    const noteSegments = [];
    if (theCase.caseId) noteSegments.push(`Case ID: ${theCase.caseId}`);
    if (theCase.serviceRequestId)
      noteSegments.push(`Service ID: ${theCase.serviceRequestId}`);
    const notes = noteSegments.join(" | ") || null;

    const customFields = [
      {
        customfield_id: ZOHO_CUSTOMFIELD_CASE_ID,
        index: 3,
        label: "TE Case ID",
        value: theCase.caseId || "",
      },
      {
        customfield_id: ZOHO_CUSTOMFIELD_TICKET_ID,
        index: 4,
        label: "TE Ticket ID",
        value: theCase.repairDeskTicketId || "",
      },
    ];

    const requestBody = {
      customer_id: customerId,
      date: new Date().toISOString().split("T")[0],
      line_items: lineItems,
      pricebook_id: ZOHO_PRICEBOOK_ID_WHOLESALE,
      notes,
      template_id: ZOHO_TEMPLATE_ID,
      custom_fields: customFields,
    };

    const zohoUrl = `https://www.zohoapis.com/inventory/v1/salesorders?organization_id=${ZOHO_ORG_ID}`;
    const zohoResp = await handleZohoInventoryPostRequest(zohoUrl, requestBody);

    if (!zohoResp || zohoResp.code !== 0 || !zohoResp.salesorder) {
      const msg =
        (zohoResp && zohoResp.message) ||
        "Zoho Inventory did not accept the order";
      console.error("Zoho SO create failed:", zohoResp);
      return res
        .status(502)
        .json({ success: false, message: `Zoho: ${msg}`, data: zohoResp || null });
    }

    const so = zohoResp.salesorder;

    // Build the zohoOrders entry per the schema design — match Zoho's returned
    // line_items back to the products we sent so we keep the original names/SKUs
    // even if Zoho's lookup returns different values.
    const productsByItemId = {};
    for (const p of products) {
      if (p && p.product_id) productsByItemId[String(p.product_id)] = p;
    }
    const orderLineItems = (so.line_items || []).map((li) => {
      const sent = productsByItemId[String(li.item_id)];
      return {
        partName: li.name || (sent && sent.name) || "",
        sku: li.sku || (sent && sent.sku) || "",
        unitPrice: Number(li.rate) || 0,
        quantitySent: Number(li.quantity) || 1,
        quantityUsed: 0,
        quantityReturned: 0,
      };
    });

    const now = new Date();
    const orderEntry = {
      zohoSalesOrderId: so.salesorder_id,
      zohoSalesOrderNumber: so.salesorder_number,
      orderedAt: now,
      receivedAt: null,
      trackingNumber: null,
      notes: null,
      lineItems: orderLineItems,
    };

    const statusEntry = {
      status: "waiting-for-parts",
      at: now,
      updatedBy: (req.body && req.body.updatedBy) || "Admin",
      note: `Parts dispatched — Zoho SO ${so.salesorder_number}`,
    };

    const updateResult = await collection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: { status: "waiting-for-parts", updatedAt: now },
        $push: {
          zohoOrders: orderEntry,
          statusHistory: statusEntry,
        },
      },
      { returnDocument: "after" },
    );

    const updatedCase = updateResult.value || updateResult;
    return res.json({
      success: true,
      message: `Sales order ${so.salesorder_number} created`,
      data: {
        case: updatedCase,
        salesOrderId: so.salesorder_id,
        salesOrderNumber: so.salesorder_number,
      },
    });
  } catch (error) {
    console.error("Send parts error:", error);
    return res
      .status(500)
      .json({ success: false, message: `Failed to send parts: ${error.message || error}` });
  }
});

router.post("/:id/markRepaired", async function (req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid case id" });
    }

    const collected = !!(req.body && req.body.collected);
    const usage = Array.isArray(req.body && req.body.usage) ? req.body.usage : [];
    const newStatus = collected ? "repaired-and-collected" : "repaired";

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const theCase = await collection.findOne({ _id: new ObjectId(id) });
    if (!theCase) {
      return res.status(404).json({ success: false, message: "Case not found" });
    }

    // Apply usage updates onto a clone of zohoOrders, then save the whole array back.
    // Addressing each line item by (zohoSalesOrderId, lineItemIdx) keeps the update
    // robust even if the array order changes between client load and submit.
    const orders = Array.isArray(theCase.zohoOrders)
      ? JSON.parse(JSON.stringify(theCase.zohoOrders))
      : [];
    let usedCount = 0;
    for (const u of usage) {
      if (!u || !u.zohoSalesOrderId) continue;
      const order = orders.find((o) => o.zohoSalesOrderId === u.zohoSalesOrderId);
      if (!order || !Array.isArray(order.lineItems)) continue;
      const li = order.lineItems[u.lineItemIdx];
      if (!li) continue;
      const qty = Math.max(0, Number(u.quantityUsed) || 0);
      li.quantityUsed = qty;
      if (qty > 0) usedCount += 1;
    }

    const now = new Date();
    const statusEntry = {
      status: newStatus,
      at: now,
      updatedBy: (req.body && req.body.updatedBy) || "Admin",
      note: collected
        ? `Repair complete — device collected; ${usedCount} part(s) used`
        : `Repair complete — awaiting pickup; ${usedCount} part(s) used`,
    };

    const result = await collection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: { status: newStatus, updatedAt: now, zohoOrders: orders },
        $push: { statusHistory: statusEntry },
      },
      { returnDocument: "after" },
    );

    const updated = result.value || result;
    if (!updated) {
      return res.status(404).json({ success: false, message: "Case not found" });
    }
    return res.json({ success: true, message: `Status updated to ${newStatus}`, data: updated });
  } catch (error) {
    console.error("Mark repaired error:", error);
    return res
      .status(500)
      .json({ success: false, message: `Failed to mark repaired: ${error.message || error}` });
  }
});

router.post("/:id/partsReceived", async function (req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid case id" });
    }

    const customerNotified = !!(req.body && req.body.customerNotified);
    const newStatus = customerNotified ? "waiting-for-drop-off" : "parts-arrived";

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const theCase = await collection.findOne({ _id: new ObjectId(id) });
    if (!theCase) {
      return res.status(404).json({ success: false, message: "Case not found" });
    }

    // Count how many orders we'll mark received (for the status note)
    const ordersToMark = (Array.isArray(theCase.zohoOrders) ? theCase.zohoOrders : [])
      .filter((o) => !o || !o.receivedAt).length;

    const now = new Date();
    const noteParts = [
      ordersToMark > 0
        ? `${ordersToMark} order${ordersToMark === 1 ? "" : "s"} marked received`
        : "No outstanding orders",
      customerNotified ? "customer notified for drop-off" : "customer not yet notified",
    ];
    if (req.body && req.body.note) noteParts.push(req.body.note);

    const statusEntry = {
      status: newStatus,
      at: now,
      updatedBy: (req.body && req.body.updatedBy) || "Admin",
      note: noteParts.join(" — "),
    };

    const result = await collection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: {
          status: newStatus,
          updatedAt: now,
          // Mark all orders that don't yet have a receivedAt — `$[order]` with
          // an arrayFilter so we don't overwrite any already-received timestamp.
          "zohoOrders.$[order].receivedAt": now,
        },
        $push: { statusHistory: statusEntry },
      },
      {
        returnDocument: "after",
        // Match orders where receivedAt is null OR the field is missing entirely
        arrayFilters: [
          {
            $or: [
              { "order.receivedAt": null },
              { "order.receivedAt": { $exists: false } },
            ],
          },
        ],
      },
    );

    const updated = result.value || result;
    if (!updated) {
      return res.status(404).json({ success: false, message: "Case not found" });
    }
    return res.json({
      success: true,
      message: `Status updated to ${newStatus}`,
      data: updated,
    });
  } catch (error) {
    console.error("Parts received error:", error);
    return res
      .status(500)
      .json({ success: false, message: `Failed to mark parts received: ${error.message || error}` });
  }
});

router.put("/:id/device", async function (req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid case id" });
    }

    // Only allow a defined whitelist of device fields, partial update style
    const allowed = ["description", "imei", "brand", "category", "purchasePrice", "purchaseDate"];
    const setOps = {};
    for (const f of allowed) {
      if (req.body[f] !== undefined) {
        if (f === "purchasePrice") {
          setOps[`device.${f}`] =
            req.body[f] === null || req.body[f] === "" ? null : Number(req.body[f]);
        } else if (f === "purchaseDate") {
          setOps[`device.${f}`] = toDateOrNull(req.body[f]);
        } else if (f === "imei") {
          setOps[`device.${f}`] = req.body[f] ? String(req.body[f]).trim() : null;
        } else {
          setOps[`device.${f}`] = req.body[f] || null;
        }
      }
    }

    // modelId update needs to resolve modelName as well
    if (req.body.modelId !== undefined) {
      if (req.body.modelId) {
        const db = await connectToDatabase();
        const model = await resolveModel(db, req.body.modelId);
        if (!model) {
          return res.status(404).json({ success: false, message: "Model not found" });
        }
        setOps["device.modelId"] = model._id;
        setOps["device.modelName"] = model.name;
      } else {
        setOps["device.modelId"] = null;
        setOps["device.modelName"] = null;
      }
    }

    if (Object.keys(setOps).length === 0) {
      return res.status(400).json({ success: false, message: "No device fields to update" });
    }

    setOps.updatedAt = new Date();

    const db = await connectToDatabase();
    const result = await db.collection(COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: setOps },
      { returnDocument: "after" },
    );

    const updated = result.value || result;
    if (!updated) {
      return res.status(404).json({ success: false, message: "Case not found" });
    }
    return res.json({ success: true, message: "Device info updated", data: updated });
  } catch (error) {
    console.error("Update device error:", error);
    return res.status(500).json({ success: false, message: "Failed to update device info" });
  }
});

router.post("/:id/notes", async function (req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid case id" });
    }

    const text = req.body && req.body.text ? String(req.body.text).trim() : "";
    if (!text) {
      return res.status(400).json({ success: false, message: "Note text is required" });
    }

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const note = {
      text,
      at: new Date(),
      addedBy: req.body.addedBy ? String(req.body.addedBy).trim() : "Admin",
    };

    const result = await collection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $push: { notes: note }, $set: { updatedAt: note.at } },
      { returnDocument: "after" },
    );

    const updated = result.value || result;
    if (!updated) {
      return res.status(404).json({ success: false, message: "Case not found" });
    }
    return res.json({ success: true, message: "Note added", data: updated });
  } catch (error) {
    console.error("Add note error:", error);
    return res.status(500).json({ success: false, message: "Failed to add note" });
  }
});

router.post("/delete", async function (req, res, next) {
  try {
    const { id } = req.body;
    if (!id || !ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid case id" });
    }
    const db = await connectToDatabase();
    const result = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Case not found" });
    }
    return res.json({ success: true, message: "Case deleted" });
  } catch (error) {
    console.error("Delete case error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete case" });
  }
});

module.exports = router;

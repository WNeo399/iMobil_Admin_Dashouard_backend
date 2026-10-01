// Zoho Campaigns API client (v1.1) for the Campaign page (iMobile Website)
// and the agent endpoint. Uses the backend's one Zoho login — the token from
// utils/zohoRequest, whose scopes include ZohoCampaigns.campaign/contact.ALL.
//
// What Zoho requires (learnt on the first test sends, 2026-10-01):
//   · campaign content only from a PUBLIC URL (content_url) — see
//     utils/campaignContent, which hosts it on S3;
//   · topic management is on, so every campaign names a topic (topicId);
//   · only contacts whose Subscription Type is Marketing receive a campaign —
//     a list of only non-marketing contacts fails with code 6606;
//   · campaign names can't hold special characters such as "$[";
//   · deletecampaign is a GET; the API has no preheader or header/footer
//     theme setting (those exist only in Zoho's editor).
// Rate limit: 500 calls / 5 minutes per account.

const axios = require("axios");
const { refreshToken } = require("./zohoRequest");

const BASE = "https://campaigns.zoho.com/api/v1.1";

const isTokenError = (status, d) =>
  status === 401 || /INVALID_(OAUTH)?TOKEN|invalid.*token|1007/i.test(JSON.stringify(d || "").slice(0, 300));

async function call(method, path, params) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await refreshToken(attempt > 0);
    if (!token) throw new Error("Zoho login unavailable");
    const headers = { Authorization: `Zoho-oauthtoken ${token}` };
    const r =
      method === "GET"
        ? await axios.get(`${BASE}${path}`, { headers, params, validateStatus: () => true, timeout: 60000 })
        : await axios.post(`${BASE}${path}`, new URLSearchParams(params).toString(), {
          headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
          validateStatus: () => true,
          timeout: 60000,
        });
    if (attempt === 0 && isTokenError(r.status, r.data)) continue;
    return r.data;
  }
  throw new Error("Zoho login unavailable");
}

// A Zoho error as one readable line.
function zohoError(d, fallback) {
  const r = (d && d.response) || d || {};
  const msg = r.message || r.error || r.Code || r.code;
  const code = r.code || r.Code;
  if (String(code) === "6606") {
    return "None of the chosen list's contacts can receive marketing email (their Subscription Type isn't Marketing, or they're not in the campaign's topic)";
  }
  return msg ? `${fallback}: ${msg}${code && msg !== code ? ` (code ${code})` : ""}` : fallback;
}

// Zoho rejects special characters in campaign names.
function safeName(name) {
  return String(name || "Campaign").replace(/[^\p{L}\p{N} \-–()+,.&_'/:]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Campaign";
}

async function mailingLists() {
  const out = [];
  for (let from = 1; from < 5000; from += 100) {
    const d = await call("GET", "/getmailinglists", { resfmt: "JSON", sort: "asc", fromindex: from, range: 100 });
    const page = (d && d.list_of_details) || [];
    out.push(...page);
    if (page.length < 100) break;
  }
  return out.map((l) => ({ key: String(l.listkey), name: l.listname, contacts: Number(l.noofcontacts) || 0, createdAt: l.date || null }));
}

async function topics() {
  const d = await call("GET", "/topics", { details: "{from_index:0,range:100}" });
  return ((d && d.topicDetails) || []).map((t) => ({ id: String(t.topicId), name: t.topicName }));
}

async function listContacts(listKey, max = 50) {
  const d = await call("GET", "/getlistsubscribers", { resfmt: "JSON", listkey: listKey, sort: "asc", fromindex: 1, range: Math.min(max, 200), status: "active" });
  return ((d && d.list_of_details) || []).map((s) => String(s.contact_email || "").toLowerCase());
}

// → campaign key; throws a readable error.
async function createCampaign({ name, subject, fromEmail, fromName, contentUrl, listKeys, topicId }) {
  const params = {
    resfmt: "JSON",
    campaignname: safeName(name),
    from_email: fromEmail,
    from_name: fromName || "",
    subject,
    content_url: contentUrl,
    list_details: JSON.stringify(Object.fromEntries(listKeys.map((k) => [k, []]))),
  };
  if (topicId) params.topicId = topicId;
  const d = await call("POST", "/createCampaign", params);
  const key = d && (d.campaignKey || d.campaignkey || (d.response && (d.response.campaignKey || d.response.campaignkey)));
  if (!key) throw new Error(zohoError(d, "Zoho didn't create the campaign"));
  return String(key);
}

async function sendCampaign(campaignKey) {
  const d = await call("POST", "/sendcampaign", { resfmt: "JSON", campaignkey: campaignKey });
  const r = (d && d.response) || d || {};
  if (String(r.code) !== "200" && r.status !== "success") throw new Error(zohoError(d, "Zoho didn't send the campaign"));
  return { status: r.campaign_status || "InProgress" };
}

async function deleteCampaign(campaignKey) {
  const d = await call("GET", "/deletecampaign", { resfmt: "JSON", campaignkey: campaignKey });
  return d && d.status === "success";
}

async function campaignDetails(campaignKey) {
  const d = await call("GET", "/getcampaigndetails", { resfmt: "JSON", campaignkey: campaignKey, campaigntype: "normal" });
  const c = ((d && d["campaign-details"]) || [])[0] || {};
  let preview = c.campaign_preview || "";
  if (preview && !/^https?:/i.test(preview)) preview = `https://${preview}`;
  return { status: d && d.campaign_status, name: c.campaign_name, subject: c.email_subject, sentAt: c.sent_date_string || null, preview, topic: c.topic_name || "" };
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function campaignReport(campaignKey) {
  const d = await call("GET", "/campaignreports", { resfmt: "JSON", campaignkey: campaignKey });
  const x = ((d && d["campaign-reports"]) || [])[0];
  if (!x) throw new Error(zohoError(d, "No report from Zoho yet"));
  const det = ((d && d["campaign-details"]) || [])[0] || {};
  return {
    sent: num(x.emails_sent_count),
    delivered: num(x.delivered_count),
    deliveredPct: num(x.delivered_percent),
    opens: num(x.opens_count),
    openPct: num(x.open_percent),
    uniqueClicks: num(x.unique_clicks_count),
    clickPct: num(x.unique_clicked_percent),
    clicksPerOpen: num(x.clicksperopenrate),
    bounces: num(x.bounces_count) || num(x.hardbounce_count) + num(x.softbounce_count),
    hardBounces: num(x.hardbounce_count),
    softBounces: num(x.softbounce_count),
    bouncePct: num(x.bounce_percent),
    unsubscribes: num(x.unsub_count),
    unsubscribePct: num(x.unsubscribe_percent),
    spam: num(x.spams_count),
    complaints: num(x.complaints_count),
    forwards: num(x.forwards_count),
    unopened: num(x.unopened),
    unsent: num(x.unsent_count),
    sentTime: det.sent_time || null,
  };
}

const RECIPIENT_ACTIONS = ["sentcontacts", "openedcontacts", "unopenedcontacts", "clickedcontacts", "optoutcontacts", "spamcontacts", "senthardbounce", "sentsoftbounce", "unsentcontacts"];

async function recipients(campaignKey, action, fromIndex = 1, range = 50) {
  if (!RECIPIENT_ACTIONS.includes(action)) throw new Error("Unknown recipient group");
  const d = await call("POST", "/getcampaignrecipientsdata", { resfmt: "JSON", campaignkey: campaignKey, action, fromindex: String(fromIndex), range: String(range) });
  const list = (d && d.list_of_details) || [];
  return (Array.isArray(list) ? list : []).map((r) => ({
    email: r.contactemailaddress || r.contact_email || r.email || "",
    firstName: r.firstname || r.first_name || "",
    lastName: r.lastname || r.last_name || "",
    company: r.companyname || r.company || "",
    at: r.sentdate || r.sent_time || r.actiondate || "",
  }));
}

// Campaigns in Zoho, newest first (includes ones sent from Zoho itself).
async function recentCampaigns(range = 50) {
  const d = await call("GET", "/recentcampaigns", { resfmt: "JSON", fromindex: 1, range });
  const list = (d && (d.recent_campaigns || d.recentcampaigns)) || [];
  return list.map((c) => ({
    key: String(c.campaign_key),
    name: c.campaign_name,
    status: c.campaign_status,
    sentAt: c.sent_date_string || c.sent_time || null,
    createdAt: c.created_date_string || c.created_time || null,
    subject: c.email_subject || c.subject || "",
  }));
}

module.exports = {
  mailingLists, topics, listContacts, createCampaign, sendCampaign, deleteCampaign,
  campaignDetails, campaignReport, recipients, recentCampaigns, safeName, RECIPIENT_ACTIONS,
};

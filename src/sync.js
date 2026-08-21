/**
 * Tally Connector - Core Sync Engine v2.0 (AJEMS JSON Builder API)
 *
 * Key features:
 *  - Per-account configuration: API base URL + 8 form IDs editable in Settings
 *  - Label-based field auto-discovery: field keys are fetched from each form's
 *    GET response (labels map), so the app works with ANY AJEMS account as long
 *    as the form field labels follow the standard naming.
 *  - GET-based deduplication/upsert, multi-company sync, incremental fallback.
 */

const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");
const { XMLParser } = require("fast-xml-parser");

/* ============ ENTITY FIELD DEFINITIONS (label → value) ============ */
/* Labels must match the field labels in the AJEMS forms exactly.     */
const ENTITY_FIELDS = {
  companies: {
    guidLabel: "Company Guid",
    alterLabel: "Last Alter Id",
    fields: (r) => ({
      "Id": r.tally_guid,
      "Client Id": "",
      "Company Name": r.company_name,
      "Company Guid": r.company_guid,
      "Api Key": "",
      "Last Alter Id": r.last_alter_id,
      "Last Sync At": r.last_sync_at,
      "Status": r.status,
      "Sync Frequency": "Manual only",
      "Auto Sync": true,
      "Created At": r.created_at || new Date().toISOString(),
    }),
  },
  ledger_groups: {
    guidLabel: "Tally Guid",
    alterLabel: "Alter Id",
    fields: (r) => ({
      "Id": r.tally_guid,
      "Company Id": r.company_name,
      "Tally Guid": r.tally_guid,
      "Name": r.name,
      "Parent Group Id": r.parent_group_name,
      "Is Revenue": r.is_revenue,
      "Is Deemed Positive": r.is_deemed_positive,
      "Alter Id": r.alter_id,
      "Sort Position": r.sort_position,
      "Synced At": new Date().toISOString(),
    }),
  },
  ledgers: {
    guidLabel: "Tally Guid",
    alterLabel: "Alter Id",
    fields: (r) => ({
      "Id": r.tally_guid,
      "Company Id": r.company_name,
      "Tally Guid": r.tally_guid,
      "Name": r.name,
      "Group Id": r.group_name,
      "Opening Balance": r.opening_balance,
      "Closing Balance": r.closing_balance,
      "Is Billwise": r.is_billwise,
      "Mobile": r.mobile,
      "Email": r.email,
      "Gstin": r.gstin,
      "State": r.state,
      "Credit Limit": r.credit_limit,
      "Credit Period Days": r.credit_period_days,
      "Alter Id": r.alter_id,
      "Synced At": new Date().toISOString(),
    }),
  },
  vouchers: {
    guidLabel: "Tally Guid",
    alterLabel: "Alter Id",
    fields: (r) => ({
      "Id": r.tally_guid,
      "Company Id": r.company_name,
      "Tally Guid": r.tally_guid,
      "Voucher Type": r.voucher_type,
      "Voucher Number": r.voucher_number,
      "Voucher Date": r.voucher_date,
      "Party Ledger Id": "",
      "Party Ledger Name": r.party_ledger_name,
      "Amount": r.amount,
      "Narration": r.narration,
      "Reference": r.reference,
      "Is Cancelled": r.is_cancelled,
      "Alter Id": r.alter_id,
      "Synced At": new Date().toISOString(),
    }),
  },
  voucher_entries: {
    guidLabel: "Id",
    alterLabel: null,
    fields: (r) => ({
      "Id": r.entry_guid,
      "Voucher Id": r.voucher_guid,
      "Ledger Id": "",
      "Ledger Name": r.ledger_name,
      "Amount": r.amount,
      "Is Debit": r.is_debit,
    }),
  },
  voucher_items: {
    guidLabel: "Id",
    alterLabel: null,
    fields: (r) => ({
      "Id": r.item_guid,
      "Voucher Id": r.voucher_guid,
      "Stock Item Name": r.stock_item_name,
      "Qty": r.qty,
      "Rate": r.rate,
      "Amount": r.amount,
      "Gst Rate": r.gst_rate,
      "Hsn Code": r.hsn_code,
    }),
  },
  outstanding: {
    guidLabel: "Id",
    alterLabel: null,
    fields: (r) => ({
      "Id": r.tally_guid,
      "Company Id": r.company_name,
      "Ledger Id": r.ledger_name,
      "Type": r.type === "receivable",
      "Bill Ref": r.bill_ref,
      "Bill Date": r.bill_date,
      "Due Date": r.due_date,
      "Pending Amount": r.pending_amount,
      "Days Overdue": "",
      "Synced At": new Date().toISOString(),
    }),
  },
  sync_logs: {
    guidLabel: null,
    alterLabel: null,
    fields: (r) => ({
      "Id": "log-" + Date.now(),
      "Company Id": r.company_name,
      "Entity": r.entity,
      "Sync Type": r.sync_type,
      "Records Created": r.records_created,
      "Records Updated": r.records_updated,
      "From Alter Id": r.from_alter_id || 0,
      "To Alter Id": r.to_alter_id || 0,
      "Status": r.status,
      "Error Message": r.error_message || "",
      "Created At": new Date().toISOString(),
    }),
  },
};

/* ============ CONFIG / STATE ============ */
const DEFAULT_CONFIG = {
  tallyUrl: "http://localhost:9000",
  companyName: "",
  // AJEMS JSON Builder connection (set via Connect)
  tenantUrl: "",
  apiBase: "",
  secretKey: "",
  // Per-form Responses API URLs - auto-filled by Connect, editable in Settings
  formUrls: {
    companies: "", ledger_groups: "", ledgers: "", vouchers: "",
    voucher_entries: "", voucher_items: "", outstanding: "", sync_logs: "",
  },
  verboseLog: false,
  // Background behaviour
  startWithWindows: false,
  syncDaily: false,
  autoSyncTime: "09:00",
  syncOnTallyStart: false,
  syncEveryMinutes: 30,
  lastSyncAt: 0,
  notifyOnSync: true,
  lastAutoSyncDate: "",
  postDelayMs: 120,
};

const ENTITY_TITLES = {
  companies: "Tally Companies",
  ledger_groups: "Tally Ledger Groups",
  ledgers: "Tally Ledgers",
  vouchers: "Tally Vouchers",
  voucher_entries: "Tally Voucher Entries",
  voucher_items: "Tally Voucher Items",
  outstanding: "Tally Outstanding",
  sync_logs: "Tally Sync Logs",
};

function ajemsHeaders(cfg) {
  const h = { "Content-Type": "application/json" };
  if (cfg.secretKey) h["X-Json-Builder-Secret-Key"] = cfg.secretKey;
  return h;
}

function canUpdate(cfg) { return !!cfg.secretKey; }

function dataDir() {
  const dir = app ? app.getPath("userData") : __dirname;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
/* Credentials live in memory for the session unless the user ticks
   "Remember on this computer". The app therefore starts blank by default. */
/* Configuration is stored at %APPDATA%/tally-connector/config.json.
   A fresh install starts empty; "Disconnect" clears the saved credentials. */
const CREDENTIAL_KEYS = ["tenantUrl", "apiBase", "secretKey", "formUrls"];

let cfgCache = null, cfgCacheMtime = 0;

function loadConfig() {
  const file = path.join(dataDir(), "config.json");
  try {
    // Re-read only when the file actually changed - loadConfig runs on timers
    const mtime = fs.statSync(file).mtimeMs;
    if (cfgCache && mtime === cfgCacheMtime) return { ...cfgCache, formUrls: { ...cfgCache.formUrls } };
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const merged = { ...DEFAULT_CONFIG, ...saved, formUrls: { ...DEFAULT_CONFIG.formUrls, ...(saved.formUrls || {}) } };
    if (saved.secretKeyEnc) {
      try {
        merged.secretKey = safeStorage && safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(saved.secretKeyEnc, "base64"))
          : "";
      } catch {
        merged.secretKey = "";   // encrypted on a different machine or user account
      }
      delete merged.secretKeyEnc;
    }
    cfgCache = merged;
    cfgCacheMtime = mtime;
    return { ...merged, formUrls: { ...merged.formUrls } };
  } catch {
    cfgCache = null;
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

/* The secret key is encrypted with the OS keystore (DPAPI on Windows) before it
   touches the disk, so a copied config.json is useless on any other machine. */
function saveConfig(cfg) {
  const onDisk = { ...cfg };
  const key = onDisk.secretKey || "";
  delete onDisk.secretKey;
  delete onDisk.secretKeyEnc;

  if (key) {
    try {
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        onDisk.secretKeyEnc = safeStorage.encryptString(key).toString("base64");
      } else {
        onDisk.secretKey = key;   // no keystore available - store as-is
      }
    } catch {
      onDisk.secretKey = key;
    }
  }
  fs.writeFileSync(path.join(dataDir(), "config.json"), JSON.stringify(onDisk, null, 2));
  cfgCache = null;   // force a fresh read next time
}

function accountKey(cfg) {
  // Identify the AJEMS account by its form URLs so each account keeps its own sync state
  const s = ((cfg.formUrls && cfg.formUrls.companies) || "default");
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return "acct" + Math.abs(h).toString(36);
}
function statePath(cfg) { return path.join(dataDir(), `sync-state-${accountKey(cfg)}.json`); }
function loadState(cfg) {
  try { return JSON.parse(fs.readFileSync(statePath(cfg), "utf8")); }
  catch { return { masters_alter: {}, synced_voucher_guids: {} }; }
}
function saveState(cfg, s) { fs.writeFileSync(statePath(cfg), JSON.stringify(s, null, 2)); }
/** Clear the saved workspace credentials and linked URLs from this machine */
function disconnect() {
  const cfg = loadConfig();
  for (const k of CREDENTIAL_KEYS) delete cfg[k];
  delete cfg.secretKeyEnc;
  cfg.formUrls = { ...DEFAULT_CONFIG.formUrls };
  saveConfig(cfg);
  return true;
}



/* ============ HELPERS ============ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run tasks with a small amount of parallelism - faster than one-at-a-time,
 *  gentle enough not to overwhelm the AJEMS API. */
async function runPooled(items, worker, limit = 3) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(workers);
}
const num = (v) => { const x = parseFloat(String(v ?? "").trim().replace(/,/g, "").replace(/[^\d.\-]/g, "")); return isNaN(x) ? 0 : x; };
const yn = (v) => String(v ?? "").trim().toLowerCase() === "yes";
const txt = (v) => (v === undefined || v === null ? "" : String(v).trim());
const tdate = (v) => { const s = txt(v); return s.length === 8 ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : ""; };
const arr = (v) => (!v ? [] : Array.isArray(v) ? v : [v]);
/** Vouchers are fetched from the start of the current Indian financial year (1 April) */
const fyStart = () => {
  const d = new Date();
  const y = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}0401`;
};
const today = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`; };
const formUrl = (cfg, entity) => {
  let u = ((cfg.formUrls && cfg.formUrls[entity]) || "").trim();
  if (u && !u.endsWith("/")) u += "/";
  return u;
};

/* ============ GLOBAL FIELD IDS (AJEMS universal Tally workflow - constant across accounts) ============ */
const GLOBAL_FIELD_KEYS = {
  companies: {
    "Id": "text_20260717090211_00001",
    "Client Id": "text_20260717090211_00002",
    "Company Name": "text_20260717090211_00003",
    "Company Guid": "text_20260717090211_00004",
    "Api Key": "text_20260717090211_00005",
    "Last Alter Id": "number_20260717090211_00006",
    "Last Sync At": "text_20260717090211_00007",
    "Status": "text_20260717090211_00008",
    "Sync Frequency": "dropdown_20260717090211_00009",
    "Auto Sync": "checkbox_20260717090211_00010",
    "Created At": "text_20260717090211_00011",
  },
  ledger_groups: {
    "Id": "text_20260717090211_00012",
    "Company Id": "text_20260717090211_00013",
    "Tally Guid": "text_20260717090211_00014",
    "Name": "text_20260717090211_00015",
    "Parent Group Id": "text_20260717090211_00016",
    "Is Revenue": "checkbox_20260717090211_00017",
    "Is Deemed Positive": "checkbox_20260717090211_00018",
    "Alter Id": "number_20260717090211_00019",
    "Sort Position": "number_20260717090211_00020",
    "Synced At": "text_20260717090211_00021",
  },
  ledgers: {
    "Id": "text_20260717090211_00022",
    "Company Id": "text_20260717090211_00023",
    "Tally Guid": "text_20260717090211_00024",
    "Name": "text_20260717090211_00025",
    "Group Id": "text_20260717090211_00026",
    "Opening Balance": "number_20260717090211_00027",
    "Closing Balance": "number_20260717090211_00028",
    "Is Billwise": "checkbox_20260717090211_00029",
    "Mobile": "text_20260717090211_00030",
    "Email": "text_20260717090211_00031",
    "Gstin": "text_20260717090211_00032",
    "State": "text_20260717090211_00033",
    "Credit Limit": "number_20260717090211_00034",
    "Credit Period Days": "number_20260717090211_00035",
    "Alter Id": "number_20260717090211_00036",
    "Synced At": "text_20260717090211_00037",
  },
  vouchers: {
    "Id": "text_20260717090211_00038",
    "Company Id": "text_20260717090211_00039",
    "Tally Guid": "text_20260717090211_00040",
    "Voucher Type": "text_20260717090211_00041",
    "Voucher Number": "text_20260717090211_00042",
    "Voucher Date": "text_20260717090211_00043",
    "Party Ledger Id": "text_20260717090211_00044",
    "Party Ledger Name": "text_20260717090211_00045",
    "Amount": "number_20260717090211_00046",
    "Narration": "text_20260717090211_00047",
    "Reference": "text_20260717090211_00048",
    "Is Cancelled": "checkbox_20260717090211_00049",
    "Alter Id": "number_20260717090211_00050",
    "Synced At": "text_20260717090211_00051",
  },
  voucher_entries: {
    "Id": "text_20260717090211_00052",
    "Voucher Id": "text_20260717090211_00053",
    "Ledger Id": "text_20260717090211_00054",
    "Ledger Name": "text_20260717090211_00055",
    "Amount": "number_20260717090211_00056",
    "Is Debit": "checkbox_20260717090211_00057",
  },
  voucher_items: {
    "Id": "text_20260717090211_00058",
    "Voucher Id": "text_20260717090211_00059",
    "Stock Item Name": "text_20260717090211_00060",
    "Qty": "number_20260717090211_00061",
    "Rate": "number_20260717090211_00062",
    "Amount": "number_20260717090211_00063",
    "Gst Rate": "number_20260717090211_00064",
    "Hsn Code": "text_20260717090211_00065",
  },
  outstanding: {
    "Id": "text_20260717090211_00066",
    "Company Id": "text_20260717090211_00067",
    "Ledger Id": "text_20260717090211_00068",
    "Type": "checkbox_20260717090211_00069",
    "Bill Ref": "text_20260717090211_00070",
    "Bill Date": "date_20260717090211_00071",
    "Due Date": "date_20260717090211_00072",
    "Pending Amount": "number_20260717090211_00073",
    "Days Overdue": "text_20260717090211_00074",
    "Synced At": "text_20260717090211_00075",
  },
  sync_logs: {
    "Id": "text_20260717090211_00076",
    "Company Id": "text_20260717090211_00077",
    "Entity": "text_20260717090211_00078",
    "Sync Type": "text_20260717090211_00079",
    "Records Created": "number_20260717090211_00080",
    "Records Updated": "number_20260717090211_00081",
    "From Alter Id": "number_20260717090211_00082",
    "To Alter Id": "number_20260717090211_00083",
    "Status": "text_20260717090211_00084",
    "Error Message": "text_20260717090211_00085",
    "Created At": "text_20260717090211_00086",
  },
};

/* ============ FIELD KEY AUTO-DISCOVERY ============ */
/* labelMaps[entity] = { "Name": "text_xxx_00025", ... }  (label → field key) */
const labelMaps = {};

async function discoverFields(cfg, log) {
  log("Resolving form fields...");
  const entities = Object.keys(ENTITY_FIELDS);

  // Clear any maps left over from a previously connected workspace
  for (const e of entities) delete labelMaps[e];

  const results = await Promise.all(entities.map(async (entity) => {
    try {
      const res = await axios.get(formUrl(cfg, entity), { headers: ajemsHeaders(cfg), timeout: 30000 });
      // Start from the global workflow keys so a partial or empty reply still works,
      // then let anything the account actually reports win.
      const map = { ...GLOBAL_FIELD_KEYS[entity] };
      for (const [key, label] of Object.entries(res.data?.labels || {})) map[txt(label)] = key;
      labelMaps[entity] = map;
      return true;
    } catch (err) {
      labelMaps[entity] = { ...GLOBAL_FIELD_KEYS[entity] };
      detailLog(`   ${entity}: live discovery unavailable (${err.response ? "HTTP " + err.response.status : err.message}) - using global workflow field IDs.`);
      return false;
    }
  }));

  const okCount = results.filter(Boolean).length;
  log(`   ${okCount}/${entities.length} forms discovered`);
  return okCount;
}

function buildPayload(entity, record) {
  const def = ENTITY_FIELDS[entity];
  const map = labelMaps[entity];
  if (!map) return null;
  const logical = def.fields(record);
  const payload = {};
  for (const [label, value] of Object.entries(logical)) {
    const key = map[label];
    if (!key) continue;
    // Strict type coercion - matches AJEMS sample payload exactly:
    // number_* → 42 (Number), checkbox_* → true (Boolean),
    // date_* → "YYYY-MM-DD" (String), text_*/dropdown_* → "Sample text" (String)
    if (key.startsWith("number_")) {
      const n = typeof value === "number" ? value : parseFloat(String(value ?? "").replace(/,/g, ""));
      payload[key] = isNaN(n) ? 0 : n;
    } else if (key.startsWith("checkbox_")) {
      payload[key] = value === true || value === "true" || value === "Yes" || value === "yes" || value === 1;
    } else {
      payload[key] = value === undefined || value === null ? "" : String(value);
    }
  }
  return payload;
}

function keyForLabel(entity, label) {
  return label && labelMaps[entity] ? labelMaps[entity][label] : null;
}

/* ============ TALLY ============ */
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false });

async function tallyRequest(cfg, xmlBody) {
  const res = await axios.post(cfg.tallyUrl, xmlBody, {
    headers: { "Content-Type": "application/xml" }, timeout: 180000,
  });
  const parsed = xmlParser.parse(res.data);
  // keep only enough of the raw reply for diagnostics, not the whole document
  parsed.__raw = String(res.data).slice(0, 500);
  return parsed;
}

const mastersXML = (cfg, withCompany, company) => `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Accounts</REPORTNAME>
<STATICVARIABLES>${withCompany ? `<SVCURRENTCOMPANY>${company || cfg.companyName}</SVCURRENTCOMPANY>` : ""}
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;

const daybookXML = (cfg, withCompany, company) => `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME>
<STATICVARIABLES>${withCompany ? `<SVCURRENTCOMPANY>${company || cfg.companyName}</SVCURRENTCOMPANY>` : ""}
<SVFROMDATE>${fyStart()}</SVFROMDATE><SVTODATE>${today()}</SVTODATE>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;

const voucherRegisterXML = (cfg, withCompany, company) => `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Voucher Register</REPORTNAME>
<STATICVARIABLES>${withCompany ? `<SVCURRENTCOMPANY>${company || cfg.companyName}</SVCURRENTCOMPANY>` : ""}
<SVFROMDATE>${fyStart()}</SVFROMDATE><SVTODATE>${today()}</SVTODATE>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;

const companiesListXML = () => `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Companies</ID></HEADER><BODY><DESC><STATICVARIABLES><SVIsSimpleCompany>No</SVIsSimpleCompany></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes" ISOPTION="No" ISINTERNAL="No" NAME="List of Companies"><TYPE>Company</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

async function getOpenCompanies(cfg, log) {
  try {
    const data = await tallyRequest(cfg, companiesListXML());
    const companies = arr(data?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY)
      .map((co) => txt(co.NAME && co.NAME["#text"] !== undefined ? co.NAME["#text"] : co.NAME))
      .filter(Boolean);
    if (companies.length) {
      log(`Open companies in Tally: ${companies.join(", ")}`);
      return companies;
    }
  } catch (e) {
    log(`Could not fetch company list (${e.message})`);
  }
  if (cfg.companyName) {
    log(`Falling back to configured company: ${cfg.companyName}`);
    return [cfg.companyName];
  }
  return [];
}

async function tallyFetchWithRetry(cfg, xmlFn, label, log, company) {
  let data = await tallyRequest(cfg, xmlFn(cfg, true, company));
  let messages = arr(data?.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE);
  if (messages.length === 0) {
    detailLog(`   ${label}: 0 records with company name - retrying with active company...`);
    data = await tallyRequest(cfg, xmlFn(cfg, false, company));
    messages = arr(data?.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE);
  }
  if (messages.length === 0) {
    detailLog(`   ${label} raw response: ${(data.__raw || "").replace(/\s+/g, " ").slice(0, 300)}`);
  }
  return messages;
}

async function testTally(log) {
  const cfg = loadConfig();
  try {
    const res = await axios.get(cfg.tallyUrl, { timeout: 5000 });
    log && log("Tally: " + String(res.data).replace(/<[^>]+>/g, "").slice(0, 50));
    return { ok: true, url: cfg.tallyUrl };
  } catch (err) {
    return { ok: false, url: cfg.tallyUrl, error: err.message };
  }
}

/* ============ AJEMS I/O ============ */
let detailLog = () => {};   // per-record chatter - only shown when Detailed log is on
const stats = {};
function bump(entity, key) {
  if (!stats[entity]) stats[entity] = { created: 0, updated: 0, skipped: 0, failed: 0 };
  stats[entity][key]++;
}

async function ajemsPost(cfg, entity, record, log) {
  const payload = buildPayload(entity, record);
  if (!payload) { bump(entity, "failed"); return false; }
  try {
    await axios.post(formUrl(cfg, entity), payload, { headers: ajemsHeaders(cfg), timeout: 30000 });
    bump(entity, "created");
    return true;
  } catch (err) {
    bump(entity, "failed");
    const body = err.response ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
    log(`   ❌ ${entity} POST failed: HTTP ${err.response ? err.response.status : "?"} → ${body || "(empty)"}`);
    return false;
  } finally { await sleep(cfg.postDelayMs); }
}

async function ajemsUpdate(cfg, entity, responseId, record, log) {
  if (!canUpdate(cfg)) return false;
  const payload = buildPayload(entity, record);
  if (!payload) { bump(entity, "failed"); return false; }
  // JSON Builder update endpoint: {responses_url}{response_id}/
  const url = formUrl(cfg, entity) + responseId + "/";
  try {
    try { await axios.patch(url, payload, { headers: ajemsHeaders(cfg), timeout: 30000 }); }
    catch (e1) {
      if (e1.response && [404, 405].includes(e1.response.status)) {
        await axios.put(url, payload, { headers: ajemsHeaders(cfg), timeout: 30000 });
      } else throw e1;
    }
    bump(entity, "updated");
    return true;
  } catch (err) {
    bump(entity, "failed");
    log(`   ❌ ${entity} UPDATE failed: ${err.response ? "HTTP " + err.response.status : err.message}`);
    return false;
  } finally { await sleep(cfg.postDelayMs); }
}

async function fetchExistingMap(cfg, entity, log) {
  const def = ENTITY_FIELDS[entity];
  const guidKey = keyForLabel(entity, def.guidLabel);
  if (!guidKey) return null;
  const alterKey = keyForLabel(entity, def.alterLabel);
  try {
    const res = await axios.get(formUrl(cfg, entity), { headers: ajemsHeaders(cfg), timeout: 60000 });
    const responses = arr(res.data?.responses);
    const map = {};
    for (const resp of responses) {
      const rdata = resp.response || {};
      const guid = txt(rdata[guidKey]);
      if (!guid) continue;
      map[guid] = { id: txt(resp._id), alter_id: alterKey ? num(rdata[alterKey]) : -1 };
    }
    log(`   ${entity}: ${Object.keys(map).length} existing records in AJEMS`);
    return map;
  } catch (err) {
    log(`   ${entity} GET failed (${err.response ? "HTTP " + err.response.status : err.message}) - falling back to local incremental mode`);
    return null;
  }
}

async function upsert(cfg, entity, record, existingMap, log) {
  const def = ENTITY_FIELDS[entity];
  if (existingMap && def.guidLabel) {
    const guid = txt(record.tally_guid || record.entry_guid || record.item_guid || record.company_guid);
    const existing = existingMap[guid];
    if (!existing) return await ajemsPost(cfg, entity, record, log);
    const newAlter = record.alter_id !== undefined ? num(record.alter_id) : -1;
    if (existing.alter_id === newAlter || !def.alterLabel) { bump(entity, "skipped"); return true; }
    if (canUpdate(cfg)) return await ajemsUpdate(cfg, entity, existing.id, record, log);
    detailLog(`   ${entity} "${record.name || guid}" has changed but update API is not configured - skipped (avoiding duplicate)`);
    bump(entity, "skipped");
    return true;
  }
  return await ajemsPost(cfg, entity, record, log);
}

/* ============ SYNC: MASTERS ============ */
async function syncMasters(cfg, state, log, company) {
  log(`\n[${company}] Fetching masters from Tally...`);
  const messages = await tallyFetchWithRetry(cfg, mastersXML, "Masters", log, company);
  log(`   ${messages.length} records received`);
  if (messages.length === 0) return 0;

  // These three lookups are independent - fetch them together
  const [groupMap, ledgerMap, compMap] = await Promise.all([
    fetchExistingMap(cfg, "ledger_groups", log),
    fetchExistingMap(cfg, "ledgers", log),
    fetchExistingMap(cfg, "companies", log),
  ]);

  if (!state.masters_alter) state.masters_alter = {};
  const lastAlter = state.masters_alter[company] || 0;
  let maxAlterId = lastAlter;
  let companyGuidPrefix = "";

  // Phase 1 - parse Tally's reply into records (cheap, no network)
  const groups = [], ledgers = [];

  for (const msg of messages) {
    if (msg.GROUP) {
      const g = msg.GROUP;
      const alterId = num(g.ALTERID);
      const guid = txt(g.GUID);
      if (!companyGuidPrefix && guid.includes("-")) companyGuidPrefix = guid.split("-").slice(0, 5).join("-");
      if (alterId > maxAlterId) maxAlterId = alterId;
      if (!groupMap && alterId <= lastAlter) { bump("ledger_groups", "skipped"); continue; }

      groups.push({
        tally_guid: guid,
        name: txt(g["@_NAME"]),
        parent_group_name: txt(g.PARENT),
        is_revenue: yn(g.ISREVENUE),
        is_deemed_positive: yn(g.ISDEEMEDPOSITIVE),
        alter_id: alterId,
        sort_position: num(g.SORTPOSITION),
        company_name: company,
      });
    } else if (msg.LEDGER) {
      const l = msg.LEDGER;
      const alterId = num(l.ALTERID);
      if (alterId > maxAlterId) maxAlterId = alterId;
      if (!ledgerMap && alterId <= lastAlter) { bump("ledgers", "skipped"); continue; }

      ledgers.push({
        tally_guid: txt(l.GUID),
        name: txt(l["@_NAME"]),
        group_name: txt(l.PARENT),
        opening_balance: num(l.OPENINGBALANCE),
        closing_balance: num(l.CLOSINGBALANCE),
        is_billwise: yn(l.ISBILLWISEON),
        mobile: txt(l.LEDGERMOBILE),
        email: txt(l.EMAIL),
        gstin: txt(l.LEDGSTIN || l.PARTYGSTIN),
        state: txt(l.LEDSTATE),
        credit_limit: num(l.CREDITLIMIT),
        credit_period_days: num(l.BILLCREDITPERIOD),
        alter_id: alterId,
        company_name: company,
      });
    }
  }

  // Phase 2 - send them, a few at a time (groups first: ledgers reference them)
  await runPooled(groups, async (rec) => {
    detailLog(`   → group: ${rec.name}`);
    await upsert(cfg, "ledger_groups", rec, groupMap, log);
  });
  await runPooled(ledgers, async (rec) => {
    detailLog(`   → ledger: ${rec.name}`);
    await upsert(cfg, "ledgers", rec, ledgerMap, log);
  });
  const processed = groups.length + ledgers.length;

  await upsert(cfg, "companies", {
    tally_guid: companyGuidPrefix || company,
    company_name: company,
    company_guid: companyGuidPrefix || company,
    last_alter_id: maxAlterId,
    last_sync_at: new Date().toISOString(),
    status: "connected",
    alter_id: maxAlterId,
  }, compMap, log);

  state.masters_alter[company] = maxAlterId;
  return processed;
}

/* ============ SYNC: VOUCHERS ============ */
async function syncVouchers(cfg, state, log, company) {
  log(`\n[${company}] Fetching vouchers (${fyStart()} to ${today()})...`);
  let messages = await tallyFetchWithRetry(cfg, daybookXML, "DayBook", log, company);
  let vouchers = messages.filter((m) => m.VOUCHER).map((m) => m.VOUCHER);
  if (vouchers.length === 0) {
    detailLog("   Day Book returned 0 - trying Voucher Register report...");
    messages = await tallyFetchWithRetry(cfg, voucherRegisterXML, "VoucherRegister", log, company);
    vouchers = messages.filter((m) => m.VOUCHER).map((m) => m.VOUCHER);
  }
  log(`   ${vouchers.length} vouchers received`);
  if (vouchers.length === 0) return 0;

  const vchMap = await fetchExistingMap(cfg, "vouchers", log);
  if (!state.synced_voucher_guids) state.synced_voucher_guids = {};

  let processed = 0;
  for (const v of vouchers) {
    const guid = txt(v.GUID);
    const alterId = num(v.ALTERID);
    if (!vchMap && state.synced_voucher_guids[guid] === alterId) { bump("vouchers", "skipped"); continue; }

    const entries = arr(v["ALLLEDGERENTRIES.LIST"] || v["LEDGERENTRIES.LIST"]);
    const rec = {
      tally_guid: guid,
      voucher_type: txt(v["@_VCHTYPE"] || v.VOUCHERTYPENAME),
      voucher_number: txt(v.VOUCHERNUMBER),
      voucher_date: tdate(v.DATE),
      party_ledger_name: txt(v.PARTYLEDGERNAME),
      narration: txt(v.NARRATION),
      reference: txt(v.REFERENCE),
      is_cancelled: yn(v.ISCANCELLED),
      alter_id: alterId,
      company_name: company,
      amount: 0,
    };
    for (const e of entries) {
      if (txt(e.LEDGERNAME) === rec.party_ledger_name) { rec.amount = Math.abs(num(e.AMOUNT)); break; }
    }
    if (!rec.amount && entries.length) rec.amount = Math.abs(num(entries[0].AMOUNT));

    detailLog(`   → voucher: ${rec.voucher_type} #${rec.voucher_number} (${rec.party_ledger_name})`);
    const isNew = !vchMap || !vchMap[guid];
    await upsert(cfg, "vouchers", rec, vchMap, log);

    // Lines belong to a voucher, so they are only sent when the voucher is new
    if (isNew) {
      await runPooled(entries, (e, i) => ajemsPost(cfg, "voucher_entries", {
        entry_guid: `${guid}-e${i}`,
        voucher_guid: guid,
        ledger_name: txt(e.LEDGERNAME),
        amount: num(e.AMOUNT),
        is_debit: yn(e.ISDEEMEDPOSITIVE),
      }, log));

      const items = arr(v["ALLINVENTORYENTRIES.LIST"] || v["INVENTORYENTRIES.LIST"]);
      await runPooled(items, (it, i) => ajemsPost(cfg, "voucher_items", {
        item_guid: `${guid}-i${i}`,
        voucher_guid: guid,
        stock_item_name: txt(it.STOCKITEMNAME),
        qty: num(it.ACTUALQTY),
        rate: num(it.RATE),
        amount: num(it.AMOUNT),
        gst_rate: num(it.GSTRATE),
        hsn_code: txt(it.GSTHSNCODE),
      }, log));
    }
    state.synced_voucher_guids[guid] = alterId;
    processed++;
  }
  return processed;
}

/* ============ MAIN RUN ============ */
async function runSync(log) {
  const cfg = loadConfig();
  const state = loadState(cfg);
  const started = Date.now();
  Object.keys(stats).forEach((k) => delete stats[k]);
  detailLog = cfg.verboseLog ? log : () => {};

  // Guard: must be connected to an AJEMS workspace first
  if (!cfg.formUrls || !cfg.formUrls.companies) {
    log("❌ Not connected to AJEMS. Enter your Organisation Name and Secret Key, then click Connect.");
    return stats;
  }

  // Step 1: discover field keys for THIS AJEMS account
  await discoverFields(cfg, log);
  log(`Upsert: deduplication ON${canUpdate(cfg) ? " + record updates ENABLED" : " (updates disabled - changed records will be skipped)"}`);

  const companies = await getOpenCompanies(cfg, log);
  if (companies.length === 0) {
    log("❌ No companies found. Open your company in Tally and try again.");
    return stats;
  }

  let errMsg = "";
  for (const company of companies) {
    try { await syncMasters(cfg, state, log, company); }
    catch (e) { errMsg += ` Masters[${company}]: ` + e.message; log("❌ " + e.message); }

    try { await syncVouchers(cfg, state, log, company); }
    catch (e) { errMsg += ` Vouchers[${company}]: ` + e.message; log("❌ Vouchers: " + e.message); }
  }

  saveState(cfg, state);

  const totalCreated = Object.values(stats).reduce((a, s) => a + s.created, 0);
  const totalUpdated = Object.values(stats).reduce((a, s) => a + s.updated, 0);
  const totalFailed = Object.values(stats).reduce((a, s) => a + s.failed, 0);

  await ajemsPost(cfg, "sync_logs", {
    company_name: companies.join(" | "),
    entity: "all",
    sync_type: "upsert",
    records_created: totalCreated,
    records_updated: totalUpdated,
    from_alter_id: 0,
    to_alter_id: 0,
    status: errMsg ? "partial" : totalFailed ? "partial" : "success",
    error_message: errMsg,
  }, log);

  log("\n========== SYNC SUMMARY ==========");
  for (const [entity, s] of Object.entries(stats)) {
    log(`  ${entity.padEnd(16)} new: ${s.created}  upd: ${s.updated}  skip: ${s.skipped}  fail: ${s.failed}`);
  }
  log(`  Time: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  log("==================================");
  log("✅ Done! Check the form responses in AJEMS.");
  return stats;
}

/* ============ CONNECT: AJEMS JSON Builder ============ */
/** Work out this workspace's API base from what the user typed.
 *  Accepts an organisation name - "Acme Corp", "acme corp", "ACMECORP"
 *  all resolve to acmecorp - or a full workspace URL. */
function resolveTenant(input) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, reason: "EMPTY" };

  // Looks like a URL or host? Keep supporting that.
  if (/^https?:\/\//i.test(raw) || /\.[a-z]{2,}(\/|$)/i.test(raw)) {
    let host;
    try { host = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw).host.toLowerCase(); }
    catch { return { ok: false, reason: "MALFORMED" }; }
    host = host.replace(/:\d+$/, "");
    const dash = host.match(/^([a-z0-9][a-z0-9-]*)\.ajems\.in$/);
    if (dash) return { ok: true, org: dash[1], apiBase: `https://${dash[1]}.buildprohub-server.com` };
    const api = host.match(/^([a-z0-9][a-z0-9-]*)\.buildprohub-server\.com$/);
    if (api) return { ok: true, org: api[1], apiBase: `https://${host}` };
    return { ok: false, reason: "UNKNOWN_HOST", host };
  }

  // Organisation name → slug (spaces, case and punctuation ignored)
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (slug.length < 2) return { ok: false, reason: "TOO_SHORT" };
  return { ok: true, org: slug, apiBase: `https://${slug}.buildprohub-server.com` };
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Find every object that looks like an app ({title, forms}) anywhere in the payload */
function collectApps(data) {
  const out = [];
  const seen = new Set();
  const dig = (o) => {
    if (!o || typeof o !== "object" || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) return o.forEach(dig);
    if (o.title && (Array.isArray(o.forms) || o.app_id)) out.push(o);
    Object.values(o).forEach(dig);
  };
  dig(data);
  return out;
}

/** Match a form to an entity: "Tally Companies" / "Companies" / "tally_companies" all work */
function matchForm(forms, entity) {
  const want = norm(ENTITY_TITLES[entity]);          // "tally companies"
  const wantShort = want.replace(/^tally /, "");      // "companies"
  return (
    forms.find((f) => norm(f.title) === want) ||
    forms.find((f) => norm(f.title) === wantShort) ||
    forms.find((f) => norm(f.title).replace(/^tally /, "") === wantShort) ||
    forms.find((f) => norm(f.entity || "") === norm(entity)) ||
    null
  );
}

function responsesUrl(apiBase, form) {
  const u = form?.jsonBuilderUrls?.response_list_get?.url ||
            form?.jsonBuilderUrls?.response_post?.url;
  if (u) return u.endsWith("/") ? u : u + "/";
  const id = form?.form_id || form?.id;
  return id ? `${apiBase}/json_builder/forms/${id}/responses/` : "";
}

/* ============ AUTO-PROVISIONING (creates the Tally Connector app in AJEMS) ============ */

const APP_TEMPLATE = { title: "Tally Connector", description: "Tally", icon: "pi pi-database", color: "cyan" };

const FIELD_TYPE_BY_PREFIX = {
  text: "Text", number: "Number", checkbox: "Checkbox", dropdown: "Dropdown", date: "Date",
};

const FIELD_OPTIONS = {
  "Sync Frequency": ["15 min", "30 min", "1 hour", "Manual only"],
};

/** Build the create-form payload for one entity straight from GLOBAL_FIELD_KEYS,
 *  so the forms AJEMS creates always match what the sync engine sends. */
function buildFormPayload(entity, appId) {
  const keys = GLOBAL_FIELD_KEYS[entity];
  const allKeys = Object.values(keys);
  const fields = Object.entries(keys).map(([label, key]) => {
    const prefix = key.split("_")[0];
    const field = {
      field_type: FIELD_TYPE_BY_PREFIX[prefix] || "Text",
      label,
      key,
      required: false,
      isNew: false,
      isVisible: true,
      is_report_hide: false,
    };
    if (field.field_type === "Dropdown") {
      field.multiple = false;
      field.options = FIELD_OPTIONS[label] || [];
    }
    return field;
  });

  return {
    app_id: appId,
    title: ENTITY_TITLES[entity],
    description: ENTITY_TITLES[entity],
    isMasterForm: false,
    // Third-party access must be ON for the connector to read and write
    isThirdPartyEnabled: true,
    isThirdPartyPostAllowed: true,
    thirdPartyPostFields: allKeys,
    isThirdPartyGetAllowed: true,
    thirdPartyGetFields: allKeys,
    // A desktop agent cannot solve a captcha
    isPublicPostRecaptchaEnabled: false,
    allowFormColStat: false,
    allowToClone: false,
    clonedBy: "",
    fields,
  };
}

/** Create the app and all 8 forms in the user's workspace. Returns the created forms. */
async function provisionTallyApp(apiBase, headers, log) {
  log("Setting up the Tally Connector app in your AJEMS workspace...");

  let appId;
  try {
    const res = await axios.post(apiBase + "/json_builder/apps/", APP_TEMPLATE, { headers, timeout: 60000 });
    appId = res.data?.app_id || res.data?.id;
    if (!appId) throw new Error("no app id returned");
    log("   App created");
  } catch (err) {
    const st = err.response ? err.response.status : null;
    log(`❌ Could not create the app (${st ? "HTTP " + st : err.message}).`);
    return { ok: false, code: "APP_CREATE_FAILED" };
  }

  const created = [];
  for (const entity of Object.keys(ENTITY_TITLES)) {
    const payload = buildFormPayload(entity, appId);
    try {
      const res = await axios.post(apiBase + "/json_builder/forms/", payload, { headers, timeout: 60000 });
      const form = res.data || {};
      if (!form.form_id && !form.id) throw new Error("no form id returned");
      created.push(form);
      log(`   ${payload.title} created`);
    } catch (err) {
      const st = err.response ? err.response.status : null;
      const body = err.response ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
      log(`❌ Could not create "${payload.title}" (${st ? "HTTP " + st : ""} ${body}).`);
      log(`   ${created.length}/8 forms were created. Please remove the partial app in AJEMS and try again.`);
      return { ok: false, code: "FORM_CREATE_FAILED", created: created.length };
    }
    await sleep(150);
  }

  log("✅ Tally Connector app created with all 8 forms");
  return { ok: true, appId, forms: created };
}

async function connectAjems(log) {
  const cfg = loadConfig();
  const key = (cfg.secretKey || "").trim();

  if (!cfg.tenantUrl || !key) {
    log("❌ Please enter both the Tenant URL and the Secret Key, then click Connect.");
    return { ok: false, code: "MISSING_INPUT" };
  }

  const t = resolveTenant(cfg.tenantUrl);
  if (!t.ok) {
    log("❌ Please enter your AJEMS organisation name.");
    log("   Example: Acme Corp  (spaces and capitals do not matter)");
    return { ok: false, code: "BAD_TENANT_URL" };
  }

  const apiBase = t.apiBase;
  const headers = { "X-Json-Builder-Secret-Key": key, "Accept": "application/json" };
  const wcUrl = apiBase + "/json_builder/workspace_config/";
  log(`Organisation: ${t.org}`);
  log(`Connecting to ${wcUrl}`);

  let data;
  try {
    const res = await axios.get(wcUrl, { headers, timeout: 30000 });
    data = res.data;
    if (typeof data === "string" || !data || typeof data !== "object") {
      log("❌ The workspace address responded, but not with AJEMS data.");
      log("   Please confirm the dashboard URL for this workspace and try again.");
      return { ok: false, code: "NOT_API" };
    }
  } catch (err) {
    const st = err.response ? err.response.status : null;
    if (st === 401 || st === 403) {
      log("❌ AJEMS rejected the Secret Key. Copy it again from your AJEMS workspace and retry.");
      return { ok: false, code: "BAD_KEY" };
    }
    if (st === 404) {
      log(`❌ No AJEMS workspace found for "${t.org}".`);
      log("   Please check the organisation name and try again.");
      return { ok: false, code: "TENANT_NOT_FOUND" };
    }
    log(`❌ Could not reach AJEMS (${st ? "HTTP " + st : err.message}). Check the URL and your internet connection.`);
    return { ok: false, code: "UNREACHABLE" };
  }

  if (data.tenant && norm(data.tenant) !== norm(t.org)) log(`   Server reports workspace: ${data.tenant}`);

  const apps = collectApps(data);
  if (apps.length === 0) {
    log("❌ No apps were returned for this Secret Key. Check that the key belongs to this workspace.");
    return { ok: false, code: "NO_APPS" };
  }

  // Match the connector app: exact first, then any app titled with "tally" that has forms
  const tallyApp =
    apps.find((a) => norm(a.title) === "tally connector") ||
    apps.find((a) => norm(a.title).includes("tally connector")) ||
    apps.find((a) => norm(a.title).includes("tally") && arr(a.forms).length >= 4);

  let forms;

  if (!tallyApp) {
    log("The Tally Connector app is not in this workspace yet.");
    const prov = await provisionTallyApp(apiBase, headers, log);
    if (!prov.ok) return prov;
    forms = prov.forms;
  } else {
    log(`✅ Found app: ${tallyApp.title}`);
    forms = arr(tallyApp.forms);
  }

  // Some workspace_config responses list forms without URLs - fetch the full form list as a fallback
  if (forms.length === 0 || !forms.some((f) => f.jsonBuilderUrls || f.form_id)) {
    try {
      const fr = await axios.get(apiBase + "/json_builder/forms/", { headers, timeout: 30000 });
      const all = arr(fr.data?.results);
      const appId = tallyApp.app_id;
      const scoped = all.filter((f) => !appId || f.app_id === appId);
      if (scoped.length) { forms = scoped; log(`   Loaded ${scoped.length} forms from the forms API`); }
    } catch { /* keep what we have */ }
  }

  // Wipe any URLs from a previously connected workspace before linking this one
  cfg.formUrls = {};
  for (const e of Object.keys(ENTITY_TITLES)) cfg.formUrls[e] = "";
  let matched = 0;
  const missing = [];

  for (const entity of Object.keys(ENTITY_TITLES)) {
    const form = matchForm(forms, entity);
    const url = form ? responsesUrl(apiBase, form) : "";
    if (url) {
      cfg.formUrls[entity] = url;
      matched++;
      log(`   ${form.title || ENTITY_TITLES[entity]} → linked`);
    } else {
      missing.push(ENTITY_TITLES[entity]);
    }
  }

  cfg.apiBase = apiBase;
  cfg.secretKey = key;
  saveConfig(cfg);

  if (missing.length) {
    log(`${matched}/8 forms linked. Missing: ${missing.join(", ")}`);
    log("   Delete the incomplete Tally Connector app in AJEMS and click Connect again to rebuild it.");
    return { ok: false, code: "FORMS_INCOMPLETE", matched };
  }

  log("✅ Connection successful - all 8 forms linked and saved. You can Run Sync now.");
  return { ok: true, matched };
}

module.exports = { runSync, testTally, loadConfig, saveConfig, connectAjems, disconnect };

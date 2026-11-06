/**
 * Tally Connector - Core Sync Engine v2.2 (AJEMS JSON Builder API)
 *
 * How it works:
 *  - The "Tally Connector" app is installed in the workspace from the AJEMS App
 *    Store. Connect finds that installed app and links its modules; it never
 *    creates an app or a form.
 *  - Field keys, field types and choice options are read from each form on every
 *    sync, so values are sent the way each field stores them (a number as a
 *    number, a Yes/No or dropdown choice as its option id).
 *  - A workspace that still has the app the old connector created keeps working:
 *    the same fields are found under their old names.
 *  - GET-based deduplication/upsert, multi-company sync, incremental fallback.
 */

const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");
const { XMLParser } = require("fast-xml-parser");

/* ============ ENTITY FIELD DEFINITIONS (field name → value) ============ */
/* Names are the field names of the App Store app. A name the form does not have
   is skipped, so the legacy-only names at the end of each list cost nothing.
   A value of `undefined` is never sent (it leaves the stored value alone). */
const ENTITY_FIELDS = {
  companies: {
    guidLabel: "Company Guid",
    alterLabel: "Last Alter Id",
    nameLabel: "Company Name",
    fields: (r) => ({
      "Company Name": r.company_name,
      "Status": r.status,
      "Last Sync At": r.last_sync_at,
      "Sales": r.sales,
      "Purchases": r.purchases,
      "Receipts": r.receipts,
      "Payments": r.payments,
      "Last Alter Id": r.last_alter_id,
      "Company Guid": r.company_guid,
      // old app only
      "Id": r.company_guid,
    }),
  },
  ledger_groups: {
    guidLabel: "Tally Guid",
    alterLabel: "Alter Id",
    fields: (r) => ({
      "Name": r.name,
      "Parent Group": r.parent_group_name,
      "Company": r.company_name,
      "Is Revenue": r.is_revenue,
      "Is Deemed Positive": r.is_deemed_positive,
      "Sort Position": r.sort_position,
      "Alter Id": r.alter_id,
      "Tally Guid": r.tally_guid,
      "Synced At": stamp(),
      "Id": r.tally_guid,
    }),
  },
  ledgers: {
    guidLabel: "Tally Guid",
    alterLabel: "Alter Id",
    fields: (r) => ({
      "Name": r.name,
      "Group": r.group_name,
      "Company": r.company_name,
      "Opening Balance": r.opening_balance,
      "Closing Balance": r.closing_balance,
      "Is Billwise": r.is_billwise,
      "Mobile": r.mobile,
      "Email": r.email,
      "GSTIN": r.gstin,
      "State": r.state,
      "Credit Limit": r.credit_limit,
      "Credit Period Days": r.credit_period_days,
      "Alter Id": r.alter_id,
      "Tally Guid": r.tally_guid,
      "Synced At": stamp(),
      "Id": r.tally_guid,
    }),
  },
  vouchers: {
    guidLabel: "Tally Guid",
    alterLabel: "Alter Id",
    fields: (r) => ({
      "Voucher Number": r.voucher_number,
      "Voucher Type": r.voucher_type,
      "Voucher Date": r.voucher_date,
      "Party Ledger Name": r.party_ledger_name,
      "Amount": r.amount,
      "Narration": r.narration,
      "Reference": r.reference,
      "Is Cancelled": r.is_cancelled,
      "Company": r.company_name,
      "Alter Id": r.alter_id,
      "Tally Guid": r.tally_guid,
      "Synced At": stamp(),
      "Id": r.tally_guid,
    }),
  },
  voucher_entries: {
    guidLabel: "Line Id",
    alterLabel: null,
    fields: (r) => ({
      "Ledger Name": r.ledger_name,
      "Amount": r.amount,
      "Is Debit": r.is_debit,
      "Voucher Number": r.voucher_number,
      "Voucher Type": r.voucher_type,
      "Voucher Date": r.voucher_date,
      "Company": r.company_name,
      "Voucher Guid": r.voucher_guid,
      "Line Id": r.entry_guid,
    }),
  },
  voucher_items: {
    guidLabel: "Line Id",
    alterLabel: null,
    fields: (r) => ({
      "Stock Item Name": r.stock_item_name,
      "Qty": r.qty,
      "Rate": r.rate,
      "Amount": r.amount,
      "GST Rate": r.gst_rate,
      "HSN Code": r.hsn_code,
      "Voucher Number": r.voucher_number,
      "Voucher Type": r.voucher_type,
      "Voucher Date": r.voucher_date,
      "Company": r.company_name,
      "Voucher Guid": r.voucher_guid,
      "Line Id": r.item_guid,
    }),
  },
  // Bill-wise outstanding is not synced yet; the definition is kept for when it is.
  outstanding: {
    guidLabel: "Bill Id",
    alterLabel: null,
    fields: (r) => ({
      "Bill Ref": r.bill_ref,
      "Ledger": r.ledger_name,
      "Type": r.type === "receivable" ? "Receivable" : "Payable",
      "Bill Date": r.bill_date,
      "Due Date": r.due_date,
      "Pending Amount": r.pending_amount,
      "Company": r.company_name,
      "Bill Id": r.tally_guid,
      "Synced At": stamp(),
    }),
  },
  sync_logs: {
    guidLabel: null,
    alterLabel: null,
    fields: (r) => ({
      "Run At": stamp(),
      "Status": r.status,
      "Company": r.company_name,
      "Sync Type": r.sync_type,
      "Records Created": r.records_created,
      "Records Updated": r.records_updated,
      "Records Failed": r.records_failed,
      "Error Message": r.error_message || "",
      // old app only
      "Id": "log-" + Date.now(),
      "Entity": "all",
      "From Alter Id": 0,
      "To Alter Id": 0,
    }),
  },
};

/* The same fields under the names the old connector-made app gave them. */
const OLD_LABELS = {
  companies: {},
  ledger_groups: { "Company": "Company Id", "Parent Group": "Parent Group Id" },
  ledgers: { "Company": "Company Id", "Group": "Group Id", "GSTIN": "Gstin" },
  vouchers: { "Company": "Company Id" },
  voucher_entries: { "Voucher Guid": "Voucher Id", "Line Id": "Id" },
  voucher_items: { "Voucher Guid": "Voucher Id", "Line Id": "Id", "GST Rate": "Gst Rate", "HSN Code": "Hsn Code" },
  outstanding: { "Company": "Company Id", "Ledger": "Ledger Id", "Bill Id": "Id" },
  sync_logs: { "Company": "Company Id", "Run At": "Created At" },
};

/* ============ CONFIG / STATE ============ */
const DEFAULT_CONFIG = {
  tallyUrl: "http://localhost:9000",
  companyName: "",
  // AJEMS JSON Builder connection (set via Connect)
  tenantUrl: "",
  apiBase: "",
  secretKey: "",
  // The installed app Connect linked to (shown in the log; not needed to sync)
  appId: "",
  appTitle: "",
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

/* Module (form) titles. The App Store app names them without "Tally"; the old
   connector-made app named them with it. matchForm accepts both. */
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
/* Modules the connector can work without (nothing is written to them yet). */
const OPTIONAL_ENTITIES = ["outstanding"];
const moduleName = (entity) => ENTITY_TITLES[entity].replace(/^Tally /, "");

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
/* Configuration is stored at %APPDATA%/tally-connector/config.json.
   A fresh install starts empty; "Disconnect" clears the saved credentials. */
const CREDENTIAL_KEYS = ["tenantUrl", "apiBase", "secretKey", "formUrls", "appId", "appTitle"];

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
const pad2 = (n) => String(n).padStart(2, "0");
/** "2026-11-05 16:20" in this computer's time - readable, and it sorts in date order */
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** A value placed inside Tally's request XML ("A & B Traders" must become "A &amp; B Traders") */
const xmlEsc = (v) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
/** Vouchers are fetched from the start of the current Indian financial year (1 April) */
const fyStart = () => {
  const d = new Date();
  const y = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}0401`;
};
const today = () => { const d = new Date(); return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`; };
const formUrl = (cfg, entity) => {
  let u = ((cfg.formUrls && cfg.formUrls[entity]) || "").trim();
  if (u && !u.endsWith("/")) u += "/";
  return u;
};
/** The form's own URL (its definition), from its Responses URL */
const formDetailUrl = (cfg, entity) => formUrl(cfg, entity).replace(/responses\/$/, "");
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const httpWhy = (err) => (err && err.response ? "HTTP " + err.response.status : (err && err.message) || "network error");

/* ============ FIELD DISCOVERY ============ */
/* fieldMaps[entity] = { "<normalised field name>": { key, type, options: [{id, label, color}] } } */
const fieldMaps = {};

/* Field types whose value AJEMS works out itself - never sent. */
const DERIVED_TYPES = new Set([
  "autofield", "slug field", "form expression", "compute plus", "comput", "advanced compute",
  "grid col sum", "advanced grid col sum", "form col stat", "grid", "file upload",
]);

/* When a form's definition cannot be read, its key still tells the type:
   the builder writes keys as <type>_<time>_<n>, e.g. radio_v2_1762300000000_103. */
function typeFromKey(key) {
  const m = String(key || "").match(/^([a-z0-9_]+?)_\d{6,}_\d+$/i);
  return m ? m[1].replace(/_/g, " ").toLowerCase() : "text";
}

function optionsOf(field) {
  const items = arr(field.option_items || field.optionItems)
    .filter((o) => o && typeof o === "object" && txt(o.id))
    .map((o) => ({ id: txt(o.id), label: txt(o.label || o.id), color: txt(o.optionColor || o.color) }));
  if (items.length) return items;
  return arr(field.options).map((o) => ({ id: txt(o), label: txt(o), color: "" })).filter((o) => o.id);
}

function fieldMapFromDefinition(fields) {
  const map = {};
  for (const f of arr(fields)) {
    if (!f || !f.key || !f.label || f.isVisible === false) continue;
    const name = norm(f.label);
    if (map[name]) continue;                       // two fields with one name: the first is used
    map[name] = { key: txt(f.key), type: txt(f.field_type).toLowerCase() || typeFromKey(f.key), options: optionsOf(f) };
  }
  return map;
}

function fieldMapFromLabels(labels) {
  const map = {};
  for (const [key, label] of Object.entries(labels || {})) {
    const name = norm(label);
    if (!name || map[name]) continue;
    map[name] = { key, type: typeFromKey(key), options: [] };
  }
  return map;
}

/** Read every linked form's fields: key, type and options. Returns the entities that could not be read. */
async function discoverFields(cfg, log) {
  log("Reading the app's fields...");
  const entities = Object.keys(ENTITY_FIELDS).filter((e) => formUrl(cfg, e));

  // Clear any maps left over from a previously connected workspace
  for (const e of Object.keys(fieldMaps)) delete fieldMaps[e];

  const failed = [];
  await Promise.all(entities.map(async (entity) => {
    try {
      const res = await axios.get(formDetailUrl(cfg, entity), { headers: ajemsHeaders(cfg), timeout: 30000 });
      const map = fieldMapFromDefinition(res.data && res.data.fields);
      if (!Object.keys(map).length) throw new Error("no fields returned");
      fieldMaps[entity] = map;
    } catch (err) {
      // Fall back to the field names the Responses URL reports. Types then come from the keys;
      // a choice field has no option list this way, so its value is left out.
      try {
        const res = await axios.get(formUrl(cfg, entity), { headers: ajemsHeaders(cfg), timeout: 60000 });
        const map = fieldMapFromLabels(res.data && res.data.labels);
        if (!Object.keys(map).length) throw new Error("no field names returned");
        fieldMaps[entity] = map;
        log(`   ${moduleName(entity)}: field details unavailable (${httpWhy(err)}) - using field names only; Yes/No and dropdown values are left out.`);
      } catch (err2) {
        failed.push(entity);
        log(`   ❌ ${moduleName(entity)}: could not read its fields (${httpWhy(err2)}).`);
      }
    }
  }));

  log(`   ${entities.length - failed.length}/${entities.length} modules read`);
  return failed;
}

/** The form field behind one of our field names - under its new name, or its old one. */
function fieldFor(entity, label) {
  const map = fieldMaps[entity];
  if (!map || !label) return null;
  const old = (OLD_LABELS[entity] || {})[label];
  return map[norm(label)] || (old ? map[norm(old)] : null) || null;
}

function keyForLabel(entity, label) {
  const f = fieldFor(entity, label);
  return f ? f.key : null;
}

const isBlank = (v) => v === undefined || v === null || v === "";
const truthy = (v) => v === true || v === 1 || ["true", "yes", "receivable"].includes(String(v).trim().toLowerCase());

/** Turn a record into the body AJEMS stores: each value in the shape its field type keeps. */
function buildPayload(entity, record) {
  const def = ENTITY_FIELDS[entity];
  if (!fieldMaps[entity]) return null;
  const payload = {};
  for (const [label, value] of Object.entries(def.fields(record))) {
    if (value === undefined) continue;
    const f = fieldFor(entity, label);
    if (!f || payload[f.key] !== undefined) continue;
    const type = f.type;

    if (DERIVED_TYPES.has(type)) continue;

    if (type === "number" || type === "rating") {
      const n = typeof value === "number" ? value : parseFloat(String(value ?? "").replace(/,/g, ""));
      payload[f.key] = isNaN(n) ? 0 : n;
    } else if (type === "radio v2" || type === "dropdown v2") {
      // One choice: stored as the option's id, with its label alongside (as a record saved in AJEMS has)
      const want = typeof value === "boolean" ? (value ? "yes" : "no") : String(value ?? "").trim().toLowerCase();
      const opt = f.options.find((o) => o.label.toLowerCase() === want) || f.options.find((o) => o.id.toLowerCase() === want);
      if (!opt) continue;
      payload[f.key] = opt.id;
      payload[f.key + "_meta"] = { id: opt.id, label: opt.label, optionColor: opt.color };
    } else if (type === "checkbox v2") {
      const want = typeof value === "boolean" ? (value ? "yes" : "no") : String(value ?? "").trim().toLowerCase();
      const opt = f.options.find((o) => o.label.toLowerCase() === want);
      if (!opt) continue;
      payload[f.key] = [opt.id];
      payload[f.key + "_meta_list"] = [{ id: opt.id, label: opt.label, optionColor: opt.color }];
    } else if (type === "checkbox") {
      // The old connector-made app: a single tick box, stored as true / false
      payload[f.key] = truthy(value);
    } else if (type === "dropdown" || type === "radio") {
      const want = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value ?? "");
      const opt = f.options.find((o) => o.label.toLowerCase() === want.toLowerCase());
      payload[f.key] = opt ? opt.label : want;
    } else if (type === "date") {
      if (isBlank(value)) continue;
      payload[f.key] = String(value).slice(0, 10);
    } else {
      payload[f.key] = typeof value === "boolean" ? (value ? "Yes" : "No") : isBlank(value) ? "" : String(value);
    }
  }
  return payload;
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

const companyVar = (cfg, withCompany, company) =>
  withCompany ? `<SVCURRENTCOMPANY>${xmlEsc(company || cfg.companyName)}</SVCURRENTCOMPANY>` : "";

const mastersXML = (cfg, withCompany, company) => `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Accounts</REPORTNAME>
<STATICVARIABLES>${companyVar(cfg, withCompany, company)}
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;

const daybookXML = (cfg, withCompany, company) => `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME>
<STATICVARIABLES>${companyVar(cfg, withCompany, company)}
<SVFROMDATE>${fyStart()}</SVFROMDATE><SVTODATE>${today()}</SVTODATE>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;

const voucherRegisterXML = (cfg, withCompany, company) => `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Voucher Register</REPORTNAME>
<STATICVARIABLES>${companyVar(cfg, withCompany, company)}
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
    log(`   ❌ ${entity} UPDATE failed: ${httpWhy(err)}`);
    return false;
  } finally { await sleep(cfg.postDelayMs); }
}

async function fetchExistingMap(cfg, entity, log) {
  const def = ENTITY_FIELDS[entity];
  const guidKey = keyForLabel(entity, def.guidLabel);
  if (!guidKey) return null;
  const alterKey = keyForLabel(entity, def.alterLabel);
  const nameKey = keyForLabel(entity, def.nameLabel);
  try {
    const res = await axios.get(formUrl(cfg, entity), { headers: ajemsHeaders(cfg), timeout: 120000 });
    const responses = arr(res.data?.responses);
    const map = {};
    for (const resp of responses) {
      const rdata = resp.response || {};
      const guid = txt(rdata[guidKey]);
      if (!guid) continue;
      map[guid] = { id: txt(resp._id), alter_id: alterKey ? num(rdata[alterKey]) : -1, name: nameKey ? txt(rdata[nameKey]) : "" };
    }
    log(`   ${entity}: ${Object.keys(map).length} existing records in AJEMS`);
    return map;
  } catch (err) {
    log(`   ${entity} GET failed (${httpWhy(err)}) - falling back to local incremental mode`);
    return null;
  }
}

/** Add the record, or update the one AJEMS already has. `force` updates it even when
 *  Tally's alter id is unchanged (a company's totals and last-sync time, a changed voucher's lines). */
async function upsert(cfg, entity, record, existingMap, log, force = false) {
  const def = ENTITY_FIELDS[entity];
  if (existingMap && def.guidLabel) {
    const guid = txt(record.tally_guid || record.entry_guid || record.item_guid || record.company_guid);
    const existing = existingMap[guid];
    if (!existing) return await ajemsPost(cfg, entity, record, log);
    const newAlter = record.alter_id !== undefined ? num(record.alter_id) : -1;
    if (!force && (existing.alter_id === newAlter || !def.alterLabel)) { bump(entity, "skipped"); return true; }
    if (canUpdate(cfg)) return await ajemsUpdate(cfg, entity, existing.id, record, log);
    detailLog(`   ${entity} "${record.name || guid}" has changed but update API is not configured - skipped (avoiding duplicate)`);
    bump(entity, "skipped");
    return true;
  }
  return await ajemsPost(cfg, entity, record, log);
}

/* ============ SYNC: MASTERS ============ */
/** Groups and ledgers. Returns what the company's own record needs (it is written after the vouchers). */
async function syncMasters(cfg, state, log, company) {
  log(`\n[${company}] Fetching masters from Tally...`);
  const messages = await tallyFetchWithRetry(cfg, mastersXML, "Masters", log, company);
  log(`   ${messages.length} records received`);
  if (messages.length === 0) return null;

  // These lookups are independent - fetch them together
  const [groupMap, ledgerMap] = await Promise.all([
    fetchExistingMap(cfg, "ledger_groups", log),
    fetchExistingMap(cfg, "ledgers", log),
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

  state.masters_alter[company] = maxAlterId;
  return { guid: companyGuidPrefix || company, maxAlterId };
}

/* ============ SYNC: VOUCHERS ============ */
/* A company's totals count Tally's four standard voucher types, cancelled vouchers left out. */
const TOTAL_OF_TYPE = { sales: "sales", purchase: "purchases", receipt: "receipts", payment: "payments" };

/** Vouchers and their lines. Returns the company's totals over every voucher Tally sent
 *  (the current financial year), or null when Tally sent none. */
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
  if (vouchers.length === 0) return null;

  const vchMap = await fetchExistingMap(cfg, "vouchers", log);
  if (!state.synced_voucher_guids) state.synced_voucher_guids = {};
  const totals = { sales: 0, purchases: 0, receipts: 0, payments: 0 };

  // The lines AJEMS already holds are only needed when a voucher has changed - read them once, then
  let lineMaps = null;
  const loadLineMaps = async () => {
    if (!lineMaps) {
      const [entries, items] = await Promise.all([
        fetchExistingMap(cfg, "voucher_entries", log),
        fetchExistingMap(cfg, "voucher_items", log),
      ]);
      lineMaps = { entries, items };
    }
    return lineMaps;
  };

  for (const v of vouchers) {
    const guid = txt(v.GUID);
    const alterId = num(v.ALTERID);

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

    const bucket = TOTAL_OF_TYPE[rec.voucher_type.toLowerCase()];
    if (bucket && !rec.is_cancelled) totals[bucket] += rec.amount;

    // Without AJEMS's list we cannot tell an add from an update, so a voucher this computer
    // has already sent is left alone rather than added twice.
    if (!vchMap && state.synced_voucher_guids[guid] !== undefined) { bump("vouchers", "skipped"); continue; }

    const existing = vchMap ? vchMap[guid] : null;
    const isNew = !existing;
    const changed = !!existing && existing.alter_id !== alterId;
    if (isNew || changed) detailLog(`   → voucher: ${rec.voucher_type} #${rec.voucher_number} (${rec.party_ledger_name})`);
    const ok = await upsert(cfg, "vouchers", rec, vchMap, log);

    // Lines follow their voucher: added with a new voucher, brought up to date with a changed one
    if (ok && (isNew || changed)) {
      const maps = changed ? await loadLineMaps() : { entries: null, items: null };
      const head = {
        voucher_guid: guid, voucher_number: rec.voucher_number, voucher_type: rec.voucher_type,
        voucher_date: rec.voucher_date, company_name: company,
      };
      const sendLine = (entity, line, map) => {
        if (!changed) return ajemsPost(cfg, entity, line, log);
        // changed voucher, but AJEMS's lines could not be read: leave them rather than add them twice
        if (!map) { bump(entity, "skipped"); return true; }
        return upsert(cfg, entity, line, map, log, true);
      };

      await runPooled(entries, (e, i) => sendLine("voucher_entries", {
        ...head,
        entry_guid: `${guid}-e${i}`,
        ledger_name: txt(e.LEDGERNAME),
        amount: num(e.AMOUNT),
        is_debit: yn(e.ISDEEMEDPOSITIVE),
      }, maps.entries));

      const items = arr(v["ALLINVENTORYENTRIES.LIST"] || v["INVENTORYENTRIES.LIST"]);
      await runPooled(items, (it, i) => sendLine("voucher_items", {
        ...head,
        item_guid: `${guid}-i${i}`,
        stock_item_name: txt(it.STOCKITEMNAME),
        qty: num(it.ACTUALQTY),
        rate: num(it.RATE),
        amount: num(it.AMOUNT),
        gst_rate: num(it.GSTRATE),
        hsn_code: txt(it.GSTHSNCODE),
      }, maps.items));
    }
    if (ok) state.synced_voucher_guids[guid] = alterId;
  }
  return totals;
}

/* ============ SYNC: COMPANY ============ */
/** The company's own record: written last, so its totals and last-sync time are those of this run. */
async function syncCompany(cfg, log, company, masters, totals, compMap) {
  const guid = masters ? masters.guid : company;
  const rec = {
    company_name: company,
    company_guid: guid,
    last_alter_id: masters ? masters.maxAlterId : undefined,
    alter_id: masters ? masters.maxAlterId : undefined,
    last_sync_at: stamp(),
    status: "Connected",
    // undefined = not sent: when Tally gave no vouchers this run, the stored totals stay
    sales: totals ? totals.sales : undefined,
    purchases: totals ? totals.purchases : undefined,
    receipts: totals ? totals.receipts : undefined,
    payments: totals ? totals.payments : undefined,
  };
  if (!compMap) {
    // AJEMS's company list could not be read: do not risk a second record for the same company
    bump("companies", "skipped");
    return;
  }
  // The record is found by its GUID, or failing that by the company's name (a run in which
  // Tally sent no masters has no GUID to go by) - one company never gets two records.
  let map = compMap;
  if (!compMap[guid]) {
    const byName = Object.entries(compMap).find(([, row]) => row.name === company);
    if (byName) {
      if (!masters) rec.company_guid = byName[0];          // keep the GUID it was stored with
      map = { ...compMap, [rec.company_guid]: byName[1] };
    }
  }
  await upsert(cfg, "companies", rec, map, log, true);
  if (!compMap[rec.company_guid]) compMap[rec.company_guid] = { id: "", alter_id: -1, name: company };
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

  // Step 1: read the fields of the app in THIS workspace
  const unread = (await discoverFields(cfg, log)).filter((e) => !OPTIONAL_ENTITIES.includes(e));
  if (unread.length) {
    log(`❌ Sync stopped: could not read ${unread.map(moduleName).join(", ")} in AJEMS.`);
    log("   Check that the Tally Connector app is still installed and that this secret key can open it, then click AJEMS Connect again.");
    throw new Error(`Could not read ${unread.map(moduleName).join(", ")} in AJEMS`);
  }
  log(`Upsert: deduplication ON${canUpdate(cfg) ? " + record updates ENABLED" : " (updates disabled - changed records will be skipped)"}`);

  const companies = await getOpenCompanies(cfg, log);
  if (companies.length === 0) {
    log("❌ No companies found. Open your company in Tally and try again.");
    return stats;
  }

  const compMap = await fetchExistingMap(cfg, "companies", log);

  let errMsg = "";
  for (const company of companies) {
    let masters = null, totals = null;
    try { masters = await syncMasters(cfg, state, log, company); }
    catch (e) { errMsg += ` Masters[${company}]: ` + e.message; log("❌ " + e.message); }

    try { totals = await syncVouchers(cfg, state, log, company); }
    catch (e) { errMsg += ` Vouchers[${company}]: ` + e.message; log("❌ Vouchers: " + e.message); }

    if (masters || totals) {
      try { await syncCompany(cfg, log, company, masters, totals, compMap); }
      catch (e) { errMsg += ` Company[${company}]: ` + e.message; log("❌ Company: " + e.message); }
    }
  }

  saveState(cfg, state);

  const totalCreated = Object.values(stats).reduce((a, s) => a + s.created, 0);
  const totalUpdated = Object.values(stats).reduce((a, s) => a + s.updated, 0);
  const totalFailed = Object.values(stats).reduce((a, s) => a + s.failed, 0);
  const nothingDone = totalCreated + totalUpdated === 0 && Object.values(stats).every((s) => !s.skipped);

  await ajemsPost(cfg, "sync_logs", {
    company_name: companies.join(" | "),
    sync_type: "Upsert",
    records_created: totalCreated,
    records_updated: totalUpdated,
    records_failed: totalFailed,
    status: errMsg && nothingDone ? "Failed" : errMsg || totalFailed ? "Partial" : "Success",
    error_message: errMsg.trim(),
  }, log);

  log("\n========== SYNC SUMMARY ==========");
  for (const [entity, s] of Object.entries(stats)) {
    log(`  ${entity.padEnd(16)} new: ${s.created}  upd: ${s.updated}  skip: ${s.skipped}  fail: ${s.failed}`);
  }
  log(`  Time: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  log("==================================");
  log("✅ Done! Open the Tally Connector app in AJEMS to see the data.");
  return stats;
}

/* ============ CONNECT: AJEMS JSON Builder ============ */
/** Work out this workspace's API base from what the user typed.
 *  Accepts an organisation name - "Acme Corp", "acme corp", "ACMECORP"
 *  all resolve to acmecorp on the live server - or a workspace URL.
 *  A workspace on the testing server is always given by its URL
 *  (acme.ajems-staging.com, or any page of it), whose API is acme.api.ajems-staging.com. */
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
    const staging = host.match(/^([a-z0-9][a-z0-9-]*)(?:\.api)?\.ajems-staging\.com$/);
    if (staging && staging[1] !== "api") {
      return { ok: true, org: staging[1], apiBase: `https://${staging[1]}.api.ajems-staging.com`, staging: true };
    }
    return { ok: false, reason: "UNKNOWN_HOST", host };
  }

  // Organisation name → slug (spaces, case and punctuation ignored)
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (slug.length < 2) return { ok: false, reason: "TOO_SHORT" };
  return { ok: true, org: slug, apiBase: `https://${slug}.buildprohub-server.com` };
}

/** Find every object that looks like an app ({title, forms}) anywhere in the payload, in the order given */
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

/** Match a form to an entity: "Companies" / "Tally Companies" / "tally_companies" all work */
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

/** A form's Responses URL, on the server Connect itself reached - so a testing server whose
 *  replies name another host in their URLs is still the one written to. */
function responsesUrl(apiBase, form) {
  const id = form?.form_id || form?.id;
  if (id) return `${apiBase}/json_builder/forms/${id}/responses/`;
  const u = form?.jsonBuilderUrls?.response_list_get?.url ||
            form?.jsonBuilderUrls?.response_post?.url;
  return u ? (u.endsWith("/") ? u : u + "/") : "";
}

/** Of the workspace's apps, the installed Tally Connector: the app named for Tally that holds
 *  the most of our modules; of two equally complete ones, the one installed last. */
function findTallyApp(apps) {
  let best = null, bestScore = 0;
  for (const a of apps) {                                  // the workspace lists apps oldest first
    if (!norm(a.title).includes("tally")) continue;
    const forms = arr(a.forms);
    const score = Object.keys(ENTITY_TITLES).filter((e) => matchForm(forms, e)).length;
    if (score > 0 && score >= bestScore) { best = a; bestScore = score; }
  }
  // An app listed without its forms (some replies leave them out) can still be the one, by name
  return best || apps.find((a) => norm(a.title).startsWith("tally connector")) || null;
}

/** Older AJEMS servers answer the connector only for forms with third-party access switched on.
 *  The App Store installs forms with it off, so it is switched on here for every field.
 *  Newer servers do not need this; a key that may not change the form is not an error. */
async function allowApiAccess(apiBase, headers, form, log) {
  const id = form.form_id || form.id;
  if (!id) return;
  if (form.isThirdPartyEnabled && form.isThirdPartyGetAllowed && form.isThirdPartyPostAllowed &&
      !arr(form.thirdPartyGetFields).length && !arr(form.thirdPartyPostFields).length) return;
  const keys = arr(form.fields).filter((f) => f && f.key && f.isVisible !== false).map((f) => f.key);
  const listed = (have) => !arr(have).length || keys.every((k) => arr(have).includes(k));
  if (form.isThirdPartyEnabled && form.isThirdPartyGetAllowed && form.isThirdPartyPostAllowed &&
      listed(form.thirdPartyGetFields) && listed(form.thirdPartyPostFields)) return;
  try {
    await axios.patch(`${apiBase}/json_builder/forms/${id}/`, {
      isThirdPartyEnabled: true,
      isThirdPartyGetAllowed: true,
      thirdPartyGetFields: keys,
      isThirdPartyPostAllowed: true,
      thirdPartyPostFields: keys,
    }, { headers, timeout: 30000 });
  } catch (err) {
    detailLog(`   ${form.title}: API access left as it is (${httpWhy(err)})`);
  }
}

async function connectAjems(log) {
  const cfg = loadConfig();
  const key = (cfg.secretKey || "").trim();
  detailLog = cfg.verboseLog ? log : () => {};

  if (!cfg.tenantUrl || !key) {
    log("❌ Please enter both the Organisation Name and the Secret Key, then click Connect.");
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
  log(`Organisation: ${t.org}${t.staging ? "  (testing server)" : ""}`);
  log(`Connecting to ${wcUrl}`);

  let data;
  try {
    const res = await axios.get(wcUrl, { headers, timeout: 30000 });
    data = res.data;
    if (typeof data === "string" || !data || typeof data !== "object") {
      log("❌ The workspace address responded, but not with AJEMS data.");
      log("   Please confirm the organisation name for this workspace and try again.");
      return { ok: false, code: "NOT_API" };
    }
  } catch (err) {
    const st = err.response ? err.response.status : null;
    const said = err.response ? JSON.stringify(err.response.data || "").toLowerCase() : "";
    if (st === 403 && said.includes("not allowed for this api")) {
      log(`❌ The workspace "${t.org}" is not switched on for connectors on this server.`);
      log("   Ask the server admin to add it to JSON_BUILDER_ALLOWED_TENANTS, or use a connector key issued for a user of this workspace.");
      return { ok: false, code: "TENANT_NOT_ALLOWED" };
    }
    if (st === 403 && said.includes("another workspace")) {
      log("❌ This Secret Key belongs to another workspace. Use the key issued in this workspace.");
      return { ok: false, code: "BAD_KEY" };
    }
    if (st === 401 || st === 403) {
      log("❌ AJEMS rejected the Secret Key. Copy it again from your AJEMS workspace and retry.");
      if (t.staging) log("   The testing server has its own keys - a key from the live server does not work here.");
      return { ok: false, code: "BAD_KEY" };
    }
    if (st === 404) {
      log(`❌ No AJEMS workspace found for "${t.org}".`);
      log("   Please check the organisation name and try again.");
      return { ok: false, code: "TENANT_NOT_FOUND" };
    }
    log(`❌ Could not reach AJEMS (${st ? "HTTP " + st : err.message}). Check the organisation name and your internet connection.`);
    return { ok: false, code: "UNREACHABLE" };
  }

  if (data.tenant && norm(data.tenant) !== norm(t.org)) log(`   Server reports workspace: ${data.tenant}`);

  // The app is installed from the App Store; the connector only links to it.
  const tallyApp = findTallyApp(collectApps(data));
  if (!tallyApp) {
    log("❌ The Tally Connector app is not installed in this workspace.");
    log("   In AJEMS, open the App Store, install Tally Connector, then click AJEMS Connect again.");
    log("   (If it is installed, this secret key has no access to it - use the key of a workspace admin.)");
    return { ok: false, code: "APP_NOT_INSTALLED" };
  }
  log(`✅ Found app: ${tallyApp.title}`);

  // Some workspace_config replies list forms without URLs - fetch the full form list as a fallback
  let forms = arr(tallyApp.forms);
  if (forms.length === 0 || !forms.some((f) => f.jsonBuilderUrls || f.form_id)) {
    try {
      const fr = await axios.get(apiBase + "/json_builder/forms/", { headers, timeout: 30000 });
      const appId = tallyApp.app_id;
      const scoped = arr(fr.data?.results).filter((f) => !appId || f.app_id === appId);
      if (scoped.length) { forms = scoped; log(`   Loaded ${scoped.length} modules from the forms API`); }
    } catch { /* keep what we have */ }
  }

  // Wipe any URLs from a previously connected workspace before linking this one
  cfg.formUrls = {};
  for (const e of Object.keys(ENTITY_TITLES)) cfg.formUrls[e] = "";
  let matched = 0;
  const missing = [];
  const linked = [];

  for (const entity of Object.keys(ENTITY_TITLES)) {
    const form = matchForm(forms, entity);
    const url = form ? responsesUrl(apiBase, form) : "";
    if (url) {
      cfg.formUrls[entity] = url;
      matched++;
      linked.push(form);
      log(`   ${form.title || moduleName(entity)} → linked`);
    } else if (!OPTIONAL_ENTITIES.includes(entity)) {
      missing.push(moduleName(entity));
    }
  }

  if (missing.length) {
    log(`❌ The app is missing: ${missing.join(", ")}.`);
    log("   Uninstall Tally Connector in AJEMS, install it again from the App Store, then click AJEMS Connect.");
    return { ok: false, code: "FORMS_INCOMPLETE", matched };
  }

  for (const form of linked) await allowApiAccess(apiBase, headers, form, log);

  cfg.apiBase = apiBase;
  cfg.secretKey = key;
  cfg.appId = txt(tallyApp.app_id);
  cfg.appTitle = txt(tallyApp.title);
  saveConfig(cfg);

  log(`✅ Connection successful - ${matched} modules linked and saved. You can Run Sync now.`);
  return { ok: true, matched };
}

module.exports = { runSync, testTally, loadConfig, saveConfig, connectAjems, disconnect, resolveTenant };

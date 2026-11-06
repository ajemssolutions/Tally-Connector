/**
 * AJEMS Connections Hub - status reporting
 *
 * Tells connectors.ajems.com that this machine is paired and online so it shows
 * under "Active Connectors". It reuses the organisation and secret key already
 * saved by pairing - nothing is prompted for and nothing is hardcoded.
 *
 * This module is best-effort by design: every call is wrapped, a failure is
 * logged once and then forgotten, and nothing here can block or break the data
 * push. The secret key travels in the JSON body only and is never logged.
 */

const os = require("os");
const axios = require("axios");
const { loadConfig, saveConfig, resolveTenant } = require("./sync");

const HUB_BASE = "https://connectors.ajems.com";
const REPORT_PATH = "/api/connectors/tally/report";
/* The hub marks a device offline after roughly ten minutes without a report,
   so the heartbeat has to stay comfortably under that. */
const HEARTBEAT_MS = 5 * 60 * 1000;

/* One shared client for every report */
const http = axios.create({
  baseURL: HUB_BASE,
  timeout: 10000,
  headers: { "Content-Type": "application/json" },
  validateStatus: () => true,   // treat 400/401 as data, not exceptions
});

let timer = null;
let logFn = () => {};
let lastOutcome = "";           // keeps the heartbeat from repeating itself in the log

function say(outcome, line) {
  if (outcome === lastOutcome) return;
  lastOutcome = outcome;
  try { logFn(line); } catch { /* no window - nothing to log to */ }
}

/** Stable per-machine id: the Windows computer name, identical across restarts. */
function deviceId() {
  const name = String(os.hostname() || process.env.COMPUTERNAME || "").trim();
  return name || "unknown-device";
}

/** Running total of records pushed to AJEMS from this machine. */
function recordsTotal() {
  return Number(loadConfig().hubRecordsTotal || 0);
}

function addRecords(n) {
  const add = Math.max(0, Number(n) || 0);
  const cfg = loadConfig();
  cfg.hubRecordsTotal = Number(cfg.hubRecordsTotal || 0) + add;
  saveConfig(cfg);
  return cfg.hubRecordsTotal;
}

function resetRecords() {
  const cfg = loadConfig();
  cfg.hubRecordsTotal = 0;
  saveConfig(cfg);
}

/** Paired means: an organisation, a key, and at least one linked form. */
function isPaired() {
  const cfg = loadConfig();
  const t = resolveTenant(cfg.tenantUrl);
  return !!(t && t.ok && String(cfg.secretKey || "").trim() &&
            cfg.formUrls && cfg.formUrls.companies);
}

/**
 * Send one status report.
 * @param {{status?: string, records?: number, event?: {kind?: string, text?: string}}} opts
 */
async function report(opts = {}) {
  const status = opts.status || "connected";
  try {
    const cfg = loadConfig();
    const t = resolveTenant(cfg.tenantUrl);
    const org = t && t.ok ? t.org : "";
    const secretKey = String(cfg.secretKey || "").trim();
    if (!org || !secretKey) return { ok: false, reason: "not-paired" };
    // The Connections Hub knows live workspaces only; a testing-server key is never sent to it.
    if (t.staging) return { ok: false, reason: "testing-server" };

    const body = { org, secretKey, device: deviceId(), status };

    const total = Number.isFinite(opts.records) ? opts.records : recordsTotal();
    if (total > 0) body.records = Math.round(total);

    if (opts.event && opts.event.text) {
      body.event = {
        kind: opts.event.kind || "ok",
        text: String(opts.event.text).slice(0, 300),
      };
    }

    const res = await http.post(REPORT_PATH, body);
    const code = res.status;

    if (code >= 200 && code < 300) {
      say("ok", `Connections Hub: reported as ${status} (device ${body.device}).`);
      return { ok: true, status: code };
    }
    if (code === 401) {
      say("401", "Connections Hub rejected this workspace key - check your workspace key in Settings. Syncing to AJEMS is unaffected.");
      return { ok: false, status: code, reason: "bad-key" };
    }
    if (code === 400) {
      say("400", "Connections Hub reported a missing organisation name or key.");
      return { ok: false, status: code, reason: "missing-fields" };
    }
    if (code === 404) {
      say("404", "Connections Hub has no status endpoint yet - it may not be updated on the server. Syncing to AJEMS is unaffected.");
      return { ok: false, status: code, reason: "no-endpoint" };
    }
    say("http" + code, `Connections Hub returned HTTP ${code}. Will retry on the next heartbeat.`);
    return { ok: false, status: code, reason: "http" };
  } catch (err) {
    // Timeout, DNS, offline - the next heartbeat picks it up.
    const why = (err && err.code) || (err && err.message) || "network error";
    say("net", `Connections Hub not reachable (${why}). Syncing to AJEMS is unaffected; retrying in 5 minutes.`);
    return { ok: false, reason: "unreachable" };
  }
}

/** Report now, then keep reporting every five minutes. Safe to call again. */
function start(log, event) {
  if (typeof log === "function") logFn = log;
  report({ status: "connected", event });
  if (timer) return;
  timer = setInterval(() => { report({ status: "connected" }); }, HEARTBEAT_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  lastOutcome = "";
}

/** Call this BEFORE the saved credentials are cleared, or there is nothing to report with. */
async function reportDisconnected(log) {
  if (typeof log === "function") logFn = log;
  stop();
  lastOutcome = "";
  return report({
    status: "disconnected",
    event: { kind: "ok", text: "Unpaired from this device" },
  });
}

module.exports = {
  start, stop, report, reportDisconnected,
  isPaired, deviceId, recordsTotal, addRecords, resetRecords,
  HEARTBEAT_MS,
};

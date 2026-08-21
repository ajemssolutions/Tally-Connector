const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, nativeImage } = require("electron");
const path = require("path");
const { runSync, testTally, loadConfig, saveConfig, connectAjems, disconnect } = require("./sync");

/* Auto-update: the app checks quietly and tells the user. Nothing downloads or
   installs on its own - the user chooses when. Wrapped so the portable build,
   which has no updater bundled, still runs. */
let autoUpdater = null;
try { ({ autoUpdater } = require("electron-updater")); } catch { /* not packaged */ }

let win = null;
let tray = null;
let quitting = false;
let syncRunning = false;

const ICON = path.join(__dirname, "assets", "icon.png");

/* ---------------- window ---------------- */
function createWindow(showIt = true) {
  win = new BrowserWindow({
    width: 920,
    height: 640,
    minWidth: 720,
    minHeight: 520,
    icon: ICON,
    show: showIt,
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));

  // Closing the window keeps the app running in the tray
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
      notifyOnce("tray-hint", "Tally Connector is still running",
        "It stays in the system tray so scheduled syncs can run. Right-click the tray icon to quit.");
    }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  else { win.show(); win.focus(); }
}

/* ---------------- tray ---------------- */
function buildTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip("Tally Connector");
  refreshTrayMenu("Idle");
  tray.on("double-click", showWindow);
}

function refreshTrayMenu(status) {
  if (!tray) return;
  const cfg = loadConfig();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Tally Connector - ${status}`, enabled: false },
    { type: "separator" },
    { label: "Open", click: showWindow },
    { label: "Run Sync Now", enabled: !syncRunning, click: () => doSync("tray") },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.setToolTip(`Tally Connector - ${status}`);
}

/* ---------------- notifications ---------------- */
const shownOnce = new Set();
function notify(title, body) {
  const cfg = loadConfig();
  if (cfg.notifyOnSync === false) return;
  if (!Notification.isSupported()) return;
  new Notification({ title, body, icon: ICON }).show();
}
function notifyOnce(key, title, body) {
  if (shownOnce.has(key)) return;
  shownOnce.add(key);
  notify(title, body);
}

/* ---------------- logging ---------------- */
function logToUI(line) {
  if (win && !win.isDestroyed()) win.webContents.send("log", line);
}

/* ---------------- sync driver (works with or without a visible window) ---------------- */
async function doSync(reason) {
  if (syncRunning) return { ok: false, error: "A sync is already running" };
  const cfg = loadConfig();
  if (!cfg.formUrls || !cfg.formUrls.companies) {
    logToUI("Automatic sync skipped - not connected to AJEMS yet.");
    return { ok: false, error: "not connected" };
  }
  syncRunning = true;
  refreshTrayMenu("Syncing...");
  if (win && !win.isDestroyed()) win.webContents.send("sync-state", true);
  logToUI(`\nAutomatic sync started (${reason}).`);

  try {
    const stats = await runSync(logToUI);
    const created = Object.values(stats).reduce((a, s) => a + s.created, 0);
    const updated = Object.values(stats).reduce((a, s) => a + s.updated, 0);
    const failed = Object.values(stats).reduce((a, s) => a + s.failed, 0);
    notify(failed ? "Tally sync finished with errors" : "Tally sync complete",
      `${created} added, ${updated} updated${failed ? `, ${failed} failed` : ""}.`);
    refreshTrayMenu("Idle");
    return { ok: true, summary: stats };
  } catch (err) {
    logToUI("❌ Fatal: " + err.message);
    notify("Tally sync failed", err.message.slice(0, 120));
    refreshTrayMenu("Idle");
    return { ok: false, error: err.message };
  } finally {
    const c = loadConfig();
    c.lastSyncAt = Date.now();
    saveConfig(c);
    syncRunning = false;
    if (win && !win.isDestroyed()) win.webContents.send("sync-state", false);
  }
}

/* ---------------- schedulers ---------------- */
function startSchedulers() {
  // Daily time check, once a minute
  setInterval(async () => {
    const cfg = loadConfig();
    if (!cfg.syncDaily) return;
    const now = new Date();
    const hhmm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (hhmm === (cfg.autoSyncTime || "09:00") && cfg.lastAutoSyncDate !== todayStr) {
      const c2 = loadConfig();
      c2.lastAutoSyncDate = todayStr;
      saveConfig(c2);
      const t = await testTally();
      if (!t.ok) {
        logToUI("Scheduled sync skipped - Tally is not running.");
        notify("Tally sync skipped", "Tally was not running at the scheduled time.");
        return;
      }
      await doSync("daily schedule");
    }
  }, 30000);

  // Repeat sync while Tally is open
  setInterval(async () => {
    const cfg = loadConfig();
    if (!cfg.syncOnTallyStart) return;
    if (syncRunning) return;

    const t = await testTally();
    if (!t.ok) return;                       // Tally closed - nothing to do

    const everyMs = Math.max(5, Number(cfg.syncEveryMinutes || 30)) * 60000;
    const last = Number(cfg.lastSyncAt || 0);
    if (Date.now() - last >= everyMs) {
      const c2 = loadConfig();
      c2.lastSyncAt = Date.now();
      saveConfig(c2);
      await doSync(`every ${cfg.syncEveryMinutes || 30} minute(s)`);
    }
  }, 60000);
}

/* ---------------- updates ---------------- */
let pendingUpdate = null;   // { version } once an update is available

function toRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setupUpdater() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = false;            // never download behind the user's back
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("update-available", (info) => {
    pendingUpdate = { version: info.version };
    toRenderer("update-available", pendingUpdate);
    notify("Update available", `Tally Connector ${info.version} is ready to download.`);
  });
  autoUpdater.on("download-progress", (p) => toRenderer("update-progress", Math.round(p.percent)));
  autoUpdater.on("update-downloaded", (info) => {
    toRenderer("update-downloaded", { version: info.version });
    notify("Update ready", "Restart Tally Connector to finish installing.");
  });
  autoUpdater.on("error", (err) => toRenderer("update-error", String(err && err.message || err)));

  const check = () => autoUpdater.checkForUpdates().catch(() => { /* offline is fine */ });
  setTimeout(check, 15000);                    // shortly after launch
  setInterval(check, 6 * 60 * 60 * 1000);      // and every six hours
}

/* ---------------- app lifecycle ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId("in.ajems.tallyconnector");   // required for Windows notifications
    const startHidden = process.argv.includes("--hidden");
    createWindow(!startHidden);
    buildTray();
    startSchedulers();
    setupUpdater();

    // Keep the OS setting in step with the saved preference
    const cfg = loadConfig();
    if (cfg.startWithWindows === true) {
      app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
    }
  });

  app.on("window-all-closed", () => { /* stay alive in the tray */ });
  app.on("before-quit", () => { quitting = true; });
}

/* ---------------- IPC ---------------- */
ipcMain.handle("get-config", () => loadConfig());
ipcMain.handle("save-config", (_e, cfg) => {
  // Automatic sync only works while the connector is running, so Windows startup
  // is enabled or disabled to match the user's choices - no separate setting.
  cfg.startWithWindows = !!(cfg.syncOnTallyStart || cfg.syncDaily);
  saveConfig(cfg);
  app.setLoginItemSettings({ openAtLogin: cfg.startWithWindows, args: ["--hidden"] });
  refreshTrayMenu(syncRunning ? "Syncing..." : "Idle");
  return { ok: true };
});
ipcMain.handle("connect-ajems", async () => await connectAjems(logToUI));
ipcMain.handle("disconnect", () => ({ ok: disconnect() }));
ipcMain.handle("test-tally", async () => await testTally(logToUI));
ipcMain.handle("run-sync", async () => await doSync("manual"));

ipcMain.handle("update-status", () => pendingUpdate);
ipcMain.handle("download-update", async () => {
  if (!autoUpdater) return { ok: false, error: "Updates are not available in this build" };
  try { await autoUpdater.downloadUpdate(); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle("install-update", () => {
  if (!autoUpdater) return { ok: false };
  quitting = true;
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
});

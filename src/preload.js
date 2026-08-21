const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridge", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (cfg) => ipcRenderer.invoke("save-config", cfg),
  testTally: () => ipcRenderer.invoke("test-tally"),
  disconnect: () => ipcRenderer.invoke("disconnect"),
  connectAjems: () => ipcRenderer.invoke("connect-ajems"),
  runSync: () => ipcRenderer.invoke("run-sync"),
  onLog: (cb) => ipcRenderer.on("log", (_e, line) => cb(line)),
  onSyncState: (cb) => ipcRenderer.on("sync-state", (_e, running) => cb(running)),

  // updates
  updateStatus: () => ipcRenderer.invoke("update-status"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  onUpdateAvailable: (cb) => ipcRenderer.on("update-available", (_e, i) => cb(i)),
  onUpdateProgress: (cb) => ipcRenderer.on("update-progress", (_e, p) => cb(p)),
  onUpdateDownloaded: (cb) => ipcRenderer.on("update-downloaded", (_e, i) => cb(i)),
  onUpdateError: (cb) => ipcRenderer.on("update-error", (_e, m) => cb(m)),
});

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qrFactory", {
  apiGet: (url) => ipcRenderer.invoke("api:get", url),
  apiPost: (url, body) => ipcRenderer.invoke("api:post", url, body),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),

  // Settings + filesystem helpers (Electron only)
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch || {}),
  pickExcelFolder: () => ipcRenderer.invoke("dialog:pickExcelFolder"),
  pickExcelFile: () => ipcRenderer.invoke("dialog:pickExcelFile"),
  openPath: (p) => ipcRenderer.invoke("fs:openPath", p),
  exportExcelToFolder: () => ipcRenderer.invoke("excel:export"),
  importExcelFromFile: (filePath) => ipcRenderer.invoke("excel:import", { filePath }),
});

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qrFactory", {
  apiGet: (url) => ipcRenderer.invoke("api:get", url),
  apiPost: (url, body) => ipcRenderer.invoke("api:post", url, body),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
});

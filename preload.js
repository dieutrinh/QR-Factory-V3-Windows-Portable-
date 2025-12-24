const { contextBridge, ipcRenderer } = require("electron");

// Secure bridge. Renderer uses window.qrFactory.apiGet/apiPost
contextBridge.exposeInMainWorld("qrFactory", {
  apiGet: (url) => ipcRenderer.invoke("api:get", url),
  apiPost: (url, body) => ipcRenderer.invoke("api:post", url, body),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
  printToPDF: () => ipcRenderer.invoke("print:pdf"),
});

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");

let win;
let baseUrl;
let serverRef;

async function createWindow(){
  const { startServer } = require("./server");
  // 0 => random free port
  const started = await startServer(0);
  serverRef = started.server;
  baseUrl = `http://127.0.0.1:${started.port}`;

  win = new BrowserWindow({
    width: 1200,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  await win.loadURL(`${baseUrl}/index.html`).catch(async ()=>{ await win.loadURL(`${baseUrl}/`); });
}

ipcMain.handle("api:get", async (_e, url)=>{
  const u = new URL(url, baseUrl);
  const r = await fetch(u.toString(), { method: "GET" });
  const txt = await r.text();
  let data;
  try{ data = txt ? JSON.parse(txt) : {}; }catch{ data = { raw: txt }; }
  if(!r.ok) throw new Error((data && (data.error||data.message)) || `HTTP ${r.status}`);
  return data;
});

ipcMain.handle("api:post", async (_e, url, body)=>{
  const u = new URL(url, baseUrl);
  const r = await fetch(u.toString(), {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body||{})
  });
  const txt = await r.text();
  let data;
  try{ data = txt ? JSON.parse(txt) : {}; }catch{ data = { raw: txt }; }
  if(!r.ok) throw new Error((data && (data.error||data.message)) || `HTTP ${r.status}`);
  return data;
});

ipcMain.handle("open:external", async (_e, url)=>{
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("print:pdf", async ()=>{
  if(!win) throw new Error("No window");
  const pdf = await win.webContents.printToPDF({ printBackground: true });
  return { pdfBase64: pdf.toString("base64") };
});

app.whenReady().then(createWindow);

app.on("window-all-closed", ()=>{
  if(process.platform !== "darwin") app.quit();
});

app.on("before-quit", ()=>{
  try{ serverRef && serverRef.close(); }catch{}
});

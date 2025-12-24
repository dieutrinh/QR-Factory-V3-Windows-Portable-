const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

let win;
let baseUrl;
let serverRef;

// ----------------------
// Persistent settings
// ----------------------
function settingsPath(){
  return path.join(app.getPath("userData"), "settings.json");
}

function readSettings(){
  try{
    const p = settingsPath();
    if(!fs.existsSync(p)) return { excelDir: "", publicUrl: "", recentExports: [] };
    const raw = fs.readFileSync(p, "utf8");
    const s = raw ? JSON.parse(raw) : {};
    return {
      excelDir: String(s.excelDir || ""),
      publicUrl: String(s.publicUrl || ""),
      recentExports: Array.isArray(s.recentExports) ? s.recentExports.slice(0, 12) : [],
    };
  }catch{
    return { excelDir: "", publicUrl: "", recentExports: [] };
  }
}

function writeSettings(next){
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2), "utf8");
}

function patchSettings(patch){
  const cur = readSettings();
  const next = { ...cur, ...patch };
  // basic cleanup
  next.excelDir = String(next.excelDir || "").trim();
  next.publicUrl = String(next.publicUrl || "").trim();
  next.recentExports = Array.isArray(next.recentExports) ? next.recentExports.slice(0, 12) : [];
  writeSettings(next);
  return next;
}

async function createWindow(){
  const { startServer } = require("./server");
  const started = await startServer(0);
  serverRef = started.server;
  baseUrl = `http://127.0.0.1:${started.port}`;

  // Apply persisted PUBLIC_BASE_URL at boot
  const s = readSettings();
  if(s.publicUrl) process.env.PUBLIC_BASE_URL = s.publicUrl;

  win = new BrowserWindow({
    width: 1200,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  await win.loadURL(`${baseUrl}/`);
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

// ----------------------
// Settings + dialogs
// ----------------------
ipcMain.handle("settings:get", async ()=>{
  return readSettings();
});

ipcMain.handle("settings:set", async (_e, patch)=>{
  const next = patchSettings(patch || {});
  if(typeof patch?.publicUrl === "string"){
    // update runtime for server-side buildScanUrl
    process.env.PUBLIC_BASE_URL = next.publicUrl;
  }
  return next;
});

ipcMain.handle("dialog:pickExcelFolder", async ()=>{
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  if(r.canceled || !r.filePaths?.[0]) return { canceled: true };
  const chosen = r.filePaths[0];
  const next = patchSettings({ excelDir: chosen });
  return { canceled: false, excelDir: next.excelDir };
});

ipcMain.handle("dialog:pickExcelFile", async ()=>{
  const r = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if(r.canceled || !r.filePaths?.[0]) return { canceled: true };
  return { canceled: false, filePath: r.filePaths[0] };
});

ipcMain.handle("fs:openPath", async (_e, p)=>{
  if(!p) return { ok:false, error:"Missing path" };
  const result = await shell.openPath(String(p));
  if(result) return { ok:false, error: result };
  return { ok:true };
});

// ----------------------
// Excel export/import (no CDN, fully offline)
// ----------------------
function sanitizeFileName(s){
  return String(s||"").replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/-+/g,"-").replace(/^[-.]+|[-.]+$/g, "");
}

async function apiGet(url){
  const u = new URL(url, baseUrl);
  const r = await fetch(u.toString(), { method: "GET" });
  const txt = await r.text();
  let data;
  try{ data = txt ? JSON.parse(txt) : {}; }catch{ data = { raw: txt }; }
  if(!r.ok) throw new Error((data && (data.error||data.message)) || `HTTP ${r.status}`);
  return data;
}

async function apiPost(url, body, headers){
  const u = new URL(url, baseUrl);
  const r = await fetch(u.toString(), {
    method: "POST",
    headers: { "Content-Type":"application/json", ...(headers||{}) },
    body: JSON.stringify(body||{})
  });
  const txt = await r.text();
  let data;
  try{ data = txt ? JSON.parse(txt) : {}; }catch{ data = { raw: txt }; }
  if(!r.ok) throw new Error((data && (data.error||data.message)) || `HTTP ${r.status}`);
  return data;
}

ipcMain.handle("excel:export", async ()=>{
  const XLSX = require("xlsx");
  const s = readSettings();
  if(!s.excelDir) throw new Error("Chưa chọn thư mục Excel. Hãy bấm 📁 Chọn thư mục trước.");

  const { rows } = await apiGet("/api/products");
  const products = (rows||[]).map(r => ({
    code: r.code,
    product_name: r.product_name,
    batch_serial: r.batch_serial,
    mfg_date: r.mfg_date,
    exp_date: r.exp_date,
    note_extra: r.note_extra,
    status: r.status,
    updated_at: r.updated_at,
  }));

  const wb = XLSX.utils.book_new();
  const wsP = XLSX.utils.json_to_sheet(products);
  wsP["!freeze"] = { xSplit: 0, ySplit: 1 };
  const range = XLSX.utils.decode_range(wsP["!ref"]);
  wsP["!autofilter"] = { ref: XLSX.utils.encode_range(range) };
  wsP["!cols"] = [
    { wch: 18 },{ wch: 22 },{ wch: 16 },{ wch: 12 },{ wch: 12 },{ wch: 22 },{ wch: 10 },{ wch: 26 }
  ];
  XLSX.utils.book_append_sheet(wb, wsP, "products");

  const configRows = [
    { key: "config.publicBaseUrl", value: s.publicUrl || process.env.PUBLIC_BASE_URL || "" },
    { key: "meta.generatedAt", value: new Date().toISOString() },
    { key: "meta.totalProducts", value: products.length },
  ];
  const wsC = XLSX.utils.json_to_sheet(configRows);
  wsC["!cols"] = [{ wch: 28 }, { wch: 64 }];
  XLSX.utils.book_append_sheet(wb, wsC, "config");

  const date = new Date().toISOString().slice(0,10);
  const fileName = sanitizeFileName(`qr-products-${date}.xlsx`) || `qr-products-${date}.xlsx`;
  const filePath = path.join(s.excelDir, fileName);

  XLSX.writeFile(wb, filePath);

  const next = patchSettings({
    recentExports: [{ filePath, ts: new Date().toISOString() }, ...(s.recentExports||[])].slice(0,12)
  });

  return { ok:true, filePath, settings: next };
});

ipcMain.handle("excel:import", async (_e, { filePath })=>{
  const XLSX = require("xlsx");
  if(!filePath) throw new Error("Missing filePath");
  if(!fs.existsSync(filePath)) throw new Error("File không tồn tại: " + filePath);

  const wb = XLSX.readFile(filePath, { cellDates: false });

  // 1) Config sheet: allow changing publicBaseUrl runtime
  let nextPublicUrl = "";
  if(wb.Sheets.config){
    const cfg = XLSX.utils.sheet_to_json(wb.Sheets.config, { defval: "" });
    for(const r of cfg){
      if(String(r.key||"").trim() === "config.publicBaseUrl"){
        nextPublicUrl = String(r.value||"").trim();
      }
    }
  }
  if(nextPublicUrl){
    patchSettings({ publicUrl: nextPublicUrl });
    process.env.PUBLIC_BASE_URL = nextPublicUrl;
  }

  // 2) products sheet -> bulk upsert
  if(!wb.Sheets.products) throw new Error("Excel thiếu sheet 'products'.");
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.products, { defval: "" });
  const cleaned = rows
    .map(r => ({
      code: String(r.code||"").trim(),
      product_name: String(r.product_name||"").trim(),
      batch_serial: String(r.batch_serial||"").trim(),
      mfg_date: String(r.mfg_date||"").trim(),
      exp_date: String(r.exp_date||"").trim(),
      note_extra: String(r.note_extra||"").trim(),
      status: String(r.status||"active").trim() || "active",
    }))
    .filter(r => r.code && r.product_name);

  const resp = await apiPost("/api/products/bulkUpsert", { rows: cleaned, source: path.basename(filePath) }, { "x-actor": "admin" });
  const settings = readSettings();
  return { ok:true, imported: resp.imported || 0, publicUrl: process.env.PUBLIC_BASE_URL || "", settings };
});

app.whenReady().then(createWindow);

app.on("window-all-closed", ()=>{
  if(process.platform !== "darwin") app.quit();
});

app.on("before-quit", ()=>{
  try{ serverRef && serverRef.close(); }catch{}
});

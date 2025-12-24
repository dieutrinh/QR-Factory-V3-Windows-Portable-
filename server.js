const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");

const app = express();
app.use(express.json({ limit: "2mb" }));

const DB_PATH = process.env.QR_DB || path.join(__dirname, "qr-factory.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  product_name TEXT NOT NULL,
  batch_serial TEXT,
  mfg_date TEXT,
  exp_date TEXT,
  note_extra TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_code ON products(code);
CREATE INDEX IF NOT EXISTS idx_products_product_name ON products(product_name);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  code TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_code ON audit_log(code);

-- CRM-lite
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contract_start TEXT,
  contract_end TEXT,
  product_type TEXT,
  contract_value REAL DEFAULT 0,
  status TEXT DEFAULT 'active',
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staff_name ON staff(name);

CREATE TABLE IF NOT EXISTS staff_customer (
  staff_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (staff_id, customer_id)
);

-- Demo auth: admin-code + one-time tokens for login/logout
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- login | logout
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_expires ON auth_tokens(expires_at);
`);

function nowIso() { return new Date().toISOString(); }

function normalizeDMY(s){
  if(!s) return "";
  const m = String(s).trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? m[0] : String(s).trim();
}

function makeCode(){
  const part = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${part()}-${part()}-${Date.now().toString(36).toUpperCase()}`;
}

function buildScanUrl(req, code){
  const publicBase = (process.env.PUBLIC_BASE_URL || "").trim(); // e.g. https://admin.yourdomain.com
  if(publicBase) return `${publicBase.replace(/\/$/,"")}/qr.html?token=${encodeURIComponent(code)}`;
  return `${req.protocol}://${req.get("host")}/qr.html?token=${encodeURIComponent(code)}`;
}

function logAudit({ actor, action, code, detail }){
  try{
    db.prepare(`INSERT INTO audit_log(ts, actor, action, code, detail_json) VALUES(?,?,?,?,?)`)
      .run(nowIso(), actor || "", action, code || "", JSON.stringify(detail || {}));
  }catch(_e){}
}

function getSetting(k, fallback=""){
  const row = db.prepare(`SELECT v FROM settings WHERE k=?`).get(k);
  return row ? String(row.v||"") : fallback;
}

function setSetting(k, v){
  db.prepare(`INSERT INTO settings(k,v,updated_at) VALUES(?,?,?)
    ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at`).run(k, String(v||""), nowIso());
}

// Ensure defaults
if(!getSetting("admin_code")) setSetting("admin_code", makeCode());
if(!getSetting("app_install_url")) setSetting("app_install_url", "https://example.com/app.apk");

app.get("/health", (_req, res)=>res.json({ ok:true, db: DB_PATH }));

app.get("/api/products", (req, res)=>{
  const q = String(req.query.q||"").trim();
  const since = String(req.query.since||"").trim();
  let rows;

  if(since){
    rows = db.prepare(`
      SELECT code, product_name, batch_serial, mfg_date, exp_date, note_extra, status, updated_at
      FROM products
      WHERE updated_at > ?
      ORDER BY updated_at DESC
      LIMIT 5000
    `).all(since);
    return res.json({ rows });
  }

  if(q){
    const like = `%${q}%`;
    rows = db.prepare(`
      SELECT code, product_name, batch_serial, mfg_date, exp_date, note_extra, status, updated_at
      FROM products
      WHERE code LIKE ? OR product_name LIKE ? OR batch_serial LIKE ?
      ORDER BY updated_at DESC
      LIMIT 2000
    `).all(like, like, like);
  } else {
    rows = db.prepare(`
      SELECT code, product_name, batch_serial, mfg_date, exp_date, note_extra, status, updated_at
      FROM products
      ORDER BY updated_at DESC
      LIMIT 5000
    `).all();
  }
  res.json({ rows });
});

app.get("/api/products/:code", (req, res)=>{
  const code = String(req.params.code||"").trim();
  const row = db.prepare(`
    SELECT code, product_name, batch_serial, mfg_date, exp_date, note_extra, status, updated_at, created_at
    FROM products WHERE code=?
  `).get(code);
  if(!row) return res.status(404).json({ error: "Not found" });
  res.json({ row });
});

// -------- Customers --------
app.get("/api/customers", (req, res)=>{
  const q = String(req.query.q||"").trim();
  let rows;
  if(q){
    const like = `%${q}%`;
    rows = db.prepare(`
      SELECT id, name, contract_start, contract_end, product_type, contract_value, status, note, updated_at
      FROM customers
      WHERE name LIKE ? OR product_type LIKE ? OR status LIKE ?
      ORDER BY updated_at DESC
      LIMIT 2000
    `).all(like, like, like);
  } else {
    rows = db.prepare(`
      SELECT id, name, contract_start, contract_end, product_type, contract_value, status, note, updated_at
      FROM customers
      ORDER BY updated_at DESC
      LIMIT 5000
    `).all();
  }
  res.json({ rows });
});

app.post("/api/customers/upsert", (req, res)=>{
  const actor = String(req.get("x-actor") || "").trim();
  const b = req.body || {};
  const id = Number(b.id||0) || 0;
  const name = String(b.name||"").trim();
  if(!name) return res.status(400).json({ error: "name is required" });
  const contract_start = normalizeDMY(b.contract_start);
  const contract_end = normalizeDMY(b.contract_end);
  const product_type = String(b.product_type||"").trim();
  const contract_value = Number(b.contract_value||0) || 0;
  const status = String(b.status||"active").trim().toLowerCase() || "active";
  const note = String(b.note||"").trim();
  const ts = nowIso();

  if(id){
    db.prepare(`UPDATE customers SET name=?, contract_start=?, contract_end=?, product_type=?, contract_value=?, status=?, note=?, updated_at=? WHERE id=?`)
      .run(name, contract_start, contract_end, product_type, contract_value, status, note, ts, id);
    logAudit({ actor, action: "UPSERT_CUSTOMER", code: String(id), detail: { name, product_type, status } });
    return res.json({ ok:true, id });
  }
  const info = db.prepare(`INSERT INTO customers(name, contract_start, contract_end, product_type, contract_value, status, note, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(name, contract_start, contract_end, product_type, contract_value, status, note, ts, ts);
  logAudit({ actor, action: "CREATE_CUSTOMER", code: String(info.lastInsertRowid), detail: { name, product_type, status } });
  res.json({ ok:true, id: info.lastInsertRowid });
});

app.post("/api/customers/delete", (req, res)=>{
  const actor = String(req.get("x-actor") || "").trim();
  const id = Number((req.body||{}).id||0) || 0;
  if(!id) return res.status(400).json({ error: "id is required" });
  db.prepare(`DELETE FROM staff_customer WHERE customer_id=?`).run(id);
  db.prepare(`DELETE FROM customers WHERE id=?`).run(id);
  logAudit({ actor, action: "DELETE_CUSTOMER", code: String(id), detail: {} });
  res.json({ ok:true });
});

// -------- Staff + assignments --------
app.get("/api/staff", (req, res)=>{
  const q = String(req.query.q||"").trim();
  let rows;
  if(q){
    const like = `%${q}%`;
    rows = db.prepare(`SELECT id, name, email, phone, note, updated_at FROM staff WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? ORDER BY updated_at DESC LIMIT 2000`)
      .all(like, like, like);
  } else {
    rows = db.prepare(`SELECT id, name, email, phone, note, updated_at FROM staff ORDER BY updated_at DESC LIMIT 5000`).all();
  }
  res.json({ rows });
});

app.post("/api/staff/upsert", (req, res)=>{
  const actor = String(req.get("x-actor") || "").trim();
  const b = req.body || {};
  const id = Number(b.id||0) || 0;
  const name = String(b.name||"").trim();
  if(!name) return res.status(400).json({ error: "name is required" });
  const email = String(b.email||"").trim();
  const phone = String(b.phone||"").trim();
  const note = String(b.note||"").trim();
  const ts = nowIso();
  if(id){
    db.prepare(`UPDATE staff SET name=?, email=?, phone=?, note=?, updated_at=? WHERE id=?`).run(name, email, phone, note, ts, id);
    logAudit({ actor, action: "UPSERT_STAFF", code: String(id), detail: { name } });
    return res.json({ ok:true, id });
  }
  const info = db.prepare(`INSERT INTO staff(name, email, phone, note, created_at, updated_at) VALUES(?,?,?,?,?,?)`).run(name, email, phone, note, ts, ts);
  logAudit({ actor, action: "CREATE_STAFF", code: String(info.lastInsertRowid), detail: { name } });
  res.json({ ok:true, id: info.lastInsertRowid });
});

app.post("/api/staff/delete", (req, res)=>{
  const actor = String(req.get("x-actor") || "").trim();
  const id = Number((req.body||{}).id||0) || 0;
  if(!id) return res.status(400).json({ error: "id is required" });
  db.prepare(`DELETE FROM staff_customer WHERE staff_id=?`).run(id);
  db.prepare(`DELETE FROM staff WHERE id=?`).run(id);
  logAudit({ actor, action: "DELETE_STAFF", code: String(id), detail: {} });
  res.json({ ok:true });
});

app.get("/api/assignments", (_req, res)=>{
  const rows = db.prepare(`
    SELECT sc.staff_id, s.name AS staff_name, sc.customer_id, c.name AS customer_name
    FROM staff_customer sc
    JOIN staff s ON s.id=sc.staff_id
    JOIN customers c ON c.id=sc.customer_id
    ORDER BY s.name, c.name
  `).all();
  res.json({ rows });
});

app.post("/api/assignments/set", (req, res)=>{
  const actor = String(req.get("x-actor") || "").trim();
  const b = req.body || {};
  const staff_id = Number(b.staff_id||0) || 0;
  const customer_id = Number(b.customer_id||0) || 0;
  const on = !!b.on;
  if(!staff_id || !customer_id) return res.status(400).json({ error: "staff_id and customer_id required" });
  if(on){
    db.prepare(`INSERT OR IGNORE INTO staff_customer(staff_id, customer_id, created_at) VALUES(?,?,?)`).run(staff_id, customer_id, nowIso());
  } else {
    db.prepare(`DELETE FROM staff_customer WHERE staff_id=? AND customer_id=?`).run(staff_id, customer_id);
  }
  logAudit({ actor, action: "SET_ASSIGNMENT", code: `${staff_id}:${customer_id}`, detail: { on } });
  res.json({ ok:true });
});

// -------- Demo login/logout via QR tokens --------
function makeToken(){
  const part = () => Math.random().toString(36).slice(2, 10);
  return `${part()}${part()}${Date.now().toString(36)}`;
}

app.get("/api/auth/public", (_req, res)=>{
  // Safe information for rendering the install/login page
  res.json({ app_install_url: getSetting("app_install_url"), has_admin_code: !!getSetting("admin_code") });
});

app.post("/api/auth/setAdminCode", (req, res)=>{
  const b = req.body || {};
  const current = String((b.current_admin_code||b.admin_code)||"").trim();
  const next = String(b.new_admin_code||"").trim();
  if(current !== getSetting("admin_code")) return res.status(403).json({ error: "admin_code invalid" });
  if(!next || next.length < 6) return res.status(400).json({ error: "new_admin_code too short" });
  setSetting("admin_code", next);
  logAudit({ actor: "admin", action: "ROTATE_ADMIN_CODE", code: "", detail: {} });
  res.json({ ok:true, admin_code: next });
});

app.post("/api/auth/setInstallUrl", (req, res)=>{
  const b = req.body || {};
  const admin = String(b.admin_code||"").trim();
  const url = String(b.app_install_url||"").trim();
  if(admin !== getSetting("admin_code")) return res.status(403).json({ error: "admin_code invalid" });
  if(!url) return res.status(400).json({ error: "app_install_url required" });
  setSetting("app_install_url", url);
  logAudit({ actor: "admin", action: "SET_INSTALL_URL", code: "", detail: { url } });
  res.json({ ok:true, app_install_url: url });
});

app.post("/api/auth/issue", (req, res)=>{
  const b = req.body || {};
  const admin = String(b.admin_code||"").trim();
  if(admin !== getSetting("admin_code")) return res.status(403).json({ error: "admin_code invalid" });
  const type = String(b.type||"login").trim().toLowerCase();
  if(type !== "login" && type !== "logout") return res.status(400).json({ error: "type must be login|logout" });
  const ttl = Math.max(1, Math.min(1440, Number(b.ttl_minutes||15) || 15));
  const token = makeToken();
  const expires_at = new Date(Date.now() + ttl*60*1000).toISOString();
  db.prepare(`INSERT INTO auth_tokens(token, type, expires_at, used_at, used_by, created_by, created_at)
    VALUES(?,?,?,?,?,?,?)`).run(token, type, expires_at, "", "", "admin", nowIso());
  const qr_url = `/login.html?token=${encodeURIComponent(token)}`;
  logAudit({ actor: "admin", action: "ISSUE_TOKEN", code: token, detail: { type, ttl } });
  res.json({ ok:true, token, type, expires_at, qr_url, url: qr_url });
});

app.post("/api/auth/consume", (req, res)=>{
  const b = req.body || {};
  const token = String(b.token||"").trim();
  const device = String(b.device_id||"").trim();
  if(!token) return res.status(400).json({ error: "token required" });
  const row = db.prepare(`SELECT token, type, expires_at, used_at FROM auth_tokens WHERE token=?`).get(token);
  if(!row) return res.status(404).json({ error: "token not found" });
  if(row.used_at) return res.status(409).json({ error: "token already used" });
  if(new Date(row.expires_at).getTime() < Date.now()) return res.status(410).json({ error: "token expired" });
  db.prepare(`UPDATE auth_tokens SET used_at=?, used_by=? WHERE token=?`).run(nowIso(), device||"device", token);
  logAudit({ actor: device||"device", action: "CONSUME_TOKEN", code: token, detail: { type: row.type } });
  res.json({ ok:true, action: row.type });
});

// QR helper: render QR for arbitrary text (used for app install / token URLs)
app.get("/api/qrtext/png", async (req, res)=>{
  const text = String(req.query.text||"").trim();
  if(!text) return res.status(400).send("missing text");
  try{
    const png = await QRCode.toBuffer(text, { type:"png", width: 512, margin: 2 });
    res.setHeader("Content-Type", "image/png");
    res.send(png);
  }catch(e){
    res.status(500).send(e.message||String(e));
  }
});

app.post("/api/generate", async (req, res)=>{
  const actor = String(req.get("x-actor") || "").trim();
  const body = req.body || {};
  const product_name = String(body.product_name||"").trim();
  if(!product_name) return res.status(400).json({ error: "product_name is required" });

  const code = String(body.code||"").trim() || makeCode();
  const batch_serial = String(body.batch_serial||"").trim();
  const mfg_date = normalizeDMY(body.mfg_date);
  const exp_date = normalizeDMY(body.exp_date);
  const note_extra = String(body.note_extra||"").trim();
  const status = String(body.status||"active").trim().toLowerCase();

  const created_at = nowIso();
  const updated_at = created_at;

  const insert = db.prepare(`
    INSERT INTO products(code, product_name, batch_serial, mfg_date, exp_date, note_extra, status, created_at, updated_at)
    VALUES (@code, @product_name, @batch_serial, @mfg_date, @exp_date, @note_extra, @status, @created_at, @updated_at)
    ON CONFLICT(code) DO UPDATE SET
      product_name=excluded.product_name,
      batch_serial=excluded.batch_serial,
      mfg_date=excluded.mfg_date,
      exp_date=excluded.exp_date,
      note_extra=excluded.note_extra,
      status=excluded.status,
      updated_at=excluded.updated_at
  `);

  try {
    insert.run({ code, product_name, batch_serial, mfg_date, exp_date, note_extra, status, created_at, updated_at });
    logAudit({ actor, action: "UPSERT_PRODUCT", code, detail: { product_name, batch_serial, mfg_date, exp_date, note_extra, status }});
  } catch (e){
    return res.status(500).json({ error: e.message || String(e) });
  }

  const scan_url = `/qr.html?token=${encodeURIComponent(code)}`;
  res.json({ code, scan_url });
});

// Bulk upsert from Excel import (offline admin tool)
app.post("/api/products/bulkUpsert", (req, res)=>{
  const actor = String(req.get("x-actor") || "").trim();
  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if(!rows.length) return res.json({ ok:true, imported: 0 });

  const insert = db.prepare(`
    INSERT INTO products(code, product_name, batch_serial, mfg_date, exp_date, note_extra, status, created_at, updated_at)
    VALUES (@code, @product_name, @batch_serial, @mfg_date, @exp_date, @note_extra, @status, @created_at, @updated_at)
    ON CONFLICT(code) DO UPDATE SET
      product_name=excluded.product_name,
      batch_serial=excluded.batch_serial,
      mfg_date=excluded.mfg_date,
      exp_date=excluded.exp_date,
      note_extra=excluded.note_extra,
      status=excluded.status,
      updated_at=excluded.updated_at
  `);

  const tx = db.transaction((rows)=>{
    let n = 0;
    for(const r of rows){
      const code = String(r.code||"").trim();
      const product_name = String(r.product_name||"").trim();
      if(!code || !product_name) continue;
      const batch_serial = String(r.batch_serial||"").trim();
      const mfg_date = normalizeDMY(r.mfg_date);
      const exp_date = normalizeDMY(r.exp_date);
      const note_extra = String(r.note_extra||"").trim();
      const status = String(r.status||"active").trim().toLowerCase() || "active";
      const created_at = nowIso();
      const updated_at = created_at;
      insert.run({ code, product_name, batch_serial, mfg_date, exp_date, note_extra, status, created_at, updated_at });
      n++;
    }
    return n;
  });

  try{
    const imported = tx(rows);
    logAudit({ actor, action: "BULK_IMPORT_EXCEL", code: "", detail: { imported, source: String(body.source||"") } });
    return res.json({ ok:true, imported });
  }catch(e){
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/qr/:code/png", async (req, res)=>{
  const code = String(req.params.code||"").trim();
  if(!code) return res.status(400).send("missing code");
  const url = buildScanUrl(req, code);
  try{
    const png = await QRCode.toBuffer(url, { type:"png", width: 512, margin: 2 });
    res.setHeader("Content-Type", "image/png");
    res.send(png);
  }catch(e){
    res.status(500).send(e.message||String(e));
  }
});

app.get("/api/qr/:code/pdf", async (req, res)=>{
  const code = String(req.params.code||"").trim();
  if(!code) return res.status(400).send("missing code");
  const scanUrl = buildScanUrl(req, code);

  try{
    const png = await QRCode.toBuffer(scanUrl, { type:"png", width: 800, margin: 2 });

    const doc = new PDFDocument({ size: "A4", margin: 36 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="qr-${code}.pdf"`);
    doc.pipe(res);

    doc.fontSize(18).fillColor("#111").text("QR Code", { align: "center" });
    doc.moveDown(0.6);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const qrSize = Math.min(360, pageWidth);
    const x = doc.page.margins.left + (pageWidth - qrSize) / 2;
    const y = doc.y + 8;
    doc.image(png, x, y, { width: qrSize, height: qrSize });

    doc.y = y + qrSize + 18;
    doc.fontSize(11).fillColor("#111").text("URL:", { align: "center" });
    doc.fontSize(10).fillColor("#111").text(scanUrl, { align: "center", link: scanUrl, underline: true });

    doc.end();
  }catch(e){
    res.status(500).send(e.message||String(e));
  }
});

app.get("/api/audit", (req, res)=>{
  const code = String(req.query.code||"").trim();
  const limit = Math.min(500, Math.max(1, Number(req.query.limit||100)));
  const rows = code
    ? db.prepare(`SELECT ts, actor, action, code, detail_json FROM audit_log WHERE code=? ORDER BY ts DESC LIMIT ?`).all(code, limit)
    : db.prepare(`SELECT ts, actor, action, code, detail_json FROM audit_log ORDER BY ts DESC LIMIT ?`).all(limit);
  res.json({ rows });
});

const fs = require("fs");
let WWW = path.join(__dirname, "www");
if(!fs.existsSync(WWW)) WWW = __dirname;
app.use(express.static(WWW, { extensions: ["html"] }));

app.get("/", (_req,res)=>res.sendFile(path.join(WWW, "index.html")));
app.get("/index.html", (_req,res)=>res.sendFile(path.join(WWW, "index.html")));

function startServer(port=0){
  console.log("Static WWW path:", WWW);
  console.log("PUBLIC_BASE_URL:", process.env.PUBLIC_BASE_URL || "(not set)");
  return new Promise((resolve, reject)=>{
    const server = app.listen(port, "127.0.0.1", ()=>{
      const address = server.address();
      resolve({ server, port: address.port });
    });
    server.on("error", reject);
  });
}

module.exports = { startServer };
if(require.main === module){
  const port = process.env.PORT ? Number(process.env.PORT) : 3131;
  startServer(port).then(({port})=>{
    console.log("QR Factory server listening on http://127.0.0.1:"+port);
  }).catch(e=>{
    console.error(e);
    process.exit(1);
  });
}

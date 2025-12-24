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

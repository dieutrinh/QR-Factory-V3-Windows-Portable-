const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");
const QRCode = require("qrcode");

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
`);

function nowIso() { return new Date().toISOString(); }

function normalizeDMY(s){
  // expects dd-mm-yyyy; keep as-is if matches, else empty
  if(!s) return "";
  const m = String(s).trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? m[0] : String(s).trim();
}

function makeCode(){
  // readable random code
  const part = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${part()}-${part()}-${Date.now().toString(36).toUpperCase()}`;
}

app.get("/health", (_req, res)=>res.json({ ok:true, db: DB_PATH }));

app.get("/api/products", (req, res)=>{
  const q = String(req.query.q||"").trim();
  let rows;
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

app.post("/api/generate", async (req, res)=>{
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
  } catch (e){
    return res.status(500).json({ error: e.message || String(e) });
  }

  const scan_url = `/qr.html?token=${encodeURIComponent(code)}`;
  res.json({ code, scan_url });
});

app.get("/api/qr/:code/png", async (req, res)=>{
  const code = String(req.params.code||"").trim();
  if(!code) return res.status(400).send("missing code");
  const url = `${req.protocol}://${req.get("host")}/qr.html?token=${encodeURIComponent(code)}`;
  try{
    const png = await QRCode.toBuffer(url, { type:"png", width: 512, margin: 2 });
    res.setHeader("Content-Type", "image/png");
    res.send(png);
  }catch(e){
    res.status(500).send(e.message||String(e));
  }
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

// Serve static UI
const WWW = path.join(__dirname, "www");
app.use(express.static(WWW, { extensions: ["html"] }));

// default
app.get("/", (_req,res)=>res.sendFile(path.join(WWW, "index.html")));

function startServer(port=0){
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

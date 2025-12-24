# QR Factory V3.1 (Trọn gói)

## Có sẵn trong ZIP này
- UI 3D buttons đồng bộ (Generate/Admin/Dashboard/Scan)
- PDF chuẩn: chỉ QR + URL (`GET /api/qr/:code/pdf`)
- QR PNG/PDF encode URL theo `PUBLIC_BASE_URL` để trỏ về server admin (khi deploy)
- Admin:
  - Search (Enter)
  - Check update (delta) theo `since` + highlight dòng đổi
  - Excel export: freeze header + autofilter + width cột
- Audit log (tuỳ chọn):
  - tự ghi khi tạo/cập nhật QR (UPSERT_PRODUCT)
  - xem qua API: `GET /api/audit?limit=100` hoặc `GET /api/audit?code=XXX`

---

## A. Chạy trên máy (Electron)
```bash
npm i
npm run start
```

## B. Chạy server online (Deploy)
```bash
npm i
# set domain admin để QR trỏ về server thật:
# Windows (cmd): set PUBLIC_BASE_URL=https://your-domain.com
# Linux/mac: export PUBLIC_BASE_URL=https://your-domain.com
npm run server
```

## C. Build Portable EXE (Windows)
```bash
npm run dist:win
# output: dist/QR Factory V3.1.exe
```

---

## Hướng dẫn upload lên GitHub để build đúng

### 1) Upload đúng source (KHÔNG upload file zip artifact)
Repo cần có:
- `.github/workflows/build-win.yml`
- `main.js`, `preload.js`, `server.js`, `package.json`, `README.md`
- thư mục `www/` bắt buộc: `index.html`, `admin.html`, `dashboard.html`, `qr.html`, `shared.css`, `qrFactoryV3.js`

### 2) Build bằng GitHub Actions
- Vào tab Actions → chọn workflow `Build QR Factory V3.1 (Windows Portable)` → Run workflow.
- Tải artifact `qr-factory-v31-portable` → lấy file EXE.

### 3) Nếu muốn encode QR về domain admin thật
- Trên server deploy set biến môi trường: `PUBLIC_BASE_URL=https://admin-domain.com`

---

## Workflow đã kèm sẵn
Xem `.github/workflows/build-win.yml`

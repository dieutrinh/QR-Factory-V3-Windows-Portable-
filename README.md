# QR Factory V3 (All-in-one)

## Chạy dev
```bash
npm i
npm run start
```

App Electron sẽ tự bật server local + mở UI.

## Chạy server riêng (online)
```bash
npm i
npm run server
# mở: http://127.0.0.1:3131
```

## Vấn đề V2 bạn gặp
`window.qrFactory.apiGet is not a function` xảy ra khi renderer gọi trực tiếp bridge nhưng preload chưa expose.

V3 có `www/qrFactoryV3.js`:
- Nếu có `window.qrFactory.apiGet/apiPost` (Electron) => dùng bridge
- Nếu chạy online => fallback dùng `fetch('/api/...')`

## API
- GET `/api/products` (+ q=...)
- POST `/api/generate`
- GET `/api/products/:code`
- GET `/api/qr/:code/png`

## Build portable EXE (Windows)
```bash
npm run dist:win
# file ra ở dist/
```

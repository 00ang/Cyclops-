# Van Eck Auto Body — Receiving Bridge

A parts check-in system for auto body shop receiving lanes. Drivers point their phone camera at parts as they unload, the system verifies them against the day's invoices, and flags wrong-lane / back-order anomalies in real time.

## What it does

- **Ingests CDK / Trax invoice PDFs** — drag, drop, parsed. Handles multi-page invoices, customer-copy/office-copy duplicates, and the three big part-number formats (Mopar `68472201AB`, Nissan `62022-5ZW0H`, Honda `91570-TVA-A01`).
- **Scans printed invoice barcodes** to look up an existing invoice without typing the number.
- **Scans part barcodes** with the phone camera (Code 128 / Code 39 / Data Matrix / QR — covers everything dealerships use).
- **Verifies against `shipped` qty, not `ordered`** — the critical detail. Back-ordered parts won't physically be in the lane, so checking against ordered would generate false misses on every Honda invoice.
- **Catches five anomaly types**: matched, wrong lane, duplicate, back-order anomaly (something supposedly back-ordered showed up anyway), and unknown.
- **Persists locally** — invoices and scan history survive reloads. No backend required.

## Local development

```bash
npm install
npm run dev
```

The dev server binds to `0.0.0.0:5173` so you can hit it from your phone on the same Wi-Fi. **But** browsers require HTTPS for camera access, so for phone-camera testing you'll need one of the deployment options below, or a localhost tunnel.

### Quick HTTPS for phone testing (localtunnel)

```bash
npm install -g localtunnel
npm run dev               # in one terminal
lt --port 5173            # in another — gives you an HTTPS URL
```

Open that URL on your phone, grant camera permission, scan something.

## Deploy to production

Pick one. All three are free, all three give you HTTPS automatically.

### Option 1 — Vercel (fastest)

```bash
npm install -g vercel
vercel
```

Follow the prompts, accept the defaults. Done. You'll get a URL like `van-eck-receiving.vercel.app`.

### Option 2 — Netlify

```bash
npm install -g netlify-cli
npm run build
netlify deploy --prod --dir=dist
```

### Option 3 — Cloudflare Pages

```bash
npm install -g wrangler
npm run build
wrangler pages deploy dist
```

### Option 4 — GitHub + auto-deploy

1. `git init && git add . && git commit -m "initial"`
2. Push to a new GitHub repo
3. Go to vercel.com → Import Project → pick the repo → deploy
4. Future `git push`es auto-deploy

## How drivers use it

1. **Morning**: receiving manager drops the day's invoice PDFs onto the dashboard. System parses every line item.
2. **In the lane**: driver opens the app, taps an invoice, hits SCAN MODE, taps START CAMERA.
3. **Each part gets pointed at**: green flash + chime = match, red flash + buzz = anomaly. Driver decides whether to set it aside.
4. **Wrong-lane catch**: if a part on lane A actually belongs to invoice on lane B, the system says so by name.

## Architecture notes

- **PDF parsing**: pdf.js loaded from CDN at runtime. Extracts text with x/y positions, groups items into lines by y-coordinate, splits multi-invoice pages, deduplicates customer/office copies, merges multi-page invoices by invoice number.
- **Barcode scanning**: ZXing-js. Loads on first scan from CDN with multi-source fallback (unpkg → jsdelivr → cdnjs). Uses direct `getUserMedia` to acquire the camera (rear-facing preferred), then hands the live MediaStream to ZXing for continuous decoding.
- **Persistence**: browser `localStorage`. Capped at 500 scan events.
- **Single-file React component** in `src/PartsCheckInSystem.jsx`. Tailwind for layout. IBM Plex Mono / Plex Sans loaded from Google Fonts.

## Aesthetic

Institutional / utilitarian — like a Bloomberg terminal married a SEC filing. Functional density over flourish. No rounded corners, no gradients, no animations except the scanline. Designed to look like a logistics tool, not an "app".

## Caveats

- **Camera requires HTTPS**. localhost and `127.0.0.1` work for dev; otherwise you need a real cert (which Vercel/Netlify/etc give you free).
- **iOS Safari** requires an explicit user gesture to start the camera — that's why there's a START CAMERA button rather than auto-starting.
- **PDF parser** was tuned against Zeigler-format invoices. A new vendor with a different column layout may need parser tweaks. There's a "RAW PARSE OUTPUT" debug panel on every invoice to help diagnose what the parser saw.
- **localStorage is per-browser, per-device**. Multi-device sync would need a backend (Supabase, Firebase, anything with a database — ~150 lines to wire up if it ever matters).

## Future work

- Print signed receipt of completed lane (PDF export)
- Sync to CDK directly (their API exists but the dealership has to enable it)
- Photograph anomalies for the dispute trail
- Driver login / per-driver accountability
- Push notification when a back-ordered part eventually arrives

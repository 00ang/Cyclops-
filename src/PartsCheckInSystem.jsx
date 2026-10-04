import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Upload, Camera, X, Check, AlertTriangle, Package, ChevronRight, Search, Trash2, Download,
  RefreshCw, Eye, EyeOff, FileSearch, Printer, FileDown, History, ArrowLeft, ScanLine,
  Keyboard, Flashlight, FlashlightOff, Square, RotateCcw, Play, Pause, GripVertical,
  Merge, Split, ClipboardList
} from 'lucide-react';
import {
  STORE_TEMPLATES,
  PART_NUMBER_REGEX,
  detectStore,
  detectFormat,
  detectRouteReport,
  parseRouteReportRow,
  parseLineItems,
  normalizePartNumber
} from './invoiceParse.js';

// ============================================================
// PARTS CHECK-IN SYSTEM v2.0
// PDF ingestion + barcode scanning + persistence
// ============================================================

const STORAGE_KEYS = {
  INVOICES: 'invoices:list',
  SCAN_LOG: 'scans:log',
  STOP_ORDER: 'stops:order',
  // { savedAt } — when the session blob was last written. Used on load to
  // decide whether a saved session is "today's" (offer to resume) or stale
  // (never shown again).
  SESSION_META: 'session:meta'
};

async function loadFromStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    if (value) return JSON.parse(value);
    return fallback;
  } catch {
    return fallback;
  }
}

async function saveToStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('Storage save failed:', e);
    return false;
  }
}

function clearStoredSession() {
  for (const key of Object.values(STORAGE_KEYS)) {
    try { localStorage.removeItem(key); } catch (e) { /* private mode etc. */ }
  }
}

// Local-calendar-day key (not UTC) — a dock shift that starts at 05:30 and a
// save at 23:50 the night before must be different days.
function localDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// Read whatever was persisted and classify it. Returns null when there is
// nothing worth offering (no invoices, or the session is from another day).
// `savedAt` falls back to the newest timestamp inside the data so sessions
// written before SESSION_META existed are still dated correctly.
async function readStoredSession() {
  const invoices = await loadFromStorage(STORAGE_KEYS.INVOICES, []);
  const scanLog = await loadFromStorage(STORAGE_KEYS.SCAN_LOG, []);
  const stopOrder = await loadFromStorage(STORAGE_KEYS.STOP_ORDER, []);
  const meta = await loadFromStorage(STORAGE_KEYS.SESSION_META, null);

  const realInvoices = Array.isArray(invoices)
    ? invoices.filter(inv => inv && Array.isArray(inv.lineItems) && !String(inv.id || '').startsWith('sample_'))
    : [];
  if (realInvoices.length === 0) return null;

  const log = Array.isArray(scanLog) ? scanLog : [];
  let savedAt = meta && Number.isFinite(meta.savedAt) ? meta.savedAt : 0;
  if (!savedAt) {
    for (const inv of realInvoices) {
      if (Number.isFinite(inv.createdAt)) savedAt = Math.max(savedAt, inv.createdAt);
      for (const li of inv.lineItems) {
        if (Number.isFinite(li.checkedAt)) savedAt = Math.max(savedAt, li.checkedAt);
      }
    }
    for (const l of log) {
      if (Number.isFinite(l.fullTs)) savedAt = Math.max(savedAt, l.fullTs);
    }
  }
  if (!savedAt) return null;

  return {
    invoices: realInvoices,
    scanLog: log,
    stopOrder: Array.isArray(stopOrder) ? stopOrder : [],
    savedAt,
    isToday: localDayKey(savedAt) === localDayKey(Date.now())
  };
}

// ---------- PDF.js loader ----------
// Prefer npm-bundled pdfjs-dist (dynamic import + Vite worker URL) so dock WiFi
// / CDN blocks don't break invoice parsing. CDN script tags are last-resort only.
let pdfjsLoadPromise = null;
function loadPdfJs() {
  if (pdfjsLoadPromise) return pdfjsLoadPromise;
  pdfjsLoadPromise = (async () => {
    // 1) Bundled package — works offline after first visit (PWA caches the chunk).
    try {
      const pdfjs = await import('pdfjs-dist');
      const workerMod = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      const workerSrc = typeof workerMod === 'string' ? workerMod : workerMod.default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
      return pdfjs;
    } catch (e) {
      console.warn('[pdf] bundled pdfjs-dist import failed, trying CDN:', e);
    }

    if (window.pdfjsLib) return window.pdfjsLib;

    // 2) CDN fallback — last resort only (version aligned with prior dock builds).
    const CDN_VER = '4.10.38';
    const sources = [
      `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${CDN_VER}/pdf.min.mjs`,
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${CDN_VER}/build/pdf.min.mjs`
    ];
    // UMD classic script fallback (3.11) if module CDN also fails
    return await new Promise((resolve, reject) => {
      let attempt = 0;
      const tryModule = async () => {
        if (attempt >= sources.length) return tryUmd();
        const url = sources[attempt++];
        try {
          const pdfjs = await import(/* @vite-ignore */ url);
          const lib = pdfjs.default || pdfjs;
          lib.GlobalWorkerOptions.workerSrc =
            `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${CDN_VER}/pdf.worker.min.mjs`;
          resolve(lib);
        } catch {
          tryModule();
        }
      };
      const tryUmd = () => {
        if (window.pdfjsLib) return resolve(window.pdfjsLib);
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        script.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
          resolve(window.pdfjsLib);
        };
        script.onerror = () => reject(new Error('Failed to load pdf.js (bundled + all CDN sources)'));
        document.head.appendChild(script);
      };
      tryModule();
    });
  })();
  return pdfjsLoadPromise;
}

// ---------- ZXing loader ----------
// Prefer the npm-bundled @zxing/library (dynamic import) so dock WiFi / CDN
// outages don't block scanning. CDN script tags are last-resort only.
let zxingLoadPromise = null;
function findZXingNamespace() {
  const candidates = [
    window.ZXing,
    window.ZXingBrowser,
    window.ZXingJs,
    window.zxing
  ].filter(Boolean);
  for (const ns of candidates) {
    if (ns && (ns.BrowserMultiFormatReader || ns.MultiFormatReader ||
               ns.default?.BrowserMultiFormatReader || ns.default?.MultiFormatReader)) {
      return (ns.BrowserMultiFormatReader || ns.MultiFormatReader) ? ns : ns.default;
    }
  }
  return null;
}

function zxingLooksUsable(ns) {
  return !!(ns && (ns.MultiFormatReader || ns.BrowserMultiFormatReader) &&
    (ns.HTMLCanvasElementLuminanceSource || ns.BrowserMultiFormatReader));
}

function loadZXing() {
  if (zxingLoadPromise) return zxingLoadPromise;
  zxingLoadPromise = (async () => {
    // 1) Bundled package — works offline and on restricted dock WiFi.
    try {
      const mod = await import('@zxing/library');
      const ns = mod?.default && zxingLooksUsable(mod.default) ? mod.default
        : (zxingLooksUsable(mod) ? mod : null);
      if (ns) return ns;
    } catch (e) {
      console.warn('[scanner] bundled @zxing/library import failed, trying CDN:', e);
    }

    const existing = findZXingNamespace();
    if (existing) return existing;

    // 2) CDN fallback — last resort only.
    const sources = [
      'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js',
      'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/zxing-js/0.21.3/index.min.js'
    ];
    return await new Promise((resolve, reject) => {
      let attempt = 0;
      const tryNext = () => {
        if (attempt >= sources.length) {
          return reject(new Error('Failed to load ZXing barcode library (bundled + all CDN sources)'));
        }
        const script = document.createElement('script');
        script.src = sources[attempt++];
        script.async = true;
        script.onload = () => {
          const ns = findZXingNamespace();
          if (ns) resolve(ns);
          else tryNext();
        };
        script.onerror = () => tryNext();
        document.head.appendChild(script);
      };
      tryNext();
    });
  })();
  return zxingLoadPromise;
}

// ---------- Tesseract.js loader (lazy — only loaded if OCR is needed) ----------
let tesseractLoadPromise = null;
function loadTesseract() {
  if (tesseractLoadPromise) return tesseractLoadPromise;
  tesseractLoadPromise = new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve(window.Tesseract);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js';
    script.async = true;
    script.onload = () => {
      if (window.Tesseract) resolve(window.Tesseract);
      else reject(new Error('Tesseract loaded but global not found'));
    };
    script.onerror = () => reject(new Error('Failed to load Tesseract.js'));
    document.head.appendChild(script);
  });
  return tesseractLoadPromise;
}

// Render a single PDF page to a canvas, run OCR, and return PDF.js-style items.
async function ocrPdfPage(pdf, pageNum, onProgress) {
  const Tesseract = await loadTesseract();
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  const { data } = await Tesseract.recognize(canvas, 'eng', {
    logger: (m) => {
      if (onProgress && m.status === 'recognizing text') {
        onProgress(`OCR page ${pageNum}: ${Math.round((m.progress || 0) * 100)}%`);
      }
    }
  });

  const words = data.words || [];
  return words
    .filter(w => w && w.text && w.text.trim() && w.bbox)
    .map(w => ({
      str: w.text,
      x: w.bbox.x0,
      y: viewport.height - w.bbox.y0,
      w: w.bbox.x1 - w.bbox.x0,
      h: w.bbox.y1 - w.bbox.y0
    }));
}

// ============================================================
// PDF PARSER
// ============================================================
async function parseInvoicePDF(file, onProgress) {
  const pdfjs = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;

  const allPagesText = [];
  let totalItems = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const textContent = await page.getTextContent();
    const items = textContent.items.map(it => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width,
      h: it.height
    }));
    totalItems += items.length;
    allPagesText.push({ pageNum: p, items });
  }

  let usedOcr = false;

  // Fallback: scanned PDF with no text layer — OCR each page.
  if (totalItems === 0) {
    usedOcr = true;
    onProgress?.('Scanned PDF detected — loading OCR engine...');
    allPagesText.length = 0;
    try {
      for (let p = 1; p <= pdf.numPages; p++) {
        onProgress?.(`OCR page ${p}/${pdf.numPages}...`);
        const items = await ocrPdfPage(pdf, p, onProgress);
        totalItems += items.length;
        allPagesText.push({ pageNum: p, items });
      }
    } catch (err) {
      return {
        invoices: [],
        rawText: '',
        pageCount: pdf.numPages,
        reason: `OCR failed: ${err.message}. The PDF appears to be scanned/image-only and could not be recognized.`,
        usedOcr: true
      };
    }
  }

  const rawDump = allPagesText.map(pg => {
    const sorted = [...pg.items].sort((a, b) => Math.abs(a.y - b.y) < 3 ? a.x - b.x : b.y - a.y);
    return `--- page ${pg.pageNum} ---\n` + sorted.map(it => it.str).join(' ');
  }).join('\n');

  if (totalItems === 0) {
    return {
      invoices: [],
      rawText: '',
      pageCount: pdf.numPages,
      reason: usedOcr
        ? `OCR ran but produced no text on ${pdf.numPages} page(s). The scan may be too low-resolution or the page may be blank.`
        : `PDF has no extractable text (${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}).`,
      usedOcr
    };
  }

  const invoices = parseInvoicesFromPages(allPagesText);
  if (invoices.length === 0) {
    console.warn('[parseInvoicePDF] No invoices detected. Extracted text:\n', rawDump);
  }
  return {
    invoices,
    rawText: rawDump,
    pageCount: pdf.numPages,
    reason: invoices.length === 0
      ? (usedOcr
          ? 'OCR ran but no invoice number could be identified in the recognized text.'
          : 'Text was extracted but no invoice number could be identified.')
      : null,
    usedOcr
  };
}

// Route report ingest path
// ----------------------------------------------------------------------------
// Some users upload a daily route manifest PDF instead of (or in addition to)
// the individual invoice PDFs. The manifest is a tabular report — one row per
// part, with explicit columns for Account Name, Invoice#, Part Count, Price,
// and Part#. This path parses that report directly, which is much more
// reliable than per-invoice block parsing because every column is unambiguous.
//
// Tradeoffs vs. individual invoices:
//   - We get the customer (stop), invoice number, and part number cleanly.
//   - We do NOT get per-part qty or back-order status, so every line item
//     is created with ordered=1 / shipped=1 / backOrdered=0. Multi-unit
//     line items (e.g. "11 of part 6510359AA") would parse as one unit.
//   - Description is a placeholder ("PART") since the report has no desc.
//   - Vendor is left generic ('ZEIGLER AUTO GROUP') — not in the report.
// Uploading a per-invoice PDF after the route report fills in the missing
// detail; the merge logic in handleFileUpload prefers detailed invoices over
// placeholder ones.

function parseRouteReport(allLines) {
  const rows = [];
  for (const line of allLines) {
    const text = line.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
    const row = parseRouteReportRow(text);
    if (row) rows.push(row);
  }
  if (rows.length === 0) return [];

  // Group by invoice number — preserve customer / partCount / invoiceTotal
  // from the first row we see for each invoice.
  const byInvoice = new Map();
  for (const r of rows) {
    if (!byInvoice.has(r.invoiceNumber)) {
      byInvoice.set(r.invoiceNumber, {
        invoiceNumber: r.invoiceNumber,
        customer: r.customer,
        partCount: r.partCount,
        invoiceTotal: r.invoiceTotal,
        parts: []
      });
    }
    byInvoice.get(r.invoiceNumber).parts.push({
      partNumber: r.partNumber,
      description: r.description,
      qty: r.qty
    });
  }

  return Array.from(byInvoice.values()).map(inv => {
    const lineItems = inv.parts.map(p => {
      const isBackOrdered = p.qty === 0;
      return {
        partNumber: p.partNumber,
        description: p.description || 'PART',
        // ordered tracks "what was on the order" — at least 1 since this
        // line exists on the invoice. shipped tracks what physically
        // arrived (0 for back-ordered, qty otherwise). backOrdered is the
        // count we know didn't ship.
        ordered: Math.max(p.qty, 1),
        shipped: p.qty,
        backOrdered: isBackOrdered ? 1 : 0,
        listPrice: 0,
        netPrice: 0,
        amount: 0,
        checked: false,
        scanStatus: null,
        checkedAt: null,
        note: isBackOrdered
          ? 'Back-ordered (qty 0 on report) — should not be in shipment'
          : null,
        qtyParseQuality: 'route_report',
        unitsExpected: p.qty,
        unitsScanned: 0
      };
    });
    return {
      id: `inv_${inv.invoiceNumber}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      invoiceNumber: inv.invoiceNumber,
      accountNumber: null,
      vendor: 'ZEIGLER AUTO GROUP',
      location: '',
      customer: inv.customer,
      customerAddress: null,
      dateShipped: '',
      shipVia: '',
      salesman: '',
      yourOrderNo: '',
      vin: null,
      vehicle: '',
      terms: '',
      total: inv.invoiceTotal,
      lineItems,
      createdAt: Date.now(),
      rawText: '(parsed from route report)',
      fromRouteReport: true
    };
  });
}

function parseInvoicesFromPages(pages) {
  const allInvoiceBlocks = [];
  const allLines = [];

  for (const page of pages) {
    const sorted = [...page.items].sort((a, b) => {
      if (Math.abs(a.y - b.y) < 3) return a.x - b.x;
      return b.y - a.y;
    });

    const lines = [];
    let currentLine = null;
    for (const item of sorted) {
      if (!currentLine || Math.abs(currentLine.y - item.y) > 4) {
        currentLine = { y: item.y, items: [item] };
        lines.push(currentLine);
      } else {
        currentLine.items.push(item);
      }
    }
    allLines.push(...lines);

    const blocks = splitPageIntoInvoiceBlocks(lines);
    allInvoiceBlocks.push(...blocks);
  }

  // Route-report fast path. Some users upload a daily manifest PDF that lists
  // every stop / invoice / part on the route in a tabular form (one row per
  // part). When we see that header signature, parse it row-by-row and skip
  // the per-invoice block parser entirely — the columnar data is much cleaner
  // than the per-invoice layouts and gives us all stops in one shot.
  const wholeText = allLines.map(l => l.items.map(i => i.str).join(' ')).join('\n');
  if (detectRouteReport(wholeText)) {
    const routeInvoices = parseRouteReport(allLines);
    if (routeInvoices.length > 0) return routeInvoices;
    // If detection succeeded but no rows parsed, fall through to the normal
    // path — better to try than to return nothing.
  }

  const merged = new Map();
  for (const block of allInvoiceBlocks) {
    const parsed = parseInvoiceBlock(block);
    if (!parsed || !parsed.invoiceNumber) continue;
    const key = parsed.invoiceNumber;
    if (!merged.has(key)) {
      merged.set(key, parsed);
    } else {
      const existing = merged.get(key);
      const existingKeys = new Set(existing.lineItems.map(li => `${li.partNumber}|${li.description}|${li.ordered}|${li.shipped}`));
      for (const li of parsed.lineItems) {
        const k = `${li.partNumber}|${li.description}|${li.ordered}|${li.shipped}`;
        if (!existingKeys.has(k)) {
          existing.lineItems.push(li);
          existingKeys.add(k);
        }
      }
      if (!existing.vin && parsed.vin) existing.vin = parsed.vin;
      if (!existing.vehicle && parsed.vehicle) existing.vehicle = parsed.vehicle;
    }
  }

  // Safety net: when block-by-block parsing yielded no invoice (e.g. invoice
  // number couldn't be located, or the splitter didn't recognize headers in a
  // new digital-PDF or Excel-converted layout), do a whole-document scan for
  // line items and synthesize an invoice from whatever we can recover. The
  // user gets parts on screen rather than an empty result.
  if (merged.size === 0 && allLines.length > 0) {
    const allText = allLines.map(l => l.items.map(i => i.str).join(' ')).join('\n');
    const format = detectFormat(allText);
    const store = detectStore(allText);
    const template = (store === 'unknown' && format === 'cdk_screen')
      ? STORE_TEMPLATES.ford_cdk
      : STORE_TEMPLATES[store];

    let items = format === 'cdk_screen'
      ? parseCdkLineItems(allLines, template)
      : parseLineItems(allLines, template);
    if (items.length === 0) {
      // Fall through to the other parser if the chosen one matched nothing
      items = format === 'cdk_screen'
        ? parseLineItems(allLines, template)
        : parseCdkLineItems(allLines, template);
    }

    if (items.length > 0) {
      let synthInv = null;
      const labelMatch = allText.match(/(?:^|\n)\s*(?:Number|INVOICE\s*(?:NUMBER|NO\.?|#))\s*[:.]?\s*(\d{6,7}(?:[A-Z]\d{1,2})?)\b/i);
      if (labelMatch) synthInv = labelMatch[1].toUpperCase();
      if (!synthInv) {
        const any = allText.match(/\b(\d{6,7}(?:[A-Z]\d{1,2})?)\b/);
        if (any) synthInv = any[1].toUpperCase();
      }
      if (!synthInv) synthInv = `UNK-${Date.now().toString(36).toUpperCase()}`;

      merged.set(synthInv, {
        id: `inv_${synthInv}_${Date.now()}`,
        invoiceNumber: synthInv,
        accountNumber: null,
        vendor: template.vendor,
        location: template.location,
        customer: extractCustomer(allText) || '— UNKNOWN LANE —',
        customerAddress: null,
        dateShipped: '',
        shipVia: '',
        salesman: '',
        yourOrderNo: '',
        vin: null,
        vehicle: '',
        terms: '',
        total: null,
        lineItems: items,
        createdAt: Date.now(),
        rawText: allText.slice(0, 5000)
      });
    }
  }

  return Array.from(merged.values());
}

// Header signal score: each match adds to the line's anchor strength.
// A new invoice block starts on a line whose score is >= 1 AND the previous
// candidate is at least MIN_BLOCK_LINES old (so we don't split on a header
// row that's part of the same invoice's body — e.g. continuation pages).
function headerScore(text) {
  let score = 0;
  if (/DATE\s+ENTERED.*YOUR\s+ORDER/i.test(text)) score += 2;
  if (/^\s*ZEIGLE/i.test(text)) score += 2;
  if (/\bAUTO\s+GROUP\b/i.test(text)) score += 1;
  if (/\bINVOICE\s*(?:NUMBER|NO\.?|#)\b/i.test(text)) score += 2;
  if (/\bPARTS\s+INVOICE\b/i.test(text)) score += 2;
  if (/\bPACKING\s+(?:SLIP|LIST)\b/i.test(text)) score += 2;
  if (/\bBILL\s+TO\b/i.test(text)) score += 1;
  if (/\bREMIT\s+TO\b/i.test(text)) score += 1;
  if (/\bSHIP\s+TO\b/i.test(text)) score += 1;
  if (/\bACCOUNT\s+NO\.?\b/i.test(text)) score += 1;
  // CDK on-screen "CLOSED INVOICE" / "OPEN INVOICE" capture markers
  if (/\b(?:CLOSED|OPEN)\s+INVOICE\b/i.test(text)) score += 2;
  if (/^\s*Number\s*:\s*\d{6,7}/i.test(text)) score += 2;
  return score;
}

const MIN_BLOCK_LINES = 4;

function splitPageIntoInvoiceBlocks(lines) {
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const text = line.items.map(i => i.str).join(' ');
    const score = headerScore(text);
    const isStrongHeader = score >= 2;

    if (isStrongHeader) {
      if (current && current.lines.length >= MIN_BLOCK_LINES) blocks.push(current);
      current = { lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      // No block started yet — start one anyway so we don't drop pre-header content.
      current = { lines: [line] };
    }
  }
  if (current && current.lines.length >= MIN_BLOCK_LINES) blocks.push(current);

  if (blocks.length === 0 && lines.length > 0) {
    blocks.push({ lines });
  }

  return blocks;
}

// Bounded Levenshtein edit distance. Early-outs when the length gap alone
// exceeds the cap, since we only care about near-matches.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 4) return 99;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Find the closest still-open shipped line to a scanned (normalized) code.
// Used as a "did you mean?" fallback when a scan doesn't cleanly match —
// the part/barcode formats whose normalization doesn't reconcile yet. Only
// considers lines with shipped > 0 and remaining capacity (the lines a
// driver could legitimately be trying to check in). Returns the best
// candidate within a tight similarity threshold, or null.
//   - `normalize` is passed in so this stays in sync with the scan matcher's
//     exact normalization (separators, AIAG prefix, leading zeros).
//   - Containment (one normalized string inside the other, ≥6 chars) scores
//     by length gap; otherwise we use bounded edit distance.
function findNearestLine(scannedNorm, invoices, normalize) {
  if (!scannedNorm || scannedNorm.length < 4) return null;
  let best = null;
  for (let i = 0; i < invoices.length; i++) {
    const items = invoices[i].lineItems;
    for (let j = 0; j < items.length; j++) {
      const li = items[j];
      if (!(li.shipped > 0)) continue;
      if (((li.unitsScanned || 0) + (li.unitsSkipped || 0)) >= li.unitsExpected) continue;
      const pNorm = normalize(li.partNumber);
      if (!pNorm || pNorm === scannedNorm) continue;
      let score;
      const bothLong = pNorm.length >= 6 && scannedNorm.length >= 6;
      if (bothLong && (pNorm.includes(scannedNorm) || scannedNorm.includes(pNorm))) {
        score = Math.abs(pNorm.length - scannedNorm.length);
      } else {
        score = levenshtein(pNorm, scannedNorm);
      }
      const maxAllowed = Math.max(2, Math.floor(Math.max(pNorm.length, scannedNorm.length) * 0.25));
      if (score <= maxAllowed && (!best || score < best.score)) {
        best = {
          score,
          invIdx: i,
          itemIdx: j,
          partNumber: li.partNumber,
          description: li.description,
          customer: invoices[i].customer,
          unitsExpected: li.unitsExpected,
          unitsScanned: li.unitsScanned || 0
        };
      }
    }
  }
  return best;
}

// Detect which Zeigler store an invoice block belongs to.
// Returns: 'orland_park' | 'kalamazoo' | 'grandville' | 'unknown'
//
// Only checks the header area (top 12 lines). Van Eck's customer address
// also contains "GRANDVILLE", so a whole-document scan would falsely
// identify every invoice as Grandville, which then forces the wrong
// invoice-number priority and template defaults.
// Extract the customer (the body shop / lane the parts are going to) from
// the invoice text. Tries common dealer-invoice labels in priority order.
// Returns null when nothing plausible matches; the caller is expected to
// surface that as an unknown lane in the UI rather than guess.
// Words that are never customer names: dealer letterhead, header-cell labels,
// totals-row labels, footer-row legal text, courier names. The block-position
// fallback can otherwise catch any of these by mistake.
const CUSTOMER_STOP_WORDS = /^(?:ZEIGLER|FORD|HONDA|NISSAN|MOPAR|CDJR|TOYOTA|GMC|CHEVROLET|DEALER|MERCEDES|BENZ|ACCOUNT|PAGE|INVOICE|DATE|ORDER|PHONE|TOLL|PARTS|SUBLET|FREIGHT|TOTAL|SUBTOTAL|TERMS|SHIP|BILL|SOLD|REMIT|VIA|SLSM|FOB|RETURN|REFUND|LINE|FREE|DEALERSHIP|DEALERSHI|COMP|YOUR|CUSTOMER|OFFICE|COPY|RECEIVED|BACKORDER|DESCRIPTION|AMOUNT|FOLLOWING|CHARGE|WHOLESALE|RAINBOW|WARRANTY|WARRANTIES|DISCLAIMER|TRACKING)\b/i;

function isPlausibleCustomer(name) {
  if (!name) return null;
  const cleaned = name.trim().replace(/\s+/g, ' ');
  if (cleaned.length < 5 || cleaned.length > 60) return null;
  if (CUSTOMER_STOP_WORDS.test(cleaned)) return null;
  // Must contain at least 2 alpha words to look like a shop name
  if ((cleaned.match(/\b[A-Z][A-Z'\-]+\b/g) || []).length < 2) return null;
  return cleaned;
}

function extractCustomer(text) {
  // (1) Labelled patterns — works when the label sits horizontally adjacent
  // to the value (CDK on-screen "Name: …", Excel-to-PDF, modern dealer
  // formats with "BILL TO: …" on a single line).
  const NAME = "([A-Z][A-Z0-9 &\\-,'./]{2,58})";
  const labelled = [
    new RegExp(`\\bSHIP\\s+TO\\b\\s*[:.]?\\s*\\n?\\s*${NAME}(?:\\n|\\s{2}|$)`, 'i'),
    new RegExp(`\\bBILL\\s+TO\\b\\s*[:.]?\\s*\\n?\\s*${NAME}(?:\\n|\\s{2}|$)`, 'i'),
    new RegExp(`\\bSOLD\\s+TO\\b\\s*[:.]?\\s*\\n?\\s*${NAME}(?:\\n|\\s{2}|$)`, 'i'),
    new RegExp(`\\bCUSTOMER\\b\\s*[:.]?\\s*\\n?\\s*${NAME}(?:\\n|\\s{2}|$)`, 'i'),
    new RegExp(`\\bName\\b\\s*[:.]?\\s*${NAME}(?=\\s+(?:Zone|Sale|Tax|Cust|Addr)\\s*:|\\s*\\n|$)`, 'i')
  ];
  for (const re of labelled) {
    const m = text.match(re);
    const name = m && isPlausibleCustomer(m[1]);
    if (name) return name;
  }

  // (2) Block-position fallback — for printed dealer invoices (Zeigler etc.)
  // where SOLD TO / SHIP TO labels are stacked vertically as single letters
  // per row ("S/O/L/D/T/O" running down a column). After PDF.js extracts the
  // text, those label letters land on the same logical line as the customer
  // name, e.g. "O I  FREMONT GERBER COLLISION  1044675". We strip the
  // leading single-letter columns and pick the first plausible multi-word
  // name we find within the customer block.
  const lines = text.split('\n');
  let anchorIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/(?:ACCOUNT\s+NO|SOLD\s+TO|SHIP\s+TO|BILL\s+TO)/i.test(lines[i])) {
      anchorIdx = i;
      break;
    }
  }
  const startIdx = anchorIdx >= 0 ? anchorIdx : 0;
  const endIdx = Math.min(startIdx + 12, lines.length);
  for (let i = startIdx; i < endIdx; i++) {
    // Strip up to 4 leading single-letter tokens (vertical-label letters).
    const stripped = lines[i].replace(/^(?:\s*[A-Z]\b\s+){1,4}/, '').trim();
    // Pick the first multi-word all-caps run.
    const m = stripped.match(/^([A-Z][A-Z]+(?:\s+[A-Z][A-Z&'.\-]*){1,5})/);
    const name = m && isPlausibleCustomer(m[1]);
    if (name) return name;
  }
  return null;
}

function parseInvoiceBlock(block) {
  const allText = block.lines.map(l => l.items.map(i => i.str).join(' ')).join('\n');
  const lines = block.lines;

  // Detect store + format. Format determines the line-item parser; store
  // determines the part-pattern priority order. CDK on-screen captures from
  // a non-Zeigler dealer fall back to the ford_cdk template.
  const store = detectStore(allText);
  const format = detectFormat(allText);
  const template = (store === 'unknown' && format === 'cdk_screen')
    ? STORE_TEMPLATES.ford_cdk
    : STORE_TEMPLATES[store];

  let invoiceNumber = null;

  // (1) Labelled patterns — strongest signal regardless of store.
  const labelPatterns = [
    /\bINVOICE\s*(?:NUMBER|NO\.?|#)\s*[:.\-]?\s*(\d{6,7}(?:[A-Z]\d{1,2})?)\b/i,
    /\bINV\s*(?:NUMBER|NO\.?|#)\s*[:.\-]?\s*(\d{6,7}(?:[A-Z]\d{1,2})?)\b/i,
    /\bINVOICE\s*[:#]\s*(\d{6,7}(?:[A-Z]\d{1,2})?)\b/i,
    /\b(?:DOCUMENT|DOC)\s*(?:NUMBER|NO\.?|#)\s*[:.\-]?\s*(\d{6,7}(?:[A-Z]\d{1,2})?)\b/i,
    // CDK on-screen "Number: 1044675" header label
    /(?:^|\n)\s*Number\s*[:.]?\s*(\d{6,7}(?:[A-Z]\d{1,2})?)\b/i
  ];
  for (const pat of labelPatterns) {
    const m = allText.match(pat);
    if (m) { invoiceNumber = m[1].toUpperCase(); break; }
  }

  // (2) Per-store invoice number patterns, scored by frequency.
  // The real invoice number is repeated across header + footer + sometimes a barcode line,
  // so the most frequent match against the template wins.
  if (!invoiceNumber) {
    const counts = new Map();
    for (const pat of template.invoiceNumberPatterns) {
      const re = new RegExp(pat.source, 'gi');
      const matches = allText.match(re) || [];
      for (const m of matches) {
        const key = m.toUpperCase();
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    let best = null, bestCount = 0;
    for (const [n, count] of counts) {
      if (count > bestCount) { best = n; bestCount = count; }
    }
    if (best && bestCount >= 2) invoiceNumber = best;
  }

  // (3) Last resort — first plausible token near the top of the block.
  if (!invoiceNumber) {
    const headText = lines.slice(0, 20).map(l => l.items.map(i => i.str).join(' ')).join('\n');
    for (const pat of template.invoiceNumberPatterns) {
      const m = headText.match(pat);
      if (m) { invoiceNumber = m[1].toUpperCase(); break; }
    }
  }

  if (!invoiceNumber) return null;

  let accountNumber = null;
  const acctMatch = allText.match(/ACCOUNT\s+NO\.?\s*(\d+)/i);
  if (acctMatch) accountNumber = acctMatch[1];

  const vendor = template.vendor;
  const location = template.location;

  let vin = null;
  let vehicle = null;
  const vinMatch = allText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
  if (vinMatch) {
    vin = vinMatch[1];
    const afterVin = allText.substring(allText.indexOf(vin) + 17, allText.indexOf(vin) + 200);
    const vehMatch = afterVin.match(/[-\s]+([A-Z][A-Za-z0-9\s\-]+?)(?:\s+The\s+following|\n|$)/);
    if (vehMatch) vehicle = vehMatch[1].trim().replace(/\s+/g, ' ').slice(0, 60);
  }

  const dateMatch = allText.match(/(\d{1,2}\s+[A-Z]{3}\s+\d{2})/);
  const dateShipped = dateMatch ? dateMatch[1] : '';

  let shipVia = '';
  const shipMatch = allText.match(/SHIP\s+VIA\s+(\S+(?:\s+\S+)?)/i);
  if (shipMatch) shipVia = shipMatch[1];
  else if (/RAINBOW/i.test(allText)) shipVia = 'RAINBOW';

  let total = null;
  const totalMatch = allText.match(/TOTAL\s+\$?\s*([\d,]+\.\d{2})/);
  if (totalMatch) total = parseFloat(totalMatch[1].replace(/,/g, ''));

  const lineItems = format === 'cdk_screen'
    ? parseCdkLineItems(lines, template)
    : parseLineItems(lines, template);

  return {
    id: `inv_${invoiceNumber}_${Date.now()}`,
    invoiceNumber,
    accountNumber,
    vendor,
    location,
    customer: extractCustomer(allText) || '— UNKNOWN LANE —',
    customerAddress: null,
    dateShipped,
    shipVia,
    salesman: '',
    yourOrderNo: '',
    vin,
    vehicle: vehicle || (vin ? 'SEE VIN' : ''),
    terms: '',
    total,
    lineItems,
    createdAt: Date.now(),
    rawText: allText.slice(0, 5000)
  };
}

// CDK on-screen "CLOSED INVOICE" capture line-item parser.
// Layout: │ PART-NO. DESC O.H. Q.S. BIN PAC SS LIST SALE │
// Box-drawing chars and a "Ship To" overlay window can interleave with rows,
// so we strip those out, then split on 2+ spaces (column separator) and
// pull description from the first column / prices from the last two decimals.
// Q.S. (quantity sold/shipped) is the second pure-integer token before prices.
function parseCdkLineItems(lines, template) {
  const items = [];
  const orderedRegexes = template.partPatterns.map(v => PART_NUMBER_REGEX[v]).filter(Boolean);
  const BOX_RE = /[│┌┐└┘─├┤┬┴┼]/g;

  for (const line of lines) {
    const raw = line.items.map(it => it.str).join(' ');
    const cleaned = raw.replace(BOX_RE, ' ');

    let partNumber = null;
    for (const re of orderedRegexes) {
      const m = cleaned.match(re);
      if (m) { partNumber = m[0]; break; }
    }
    if (!partNumber) continue;

    // Normalize Ford/CDK "*" separator to "-" for storage and barcode matching.
    const normalizedPart = normalizePartNumber(partNumber);

    const after = cleaned.substring(cleaned.indexOf(partNumber) + partNumber.length);
    const cols = after.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
    if (cols.length === 0) continue;

    let description = (cols[0] || '')
      .replace(/^</, '')              // strip CDK continuation marker
      .replace(/Ship\s+To.*$/i, '')   // strip overlay text leak
      .replace(/[-,\s]+$/, '')        // trim trailing punctuation
      .trim()
      .slice(0, 30);

    const rest = cols.slice(1).join(' ');
    const decimals = rest.match(/\d+\.\d{2}/g) || [];
    const listPrice = decimals.length >= 2 ? parseFloat(decimals[decimals.length - 2]) : 0;
    const netPrice  = decimals.length >= 1 ? parseFloat(decimals[decimals.length - 1]) : 0;

    // Pure integers before prices: O.H., Q.S., (BIN if numeric), PAC, SS.
    // Q.S. = the second one (the first is on-hand stock).
    const beforePrices = rest.replace(/\d+\.\d{2}.*$/, '');
    const ints = (beforePrices.match(/\b\d+\b/g) || []).map(Number);
    let qs = 0;
    if (ints.length >= 2) qs = ints[1];
    else if (ints.length === 1) qs = ints[0];
    // Overlay-corrupted row: prices visible but quantity columns hidden.
    // Treat as shipped=1 so the row appears on the receiving lane.
    if (ints.length === 0 && netPrice > 0) qs = 1;

    const shipped = qs;
    const ordered = Math.max(shipped, 1);
    const backOrdered = shipped === 0 ? 1 : 0;
    const amount = shipped > 0 ? netPrice * shipped : 0;

    let note = null;
    if (shipped === 0) note = 'BACK-ORDERED — should not be in lane';

    items.push({
      partNumber: normalizedPart,
      description: description || 'PART',
      ordered,
      shipped,
      backOrdered,
      listPrice,
      netPrice,
      amount,
      checked: false,
      scanStatus: null,
      checkedAt: null,
      note,
      unitsExpected: shipped,
      unitsScanned: 0
    });
  }

  return items;
}

// ============================================================
// DAY EXCEPTION REPORT helpers
// ============================================================
const ANOMALY_STATUSES = ['WRONG_LANE', 'DUPLICATE', 'BACK_ORDER_ANOMALY', 'UNKNOWN', 'SKIPPED'];

function buildDayReport(invoices, scanLog) {
  const stops = groupInvoicesIntoStops(invoices);
  const readyStops = [];
  const incompleteStops = [];
  for (const stop of stops) {
    const shipped = stop.invoices.flatMap(e => e.invoice.lineItems.filter(li => li.shipped > 0));
    const expected = shipped.reduce((s, li) => s + (li.unitsExpected || 0), 0);
    const got = shipped.reduce((s, li) => s + Math.min(li.unitsExpected || 0, (li.unitsScanned || 0) + (li.unitsSkipped || 0)), 0);
    const scanned = shipped.reduce((s, li) => s + Math.min(li.unitsScanned || 0, li.unitsExpected || 0), 0);
    const skipped = shipped.reduce((s, li) => s + Math.min(li.unitsSkipped || 0, li.unitsExpected || 0), 0);
    const entry = {
      customer: stop.customer,
      key: stop.key,
      expected,
      got,
      scanned,
      skipped,
      invoiceNumbers: stop.invoices.map(e => e.invoice.invoiceNumber),
      complete: expected > 0 && got >= expected
    };
    if (entry.complete) readyStops.push(entry);
    else incompleteStops.push(entry);
  }
  const anomalies = (scanLog || []).filter(l => ANOMALY_STATUSES.includes(l.status));
  return {
    generatedAt: new Date().toISOString(),
    readyStops,
    incompleteStops,
    anomalies,
    totals: {
      stops: stops.length,
      ready: readyStops.length,
      expected: stops.reduce((s, st) => {
        const shipped = st.invoices.flatMap(e => e.invoice.lineItems.filter(li => li.shipped > 0));
        return s + shipped.reduce((a, li) => a + (li.unitsExpected || 0), 0);
      }, 0),
      anomalyCount: anomalies.length
    }
  };
}

function downloadAnomalyCsv(scanLog) {
  const rows = (scanLog || []).filter(l => ANOMALY_STATUSES.includes(l.status));
  const header = ['ts', 'fullTs', 'status', 'partNumber', 'invoiceNumber', 'customer', 'vendor', 'note', 'source'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(header.map(h => esc(r[h])).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `parts-anomalies-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function printDayReport(invoices, scanLog) {
  const report = buildDayReport(invoices, scanLog);
  const w = window.open('', '_blank', 'noopener,noreferrer,width=900,height=1000');
  if (!w) {
    alert('Popup blocked — allow popups to print the day report.');
    return;
  }
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const readyRows = report.readyStops.map(st =>
    `<tr><td>${esc(st.customer)}</td><td>${esc(st.invoiceNumbers.join(', '))}</td><td>${st.scanned}/${st.expected}</td><td>${st.skipped}</td></tr>`
  ).join('') || '<tr><td colspan="4"><em>None</em></td></tr>';
  const incompleteRows = report.incompleteStops.map(st =>
    `<tr><td>${esc(st.customer)}</td><td>${esc(st.invoiceNumbers.join(', '))}</td><td>${st.got}/${st.expected}</td><td>${st.skipped}</td></tr>`
  ).join('') || '<tr><td colspan="4"><em>None — all stops ready</em></td></tr>';
  const anomalyRows = report.anomalies.map(a =>
    `<tr><td>${esc(a.ts || '')}</td><td>${esc(a.status)}</td><td>${esc(a.partNumber)}</td><td>${esc(a.customer || '')}</td><td>${esc(a.invoiceNumber || '')}</td><td>${esc(a.note || '')}</td></tr>`
  ).join('') || '<tr><td colspan="6"><em>No anomalies logged</em></td></tr>';
  const when = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  w.document.write(`<!DOCTYPE html><html><head><title>Day Exception Report</title>
<style>
  body { font-family: 'IBM Plex Mono', 'Courier New', monospace; font-size: 11px; color: #1a1a1a; margin: 24px; }
  h1 { font-family: 'IBM Plex Sans', sans-serif; font-size: 16px; letter-spacing: 0.08em; margin: 0 0 4px; }
  h2 { font-family: 'IBM Plex Sans', sans-serif; font-size: 12px; letter-spacing: 0.1em; margin: 20px 0 8px; border-bottom: 2px solid #1a1a1a; padding-bottom: 4px; }
  .meta { opacity: 0.7; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #e0e0e0; font-size: 10px; letter-spacing: 0.06em; }
  .stats { display: flex; gap: 16px; margin: 12px 0; }
  .stat { border: 1px solid #1a1a1a; padding: 8px 12px; }
  .stat b { display: block; font-size: 18px; }
  @media print { body { margin: 12px; } button { display: none !important; } }
</style></head><body>
  <button onclick="window.print()" style="float:right;padding:6px 12px;font-weight:bold;cursor:pointer;">PRINT</button>
  <h1>DAY EXCEPTION REPORT</h1>
  <div class="meta">Generated ${esc(when)} · Parts Receiving / Lane Check</div>
  <div class="stats">
    <div class="stat"><span>STOPS</span><b>${report.totals.stops}</b></div>
    <div class="stat"><span>READY</span><b>${report.totals.ready}</b></div>
    <div class="stat"><span>UNITS EXPECTED</span><b>${report.totals.expected}</b></div>
    <div class="stat"><span>ANOMALIES</span><b>${report.totals.anomalyCount}</b></div>
  </div>
  <h2>READY STOPS</h2>
  <table><thead><tr><th>STOP</th><th>INVOICES</th><th>SCANNED</th><th>SKIPPED</th></tr></thead>
  <tbody>${readyRows}</tbody></table>
  <h2>INCOMPLETE STOPS</h2>
  <table><thead><tr><th>STOP</th><th>INVOICES</th><th>ACCOUNTED</th><th>SKIPPED</th></tr></thead>
  <tbody>${incompleteRows}</tbody></table>
  <h2>ANOMALIES (WRONG_LANE · DUPLICATE · BACK_ORDER · UNKNOWN · SKIPPED)</h2>
  <table><thead><tr><th>TIME</th><th>STATUS</th><th>PART</th><th>CUSTOMER</th><th>INV</th><th>NOTE</th></tr></thead>
  <tbody>${anomalyRows}</tbody></table>
  <script>setTimeout(function(){ try { window.print(); } catch(e){} }, 250);</script>
</body></html>`);
  w.document.close();
}

// ============================================================
// MAIN
// ============================================================
export default function PartsCheckInSystem() {
  const [view, setView] = useState('dashboard');
  const [invoices, setInvoices] = useState([]);
  const [activeInvoiceIdx, setActiveInvoiceIdx] = useState(null);
  const [scanLog, setScanLog] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [uploadStatus, setUploadStatus] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [showRawText, setShowRawText] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [debugDump, setDebugDump] = useState(null);
  // Driver-chosen stop ordering for the SortView. Array of stop keys. New
  // stops (from a fresh upload) are auto-appended; deleted stops are pruned.
  // The SortView reads this and renders stop cards in this order.
  const [stopOrder, setStopOrder] = useState([]);
  // Shown when localStorage.setItem throws (quota / private mode). Driver must
  // export before navigating away or data may be lost.
  const [storageError, setStorageError] = useState(null);
  // A same-day session found in storage on open. It is NOT loaded into the
  // working state — the app starts empty — it is only offered via a banner
  // until the driver taps RESUME or DISCARD (or uploads something new, which
  // implicitly discards it). Sessions from any other day are wiped on open.
  const [pendingSession, setPendingSession] = useState(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    (async () => {
      const saved = await readStoredSession();
      if (saved && saved.isToday) {
        setPendingSession(saved);
      } else {
        clearStoredSession();
      }
      setLoaded(true);
    })();
  }, []);

  // Persist the working session. Suspended while an unresumed same-day
  // session is still being offered, so the empty fresh state can't
  // overwrite it before the driver decides.
  useEffect(() => {
    if (!loaded || pendingSession) return;
    (async () => {
      const ok =
        await saveToStorage(STORAGE_KEYS.INVOICES, invoices) &&
        await saveToStorage(STORAGE_KEYS.STOP_ORDER, stopOrder) &&
        await saveToStorage(STORAGE_KEYS.SCAN_LOG, scanLog.slice(0, 500)) &&
        await saveToStorage(STORAGE_KEYS.SESSION_META, { savedAt: Date.now() });
      if (!ok) setStorageError('STORAGE FULL OR BLOCKED — export session now or data may be lost on refresh');
      else setStorageError(prev => prev && prev.startsWith('STORAGE') ? null : prev);
    })();
  }, [invoices, stopOrder, scanLog, loaded, pendingSession]);

  // Keep stopOrder in sync with the set of stop keys derived from invoices:
  //   - When a new stop appears (new invoice for a customer we haven't seen),
  //     append its key to the end of the route.
  //   - When a stop disappears (deleted invoice with no siblings sharing the
  //     same merged stop key), drop its key.
  //   - Existing positions are preserved.
  useEffect(() => {
    if (!loaded) return;
    const currentKeys = new Set(groupInvoicesIntoStops(invoices).map(s => s.key));
    setStopOrder(prev => {
      const pruned = prev.filter(k => currentKeys.has(k));
      const known = new Set(pruned);
      const additions = [];
      for (const k of currentKeys) {
        if (!known.has(k)) additions.push(k);
      }
      if (additions.length === 0 && pruned.length === prev.length) return prev;
      return pruned.concat(additions);
    });
  }, [invoices, loaded]);

  // Reorder by dropping draggedKey just before targetKey. Both keys must
  // exist in the current order; otherwise we no-op (defensive against races
  // where a stop was deleted while the user was mid-drag).
  const reorderStops = useCallback((draggedKey, targetKey) => {
    if (!draggedKey || !targetKey || draggedKey === targetKey) return;
    setStopOrder(prev => {
      const fromIdx = prev.indexOf(draggedKey);
      const toIdx = prev.indexOf(targetKey);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const next = prev.slice();
      next.splice(fromIdx, 1);
      // Recompute target index since the removal may have shifted it.
      const recomputedTo = next.indexOf(targetKey);
      next.splice(recomputedTo, 0, draggedKey);
      return next;
    });
  }, []);

  const resumePendingSession = () => {
    if (!pendingSession) return;
    setInvoices(pendingSession.invoices);
    setScanLog(pendingSession.scanLog);
    setStopOrder(pendingSession.stopOrder);
    setPendingSession(null);
  };

  const discardPendingSession = () => {
    clearStoredSession();
    setPendingSession(null);
    setConfirmDiscard(false);
  };

  const activeInvoice = activeInvoiceIdx !== null ? invoices[activeInvoiceIdx] : null;

  // Unit totals (sum of unitsExpected / scanned+skipped) — consistent with SortView.
  const totalLineItems = invoices.reduce((sum, inv) =>
    sum + inv.lineItems.filter(li => li.shipped > 0).reduce((s, li) => s + (li.unitsExpected || 0), 0), 0);
  const checkedItems = invoices.reduce((sum, inv) =>
    sum + inv.lineItems.filter(li => li.shipped > 0).reduce((s, li) =>
      s + Math.min(li.unitsExpected || 0, (li.unitsScanned || 0) + (li.unitsSkipped || 0)), 0), 0);
  const flaggedItems = scanLog.filter(l => l.status === 'WRONG_LANE' || l.status === 'BACK_ORDER_ANOMALY' || l.status === 'UNKNOWN').length;
  const backOrderedCount = invoices.reduce((sum, inv) => sum + inv.lineItems.filter(li => li.backOrdered > 0 && li.shipped === 0).length, 0);

  const handleFileUpload = async (file) => {
    if (!file) return;
    setDebugDump(null);
    setUploadStatus({ stage: 'loading', message: 'Loading PDF.js...' });
    try {
      setUploadStatus({ stage: 'parsing', message: `Parsing ${file.name}...` });
      const { invoices: newInvoices, rawText, pageCount, reason } = await parseInvoicePDF(file, (msg) => {
        setUploadStatus({ stage: 'parsing', message: msg });
      });

      if (newInvoices.length === 0) {
        setDebugDump({ fileName: file.name, pageCount, rawText, reason });
        setUploadStatus({ stage: 'error', message: reason || 'No invoices detected. Tap “VIEW EXTRACTED TEXT” to inspect.' });
        return;
      }

      // Uploading new work while an old session is still being offered is
      // the driver choosing to start fresh — drop the offer so the new
      // session can persist.
      setPendingSession(null);

      setInvoices(prev => {
        const merged = [...prev];
        for (const newInv of newInvoices) {
          const existingIdx = merged.findIndex(i => i.invoiceNumber === newInv.invoiceNumber);
          if (existingIdx >= 0) {
            const existing = merged[existingIdx];

            // Don't downgrade a detailed invoice with a route-report
            // placeholder. The route report only carries part numbers (no
            // qty / desc / back-order info), so when a detailed PDF has
            // already filled in those fields we keep the existing record.
            // Forward any fresh scan progress on matching part numbers, and
            // surface any net-new parts in case the manifest knows about
            // some the individual PDF didn't.
            if (newInv.fromRouteReport && !existing.fromRouteReport) {
              const knownParts = new Set(existing.lineItems.map(li => li.partNumber));
              for (const li of newInv.lineItems) {
                if (!knownParts.has(li.partNumber)) {
                  existing.lineItems.push(li);
                  knownParts.add(li.partNumber);
                }
              }
              continue;
            }

            const checkMap = new Map(existing.lineItems.map(li => [`${li.partNumber}|${li.shipped}`, li]));
            newInv.lineItems = newInv.lineItems.map(li => {
              const prev = checkMap.get(`${li.partNumber}|${li.shipped}`);
              if (prev && prev.checked) return { ...li, checked: prev.checked, scanStatus: prev.scanStatus, checkedAt: prev.checkedAt, unitsScanned: prev.unitsScanned };
              return li;
            });
            merged[existingIdx] = newInv;
          } else {
            merged.push(newInv);
          }
        }
        return merged;
      });

      const totalItems = newInvoices.reduce((s, i) => s + i.lineItems.length, 0);
      const isManifest = newInvoices[0] && newInvoices[0].fromRouteReport;
      setUploadStatus({
        stage: 'success',
        message: isManifest
          ? `Route report · ${newInvoices.length} invoice(s) · ${totalItems} line items`
          : `Parsed ${newInvoices.length} invoice(s) · ${totalItems} line items`
      });
      setTimeout(() => setUploadStatus(null), 5000);
    } catch (err) {
      console.error(err);
      setUploadStatus({ stage: 'error', message: `Parse failed: ${err.message}` });
      setTimeout(() => setUploadStatus(null), 5000);
    }
  };

  const processScan = useCallback((scannedPart, source = 'manual') => {
    if (!activeInvoice) return;
    const cleaned = scannedPart.trim().toUpperCase().replace(/\s+/g, '');
    if (!cleaned) return;
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    const fullTs = Date.now();

    // Normalize for matching: uppercase, strip separators (- _ space *), then
    // strip AIAG MH10.8.2 / ANSI MH10 data identifiers from the front of
    // scanned barcodes. Auto-parts barcodes commonly prefix the part-number
    // field with "P" (Part Number), "1P" (Customer Part Number), or "30P"
    // (Additional Part Number) per the standard, so a Ford label encodes
    // FL3Z-99292A22-AA as the payload "PFL3Z-99292A22-AA". Without stripping
    // the identifier the match would fail. Applied symmetrically to both
    // stored and scanned values so legitimate "P"-prefixed part numbers (if
    // any exist) still match each other.
    const normalize = (s) => {
      if (!s) return '';
      let c = s.toUpperCase().replace(/[-\s*_]/g, '');
      // Strip AIAG MH10 part-number identifier prefix (P / 1P / 30P)
      c = c.replace(/^(?:30P|1P|P)(?=[A-Z0-9])/, '');
      // Strip leading zeros: Mopar (and some other vendors) print part
      // numbers with display padding zeros that the invoice drops
      // (e.g. label '06510359AA' vs invoice '6510359AA'). Applied
      // symmetrically to both stored and scanned values, so legitimate
      // 0-leading parts (Honda 04646-TVA-A01ZZ etc.) still match each
      // other on either side. The (?=[A-Z0-9]) guard prevents stripping
      // the entire string to empty when the input is all zeros.
      c = c.replace(/^0+(?=[A-Z0-9])/, '');
      return c;
    };
    const cleanedNorm = normalize(cleaned);

    let matchIdx = activeInvoice.lineItems.findIndex(
      li => normalize(li.partNumber) === cleanedNorm && li.shipped > 0 && ((li.unitsScanned || 0) + (li.unitsSkipped || 0)) < li.unitsExpected
    );

    let wrongLaneInfo = null;
    if (matchIdx === -1) {
      for (let i = 0; i < invoices.length; i++) {
        if (i === activeInvoiceIdx) continue;
        const found = invoices[i].lineItems.find(li => normalize(li.partNumber) === cleanedNorm);
        if (found) {
          wrongLaneInfo = { invoiceNumber: invoices[i].invoiceNumber, customer: invoices[i].customer, vendor: invoices[i].vendor };
          break;
        }
      }
    }

    let status, note, partDescription = '';

    if (matchIdx !== -1) {
      setInvoices(prev => {
        const next = [...prev];
        const inv = { ...next[activeInvoiceIdx] };
        const items = [...inv.lineItems];
        const item = { ...items[matchIdx] };
        // Capacity guard inside the updater. The outer match check uses a
        // captured invoices snapshot that can be stale during rapid scan
        // bursts; this re-checks against the current state. If the line is
        // already at capacity, leave it alone — no over-increment, the
        // user-visible count stays correct.
        const before = (item.unitsScanned || 0) + (item.unitsSkipped || 0);
        if (before >= item.unitsExpected) return prev;
        item.unitsScanned = Math.min(item.unitsExpected, (item.unitsScanned || 0) + 1);
        if (item.unitsScanned >= item.unitsExpected) {
          item.checked = true;
          item.checkedAt = fullTs;
        }
        item.scanStatus = 'matched';
        items[matchIdx] = item;
        inv.lineItems = items;
        next[activeInvoiceIdx] = inv;
        return next;
      });
      const item = activeInvoice.lineItems[matchIdx];
      status = 'MATCHED';
      partDescription = item.description;
      const unitsAfter = (item.unitsScanned || 0) + 1;
      note = unitsAfter >= item.unitsExpected
        ? `${item.description} · ${unitsAfter}/${item.unitsExpected} ✓ COMPLETE`
        : `${item.description} · unit ${unitsAfter}/${item.unitsExpected}`;
    } else if (wrongLaneInfo) {
      status = 'WRONG_LANE';
      note = `Belongs to a different stop · ${wrongLaneInfo.customer} · invoice ${wrongLaneInfo.invoiceNumber}`;
    } else {
      const dupIdx = activeInvoice.lineItems.findIndex(
        li => normalize(li.partNumber) === cleanedNorm && ((li.unitsScanned || 0) + (li.unitsSkipped || 0)) >= li.unitsExpected && li.unitsExpected > 0
      );
      if (dupIdx !== -1) {
        status = 'DUPLICATE';
        note = `Already fully scanned: ${activeInvoice.lineItems[dupIdx].description}`;
      } else {
        const boIdx = activeInvoice.lineItems.findIndex(
          li => normalize(li.partNumber) === cleanedNorm && li.backOrdered > 0 && li.shipped === 0
        );
        if (boIdx !== -1) {
          status = 'BACK_ORDER_ANOMALY';
          note = `Marked BACK-ORDERED — should not be in lane`;
        } else {
          status = 'UNKNOWN';
          note = 'Part not on any active invoice';
        }
      }
    }

    setScanLog(prev => [{
      ts, fullTs, partNumber: cleaned,
      invoiceNumber: activeInvoice.invoiceNumber,
      vendor: activeInvoice.vendor,
      status, note, partDescription, source
    }, ...prev]);

    return status;
  }, [activeInvoice, activeInvoiceIdx, invoices]);

  // Global sort scan — the morning-driver workflow. The driver scans every
  // part from a mixed pile and the system finds whichever loaded invoice
  // owns the part and routes the scan into that invoice's lane. No active
  // invoice is required.
  //
  // Outcome categories:
  //   MATCHED            - found a line item with remaining capacity, count++
  //   DUPLICATE          - the part exists on some invoice but it's already
  //                        fully scanned (extra unit beyond what's expected)
  //   BACK_ORDER_ANOMALY - the part appears on an invoice as back-ordered;
  //                        physically it shouldn't be in today's shipment
  //   UNKNOWN            - the part doesn't appear on any loaded invoice
  const processGlobalScan = useCallback((scannedPart, source = 'sort') => {
    const cleaned = scannedPart.trim().toUpperCase().replace(/\s+/g, '');
    if (!cleaned) return;
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    const fullTs = Date.now();

    const normalize = (s) => {
      if (!s) return '';
      let c = s.toUpperCase().replace(/[-\s*_]/g, '');
      // Strip AIAG MH10 part-number identifier prefix (P / 1P / 30P)
      c = c.replace(/^(?:30P|1P|P)(?=[A-Z0-9])/, '');
      // Strip leading zeros so a barcode encoding '06510359AA' matches an
      // invoice that prints the part as '6510359AA'. Symmetric — applied to
      // both stored and scanned values, so legitimate 0-leading parts
      // (Honda 04646-...) still match each other on either side.
      c = c.replace(/^0+(?=[A-Z0-9])/, '');
      return c;
    };
    const cleanedNorm = normalize(cleaned);

    // First pass — find a line item with remaining capacity (the lane that
    // wants this part). When the same part appears on multiple invoices, fill
    // them in load order; this keeps shops with multi-unit orders progressing
    // through their requested quantity before spilling to the next shop.
    let matchInvIdx = -1, matchItemIdx = -1;
    for (let i = 0; i < invoices.length; i++) {
      const idx = invoices[i].lineItems.findIndex(li =>
        normalize(li.partNumber) === cleanedNorm &&
        li.shipped > 0 &&
        ((li.unitsScanned || 0) + (li.unitsSkipped || 0)) < li.unitsExpected
      );
      if (idx !== -1) { matchInvIdx = i; matchItemIdx = idx; break; }
    }

    let status, note;
    let routedTo = null;
    let partDescription = '';

    if (matchInvIdx !== -1) {
      const targetInvoice = invoices[matchInvIdx];
      const targetItem = targetInvoice.lineItems[matchItemIdx];
      partDescription = targetItem.description;
      const unitsAfter = (targetItem.unitsScanned || 0) + 1;
      routedTo = { invoiceNumber: targetInvoice.invoiceNumber, customer: targetInvoice.customer };

      setInvoices(prev => {
        const next = [...prev];
        const inv = { ...next[matchInvIdx] };
        const items = [...inv.lineItems];
        const item = { ...items[matchItemIdx] };
        // Capacity guard inside the updater — see equivalent comment in
        // processScan above.
        const before = (item.unitsScanned || 0) + (item.unitsSkipped || 0);
        if (before >= item.unitsExpected) return prev;
        item.unitsScanned = Math.min(item.unitsExpected, (item.unitsScanned || 0) + 1);
        if (item.unitsScanned >= item.unitsExpected) {
          item.checked = true;
          item.checkedAt = fullTs;
        }
        item.scanStatus = 'matched';
        items[matchItemIdx] = item;
        inv.lineItems = items;
        next[matchInvIdx] = inv;
        return next;
      });

      status = 'MATCHED';
      note = unitsAfter >= targetItem.unitsExpected
        ? `→ ${targetInvoice.customer} · ${targetItem.description} ✓ COMPLETE`
        : `→ ${targetInvoice.customer} · ${targetItem.description} (${unitsAfter}/${targetItem.unitsExpected})`;
    } else {
      // Already-fully-scanned check first — extra unit of a part that some
      // shop ordered. Common when a shipment includes more than the invoice.
      let dup = null;
      for (const inv of invoices) {
        const item = inv.lineItems.find(li =>
          normalize(li.partNumber) === cleanedNorm &&
          li.unitsExpected > 0 &&
          ((li.unitsScanned || 0) + (li.unitsSkipped || 0)) >= li.unitsExpected
        );
        if (item) { dup = { customer: inv.customer, description: item.description }; break; }
      }
      if (dup) {
        status = 'DUPLICATE';
        partDescription = dup.description;
        note = `Already fully scanned for ${dup.customer}`;
      } else {
        // Back-order anomaly — part listed as back-ordered but it physically arrived
        let bo = null;
        for (const inv of invoices) {
          const item = inv.lineItems.find(li =>
            normalize(li.partNumber) === cleanedNorm &&
            li.backOrdered > 0 &&
            li.shipped === 0
          );
          if (item) { bo = { customer: inv.customer, description: item.description }; break; }
        }
        if (bo) {
          status = 'BACK_ORDER_ANOMALY';
          partDescription = bo.description;
          note = `Marked back-ordered for ${bo.customer} — shouldn't be in shipment`;
        } else {
          status = 'UNKNOWN';
          note = 'Part not on any invoice today';
        }
      }
    }

    setScanLog(prev => [{
      ts, fullTs, partNumber: cleaned,
      invoiceNumber: routedTo ? routedTo.invoiceNumber : null,
      customer: routedTo ? routedTo.customer : null,
      vendor: matchInvIdx !== -1 ? invoices[matchInvIdx].vendor : null,
      status, note, partDescription, source
    }, ...prev]);

    // Return both the status and (when matched) a reference to the line item
    // that was incremented. The SortView uses lineRef to offer a "Bag of N"
    // quick-confirm button when the matched line carries multiple units.
    if (matchInvIdx !== -1) {
      const targetItem = invoices[matchInvIdx].lineItems[matchItemIdx];
      return {
        status,
        lineRef: {
          invIdx: matchInvIdx,
          itemIdx: matchItemIdx,
          partNumber: targetItem.partNumber,
          description: targetItem.description,
          unitsExpected: targetItem.unitsExpected,
          unitsScanned: (targetItem.unitsScanned || 0) + 1,
          customer: invoices[matchInvIdx].customer
        },
        nearest: null
      };
    }

    // No clean match. If the scan landed UNKNOWN or wrongly back-ordered,
    // hunt for the closest still-open shipped line on the route and offer it
    // as a "did you mean?" suggestion. This is the fallback for barcode/part
    // formats whose normalization doesn't line up yet — driver confirms
    // against the physical label, and the confirmation logs the exact
    // scanned-vs-stored pair for a permanent fix.
    let nearest = null;
    if (status === 'UNKNOWN' || status === 'BACK_ORDER_ANOMALY') {
      nearest = findNearestLine(cleanedNorm, invoices, normalize);
    }
    return { status, lineRef: null, nearest };
  }, [invoices]);

  // Confirm a counted quantity for a multi-unit line in one action — the
  // "bag of N" workflow. Driver scans one screw, visually counts the bag,
  // types the actual count (or accepts the pre-filled expected value), and
  // submits. The line's unitsScanned jumps to the entered count.
  //
  // targetCount is clamped to [current_unitsScanned, unitsExpected] so:
  //   - Driver can't accidentally regress (lower bound = current count)
  //   - Driver can't over-confirm beyond what was ordered (upper bound =
  //     unitsExpected). If they actually got more than ordered, the extra
  //     parts will scan as DUPLICATE / UNKNOWN later — captured separately
  //     in the anomalies panel.
  const confirmBag = useCallback((invIdx, itemIdx, targetCount) => {
    setInvoices(prev => {
      if (invIdx < 0 || invIdx >= prev.length) return prev;
      const next = [...prev];
      const inv = { ...next[invIdx] };
      const items = [...inv.lineItems];
      if (itemIdx < 0 || itemIdx >= items.length) return prev;
      const item = { ...items[itemIdx] };
      const before = item.unitsScanned || 0;
      const expected = item.unitsExpected || 0;
      const requested = Number.isFinite(targetCount) ? targetCount : expected;
      const target = Math.max(before, Math.min(expected, Math.floor(requested)));
      if (target === before) return prev;
      const filled = target - before;
      item.unitsScanned = target;
      if (target >= expected) {
        item.checked = true;
        item.checkedAt = Date.now();
      }
      item.scanStatus = 'matched';
      items[itemIdx] = item;
      inv.lineItems = items;
      next[invIdx] = inv;

      // Log the bulk confirmation so the scan log shows what happened
      setScanLog(prevLog => [{
        ts: new Date().toLocaleTimeString('en-US', { hour12: false }),
        fullTs: Date.now(),
        partNumber: item.partNumber,
        invoiceNumber: inv.invoiceNumber,
        customer: inv.customer,
        vendor: inv.vendor,
        status: 'MATCHED',
        note: `→ ${inv.customer} · ${item.description} · bag count ${target}/${expected} (+${filled})`,
        partDescription: item.description,
        source: 'bag_confirm'
      }, ...prevLog]);
      return next;
    });
  }, []);

  // Confirm a driver-verified "did you mean?" near-match. The scan didn't
  // cleanly match this line (formats don't normalize the same yet), but the
  // driver checked the physical label and confirmed it's this part. Behaves
  // like a normal check-in (capacity-guarded), and crucially records the
  // exact scanned-vs-stored pair in the scan log so the mismatch can be
  // turned into a permanent normalization rule.
  const confirmNearMatch = useCallback((invIdx, itemIdx, scannedCode) => {
    setInvoices(prev => {
      if (invIdx < 0 || invIdx >= prev.length) return prev;
      const next = [...prev];
      const inv = { ...next[invIdx] };
      const items = [...inv.lineItems];
      if (itemIdx < 0 || itemIdx >= items.length) return prev;
      const item = { ...items[itemIdx] };
      const before = (item.unitsScanned || 0) + (item.unitsSkipped || 0);
      if (before >= item.unitsExpected) return prev;
      item.unitsScanned = Math.min(item.unitsExpected, (item.unitsScanned || 0) + 1);
      if (item.unitsScanned >= item.unitsExpected) {
        item.checked = true;
        item.checkedAt = Date.now();
      }
      item.scanStatus = 'matched';
      items[itemIdx] = item;
      inv.lineItems = items;
      next[invIdx] = inv;

      setScanLog(prevLog => [{
        ts: new Date().toLocaleTimeString('en-US', { hour12: false }),
        fullTs: Date.now(),
        partNumber: scannedCode || item.partNumber,
        invoiceNumber: inv.invoiceNumber,
        customer: inv.customer,
        vendor: inv.vendor,
        status: 'MATCHED',
        note: `→ ${inv.customer} · ${item.description} · confirmed near-match (scanned "${scannedCode}" ≈ ${item.partNumber})`,
        partDescription: item.description,
        source: 'near_match'
      }, ...prevLog]);
      return next;
    });
  }, []);

  const clearAll = () => {
    setInvoices([]);
    setScanLog([]);
    setStopOrder([]);
    setActiveInvoiceIdx(null);
    setView('dashboard');
    setPendingSession(null);
    clearStoredSession();
    setConfirmClear(false);
  };

  // Mark every still-missing unit on a line as "skipped" — the driver's
  // sign-off that those parts won't make today's delivery. The stop counts
  // as complete (READY) once every line is either fully scanned or has its
  // shortage skipped. Skipping is logged so the audit trail explains why a
  // line shows fewer scanned units than expected.
  const skipRemainingUnits = useCallback((invIdx, itemIdx) => {
    setInvoices(prev => {
      if (invIdx < 0 || invIdx >= prev.length) return prev;
      const next = [...prev];
      const inv = { ...next[invIdx] };
      const items = [...inv.lineItems];
      if (itemIdx < 0 || itemIdx >= items.length) return prev;
      const item = { ...items[itemIdx] };
      const scanned = item.unitsScanned || 0;
      const existingSkip = item.unitsSkipped || 0;
      const expected = item.unitsExpected || 0;
      const targetSkip = Math.max(existingSkip, expected - scanned);
      if (targetSkip <= existingSkip) return prev;
      const newlySkipped = targetSkip - existingSkip;
      item.unitsSkipped = targetSkip;
      item.checked = true;
      item.checkedAt = Date.now();
      item.scanStatus = 'skipped';
      items[itemIdx] = item;
      inv.lineItems = items;
      next[invIdx] = inv;

      setScanLog(prevLog => [{
        ts: new Date().toLocaleTimeString('en-US', { hour12: false }),
        fullTs: Date.now(),
        partNumber: item.partNumber,
        invoiceNumber: inv.invoiceNumber,
        customer: inv.customer,
        vendor: inv.vendor,
        status: 'SKIPPED',
        note: `→ ${inv.customer} · ${item.description} · ${newlySkipped} unit(s) marked not coming`,
        partDescription: item.description,
        source: 'skip'
      }, ...prevLog]);
      return next;
    });
  }, []);

  const resetScans = () => {
    setInvoices(prev => prev.map(inv => ({
      ...inv,
      lineItems: inv.lineItems.map(li => ({
        ...li,
        checked: false,
        scanStatus: null,
        checkedAt: null,
        unitsScanned: 0,
        unitsSkipped: 0
      }))
    })));
  };

  // Merge every invoice currently grouped under sourceKey into the stop
  // identified by targetKey. We rewrite the stopId override on each invoice
  // in the source group; persistence is automatic because invoices is
  // already saved to localStorage on every change.
  const mergeStops = useCallback((sourceKey, targetKey) => {
    if (!sourceKey || !targetKey || sourceKey === targetKey) return;
    setInvoices(prev => prev.map(inv => {
      if (getStopKey(inv) === sourceKey) {
        return { ...inv, stopId: targetKey };
      }
      return inv;
    }));
  }, []);

  // Reverse a merge for one stop. Clears the stopId override on every
  // invoice currently grouped here that carries one; invoices then fall
  // back to their customer-derived default groups, so two manually-merged
  // shops split back into their original stops.
  const splitStop = useCallback((stopKey) => {
    if (!stopKey) return;
    setInvoices(prev => prev.map(inv => {
      if (getStopKey(inv) === stopKey && inv.stopId) {
        const { stopId, ...rest } = inv;
        return rest;
      }
      return inv;
    }));
  }, []);

  const exportSession = () => {
    const data = {
      exportedAt: new Date().toISOString(),
      invoices,
      scanLog
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `parts-checkin-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    // Clear storage warning after a successful forced export
    setStorageError(null);
  };

  const exportAnomaliesCsv = () => {
    downloadAnomalyCsv(scanLog);
  };

  const handlePrintDayReport = () => {
    printDayReport(invoices, scanLog);
  };

  if (!loaded) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center font-mono">
        <div className="label">Loading…</div>
      </div>
    );
  }

  const today = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const stopCount = groupInvoicesIntoStops(invoices).length;
  const hasData = invoices.length > 0 || scanLog.length > 0;

  return (
    <div className="min-h-screen bg-paper text-ink font-mono flex flex-col">
      <header className="bg-ink text-paper">
        <div className="px-3 h-12 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-sans font-extrabold tracking-wider text-[13px] truncate">
              <span className="hidden sm:inline">PARTS RECEIVING <span className="text-blue">·</span> </span>LANE CHECK
            </div>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <span className="text-[11px] text-paper/70 mr-2 hidden sm:inline">{today}</span>
            <button onClick={handlePrintDayReport} title="Print day exception report" aria-label="Print day report" className="btn btn-ghost-dark btn-icon" disabled={!hasData}>
              <Printer className="w-4 h-4" />
            </button>
            <button onClick={exportAnomaliesCsv} title="Download anomaly CSV" aria-label="Download anomaly CSV" className="btn btn-ghost-dark btn-icon" disabled={!hasData}>
              <FileDown className="w-4 h-4" />
            </button>
            <button onClick={exportSession} title="Export session JSON" aria-label="Export session" className="btn btn-ghost-dark btn-icon" disabled={!hasData}>
              <Download className="w-4 h-4" />
            </button>
            <button onClick={() => setConfirmClear(true)} title="Clear all data" aria-label="Clear all data" className="btn btn-ghost-dark btn-icon" disabled={!hasData}>
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <nav className="border-b border-ink/20 bg-line px-3 h-9 text-[11px] font-sans font-bold tracking-wide flex items-center gap-1 overflow-x-auto whitespace-nowrap">
        <button
          onClick={() => { setView('dashboard'); setActiveInvoiceIdx(null); }}
          className={`px-2 py-1 ${view === 'dashboard' ? 'bg-ink text-paper' : 'text-muted hover:text-ink'}`}
        >
          DASHBOARD
        </button>
        {view === 'sort' && (
          <>
            <ChevronRight className="w-3.5 h-3.5 text-muted/60" />
            <span className="px-2 py-1 bg-blue text-white">SORT</span>
          </>
        )}
        {view !== 'sort' && activeInvoice && (
          <>
            <ChevronRight className="w-3.5 h-3.5 text-muted/60" />
            <button
              onClick={() => setView('invoice')}
              className={`px-2 py-1 truncate max-w-[50vw] ${view === 'invoice' ? 'bg-ink text-paper' : 'text-muted hover:text-ink'}`}
            >
              {activeInvoice.customer || `INV ${activeInvoice.invoiceNumber}`}
            </button>
            {view === 'scan' && (
              <>
                <ChevronRight className="w-3.5 h-3.5 text-muted/60" />
                <span className="px-2 py-1 bg-blue text-white">SCAN</span>
              </>
            )}
          </>
        )}
        <div className="flex-1"></div>
        <span className="text-[10px] text-muted font-mono font-normal hidden sm:inline">
          {stopCount} STOP{stopCount === 1 ? '' : 'S'} · {scanLog.length} SCAN{scanLog.length === 1 ? '' : 'S'}
        </span>
      </nav>

      {storageError && (
        <div className="bg-red text-white px-3 py-2 text-[12px] font-sans font-bold flex items-center justify-between gap-3 flex-wrap">
          <span className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {storageError}
          </span>
          <div className="flex gap-1.5 items-center">
            <button onClick={exportSession} className="btn btn-sm bg-white text-red border-white hover:bg-paper hover:text-red">
              EXPORT NOW
            </button>
            <button onClick={exportAnomaliesCsv} className="btn btn-sm border-white/70 bg-transparent text-white hover:bg-white/15 hover:text-white">
              CSV
            </button>
            <button onClick={() => setStorageError(null)} className="btn btn-sm btn-icon border-transparent bg-transparent text-white hover:bg-white/15 hover:text-white" aria-label="Dismiss">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {pendingSession && view === 'dashboard' && (
        <div className="bg-blue text-white px-3 py-2.5 text-[12px] font-sans flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <History className="w-4 h-4 shrink-0" />
            <div className="min-w-0">
              <div className="font-bold tracking-wide">UNFINISHED SESSION FROM TODAY</div>
              <div className="text-[11px] text-white/85 font-mono">
                saved {new Date(pendingSession.savedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                {' · '}{groupInvoicesIntoStops(pendingSession.invoices).length} stop{groupInvoicesIntoStops(pendingSession.invoices).length === 1 ? '' : 's'}
                {' · '}{pendingSession.scanLog.length} scan{pendingSession.scanLog.length === 1 ? '' : 's'}
              </div>
            </div>
          </div>
          <div className="flex gap-1.5">
            <button onClick={resumePendingSession} className="btn btn-sm bg-white text-blue border-white hover:bg-paper hover:text-blue">
              RESUME
            </button>
            <button onClick={() => setConfirmDiscard(true)} className="btn btn-sm border-white/70 bg-transparent text-white hover:bg-white/15 hover:text-white">
              DISCARD
            </button>
          </div>
        </div>
      )}

      <main className="w-full max-w-[1500px] mx-auto p-3 md:p-4 flex-1">
        {view === 'dashboard' && (
          <DashboardView
            invoices={invoices}
            scanLog={scanLog}
            stats={{ totalLineItems, checkedItems, flaggedItems, backOrderedCount }}
            searchTerm={searchTerm}
            setSearchTerm={setSearchTerm}
            onPrintDayReport={handlePrintDayReport}
            onExportAnomalies={exportAnomaliesCsv}
            onSelectInvoice={(idx) => { setActiveInvoiceIdx(idx); setView('invoice'); }}
            onLookupInvoiceCode={(code) => {
              // Normalize: strip leading zeros, whitespace
              const norm = code.trim().toUpperCase().replace(/\s+/g, '');
              const idx = invoices.findIndex(inv =>
                inv.invoiceNumber.toUpperCase() === norm ||
                inv.invoiceNumber.toUpperCase().replace(/^0+/, '') === norm.replace(/^0+/, '') ||
                norm.includes(inv.invoiceNumber.toUpperCase())
              );
              if (idx >= 0) {
                setActiveInvoiceIdx(idx);
                setView('invoice');
                return { found: true, invoiceNumber: invoices[idx].invoiceNumber };
              }
              return { found: false, code: norm };
            }}
            onUpload={handleFileUpload}
            uploadStatus={uploadStatus}
            debugDump={debugDump}
            onClearDebug={() => { setDebugDump(null); setUploadStatus(null); }}
            onResetScans={resetScans}
            onStartSort={() => { setActiveInvoiceIdx(null); setView('sort'); }}
          />
        )}

        {view === 'invoice' && activeInvoice && (
          <InvoiceDetailView
            invoice={activeInvoice}
            scanLog={scanLog.filter(l => l.invoiceNumber === activeInvoice.invoiceNumber)}
            onScan={() => setView('scan')}
            onBack={() => { setView('dashboard'); setActiveInvoiceIdx(null); }}
            showRawText={showRawText}
            setShowRawText={setShowRawText}
            onResetInvoice={() => {
              setInvoices(prev => {
                const next = [...prev];
                next[activeInvoiceIdx] = {
                  ...next[activeInvoiceIdx],
                  lineItems: next[activeInvoiceIdx].lineItems.map(li => ({ ...li, checked: false, scanStatus: null, checkedAt: null, unitsScanned: 0, unitsSkipped: 0 }))
                };
                return next;
              });
            }}
            onDeleteInvoice={() => {
              setInvoices(prev => prev.filter((_, i) => i !== activeInvoiceIdx));
              setActiveInvoiceIdx(null);
              setView('dashboard');
            }}
          />
        )}

        {view === 'scan' && activeInvoice && (
          <ScanView
            invoice={activeInvoice}
            scanLog={scanLog.filter(l => l.invoiceNumber === activeInvoice.invoiceNumber)}
            onScan={processScan}
            onBack={() => setView('invoice')}
          />
        )}

        {view === 'sort' && (
          <SortView
            invoices={invoices}
            scanLog={scanLog.filter(l => l.source === 'sort' || l.source === 'manual' || l.source === 'bag_confirm' || l.source === 'skip' || l.source === 'near_match')}
            onScan={processGlobalScan}
            onConfirmBag={confirmBag}
            onConfirmNearMatch={confirmNearMatch}
            onSkipRemaining={skipRemainingUnits}
            onSelectStop={(idx) => { setActiveInvoiceIdx(idx); setView('invoice'); }}
            onMergeStops={mergeStops}
            onSplitStop={splitStop}
            stopOrder={stopOrder}
            onReorderStops={reorderStops}
            onPrintDayReport={handlePrintDayReport}
            onExportAnomalies={exportAnomaliesCsv}
            onBack={() => setView('dashboard')}
          />
        )}
      </main>

      {confirmClear && (
        <ConfirmDialog
          title="CLEAR ALL DATA"
          body="This removes every loaded invoice and the entire scan history from this phone. It cannot be undone."
          confirmLabel="DELETE ALL"
          onCancel={() => setConfirmClear(false)}
          onConfirm={clearAll}
        />
      )}

      {confirmDiscard && pendingSession && (
        <ConfirmDialog
          title="DISCARD TODAY'S SESSION"
          body={`Throw away the session saved at ${new Date(pendingSession.savedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} (${pendingSession.invoices.length} invoice${pendingSession.invoices.length === 1 ? '' : 's'}, ${pendingSession.scanLog.length} scan${pendingSession.scanLog.length === 1 ? '' : 's'})? It cannot be recovered.`}
          confirmLabel="DISCARD"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={discardPendingSession}
        />
      )}

      <footer className="border-t border-ink/15 px-3 py-2 mt-4 text-[10px] text-muted font-sans flex items-center justify-between flex-wrap gap-2">
        <span>Parts Receiving · Lane Check</span>
        <span>Session is kept on this phone for today only</span>
      </footer>
    </div>
  );
}

// ============================================================
// DASHBOARD
// ============================================================
function DashboardView({ invoices, scanLog, stats, searchTerm, setSearchTerm, onSelectInvoice, onLookupInvoiceCode, onUpload, uploadStatus, debugDump, onClearDebug, onResetScans, onStartSort, onPrintDayReport, onExportAnomalies }) {
  const fileInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [invoiceScanOpen, setInvoiceScanOpen] = useState(false);
  const [invoiceScanResult, setInvoiceScanResult] = useState(null);
  const [showDebug, setShowDebug] = useState(false);
  // Invoice ledger expand/collapse, persisted to localStorage so the
  // driver's choice survives reloads. Default open (preserves existing
  // behavior on first visit / cleared storage).
  const [ledgerOpen, setLedgerOpen] = useState(() => {
    try {
      const v = localStorage.getItem('dashboard:ledgerOpen');
      return v === null ? true : v === 'true';
    } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('dashboard:ledgerOpen', String(ledgerOpen)); } catch (e) { /* private mode etc. */ }
  }, [ledgerOpen]);

  const filtered = invoices.filter(inv =>
    !searchTerm ||
    inv.invoiceNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
    inv.vendor.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (inv.customer && inv.customer.toLowerCase().includes(searchTerm.toLowerCase())) ||
    (inv.vin && inv.vin.toLowerCase().includes(searchTerm.toLowerCase())) ||
    inv.lineItems.some(li => li.partNumber.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const handleInvoiceCodeDetected = (code) => {
    const result = onLookupInvoiceCode(code);
    if (result.found) {
      setInvoiceScanOpen(false);
      setInvoiceScanResult(null);
    } else {
      setInvoiceScanResult({ code, ts: Date.now() });
    }
  };

  const pct = stats.totalLineItems > 0 ? Math.round((stats.checkedItems / stats.totalLineItems) * 100) : 0;
  const empty = invoices.length === 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-ink/25 border border-ink/25">
        <StatBox
          label="Stops"
          value={groupInvoicesIntoStops(invoices).length}
          sub={`${invoices.length} invoice${invoices.length === 1 ? '' : 's'}`}
        />
        <StatBox label="Units to sort" value={stats.totalLineItems} sub="expected in lane" />
        <StatBox
          label="Verified"
          value={`${stats.checkedItems}/${stats.totalLineItems}`}
          sub={`${pct}% complete`}
          accent={stats.checkedItems === stats.totalLineItems && stats.totalLineItems > 0 ? '#4a7a30' : null}
        />
        <StatBox label="Anomalies" value={stats.flaggedItems} sub={`${stats.backOrderedCount} back-ordered`} accent={stats.flaggedItems > 0 ? '#a83232' : null} />
      </div>

      {!empty && (
        <div className="space-y-1.5">
          <button
            onClick={onStartSort}
            disabled={stats.totalLineItems === 0}
            className="btn btn-dark btn-lg w-full"
          >
            <Camera className="w-5 h-5" />
            START SORT
            <span className="font-mono font-normal text-paper/70 text-[13px] ml-1">{stats.checkedItems}/{stats.totalLineItems} units</span>
          </button>
          <div className="grid grid-cols-2 gap-1.5">
            <button onClick={onPrintDayReport} className="btn">
              <Printer className="w-4 h-4" /> DAY REPORT
            </button>
            <button onClick={onExportAnomalies} className="btn" title="Download anomaly CSV">
              <FileDown className="w-4 h-4" /> ANOMALY CSV
            </button>
          </div>
        </div>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file && file.type === 'application/pdf') onUpload(file);
        }}
        className={`panel ${dragOver ? 'border-green bg-green/5' : empty ? 'border-ink' : ''} transition-colors`}
      >
        <div className="p-3 flex flex-col md:flex-row md:items-center gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="w-10 h-10 shrink-0 border border-ink/30 bg-line flex items-center justify-center">
              <Upload className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="font-sans text-[13px] font-bold">{empty ? 'Start the day' : 'Add invoices'}</div>
              <div className="text-[11px] text-muted">
                {empty
                  ? "Upload today's invoice or route report PDFs. Nothing from earlier days is loaded."
                  : 'Upload another PDF, or scan a printed invoice barcode to open it.'}
              </div>
            </div>
          </div>
          <input
            type="file"
            accept="application/pdf"
            ref={fileInputRef}
            onChange={(e) => { if (e.target.files[0]) onUpload(e.target.files[0]); e.target.value = ''; }}
            className="hidden"
          />
          <div className="grid grid-cols-2 md:flex gap-1.5 shrink-0">
            <button onClick={() => setInvoiceScanOpen(true)} className="btn" disabled={empty}>
              <ScanLine className="w-4 h-4" /> SCAN INVOICE
            </button>
            <button onClick={() => fileInputRef.current?.click()} className="btn btn-dark">
              <Upload className="w-4 h-4" /> UPLOAD PDF
            </button>
          </div>
        </div>
        {(uploadStatus || debugDump) && (
          <div className={`px-3 py-2 text-[12px] font-sans font-bold flex items-center justify-between gap-2 flex-wrap ${
            uploadStatus?.stage === 'error' ? 'bg-red text-white' :
            uploadStatus?.stage === 'success' ? 'bg-green text-white' :
            uploadStatus ? 'bg-blue text-white' : 'bg-red/10 text-red'}`}
          >
            <span className="flex items-center gap-2">
              {uploadStatus?.stage === 'error' && <AlertTriangle className="w-4 h-4 shrink-0" />}
              {uploadStatus?.stage === 'success' && <Check className="w-4 h-4 shrink-0" strokeWidth={3} />}
              {uploadStatus?.message || 'Last upload could not be parsed.'}
            </span>
            {debugDump && (
              <button onClick={() => setShowDebug(true)} className="btn btn-sm bg-white text-red border-white hover:bg-paper hover:text-red">
                VIEW EXTRACTED TEXT
              </button>
            )}
          </div>
        )}
      </div>

      {/* PDF DEBUG VIEWER */}
      {showDebug && debugDump && (
        <div className="modal-backdrop">
          <div className="modal max-w-2xl max-h-[85vh] flex flex-col">
            <div className="panel-head">
              <span className="truncate">EXTRACTED TEXT — {debugDump.fileName}</span>
              <button onClick={() => setShowDebug(false)} className="btn btn-sm btn-ghost-dark btn-icon" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="bg-red/10 border-b border-red/30 px-3 py-2 text-[11px]">
              <div className="font-sans font-bold text-red tracking-wider mb-0.5">PARSE FAILED</div>
              <div>{debugDump.reason}</div>
              <div className="text-muted mt-1">{debugDump.pageCount} page(s) · {debugDump.rawText.length.toLocaleString()} chars extracted</div>
            </div>
            <div className="flex-1 overflow-auto p-3">
              {debugDump.rawText ? (
                <pre className="text-[10px] font-mono whitespace-pre-wrap break-words leading-snug">
                  {debugDump.rawText.slice(0, 20000)}
                  {debugDump.rawText.length > 20000 ? '\n\n... (truncated)' : ''}
                </pre>
              ) : (
                <div className="text-[12px] text-muted">
                  No text was extracted. The PDF is likely a scanned image — re-export from your DMS as a "text" or "searchable" PDF, or use OCR before uploading.
                </div>
              )}
            </div>
            <div className="border-t border-ink/20 px-3 py-2 flex justify-end gap-2">
              <button onClick={() => { setShowDebug(false); onClearDebug?.(); }} className="btn btn-sm">
                DISMISS
              </button>
            </div>
          </div>
        </div>
      )}

      {/* INVOICE BARCODE SCAN MODAL */}
      {invoiceScanOpen && (
        <div className="modal-backdrop">
          <div className="modal max-w-lg">
            <div className="panel-head">
              <span>SCAN INVOICE BARCODE</span>
              <button onClick={() => { setInvoiceScanOpen(false); setInvoiceScanResult(null); }} className="btn btn-sm btn-ghost-dark btn-icon" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="panel-sub font-sans">Point the camera at the invoice number barcode.</div>

            <BarcodeScanner onDetect={handleInvoiceCodeDetected} label="INVOICE LOOKUP" />

            {invoiceScanResult && (
              <div className="bg-red/10 border-t border-red/30 px-3 py-3">
                <div className="font-sans text-[12px] font-bold text-red tracking-wider mb-1 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" /> INVOICE NOT FOUND
                </div>
                <div className="text-[11px] mb-1">
                  Code <span className="font-bold">{invoiceScanResult.code}</span> doesn't match any loaded invoice.
                </div>
                <div className="text-[11px] text-muted">Upload the corresponding PDF to add it.</div>
              </div>
            )}

            <div className="p-3 border-t border-ink/20">
              <div className="label mb-1.5">Manual lookup</div>
              <ManualInvoiceLookup onSubmit={(code) => {
                const r = onLookupInvoiceCode(code);
                if (r.found) {
                  setInvoiceScanOpen(false);
                  setInvoiceScanResult(null);
                } else {
                  setInvoiceScanResult({ code: r.code, ts: Date.now() });
                }
              }} />
            </div>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <button
            onClick={() => setLedgerOpen(o => !o)}
            className="flex items-center gap-1.5 min-h-[32px] -ml-1 pl-1 pr-2 hover:bg-white/10"
            aria-expanded={ledgerOpen}
            title={ledgerOpen ? 'Collapse ledger' : 'Expand ledger'}
          >
            <ChevronRight className={`w-4 h-4 transition-transform ${ledgerOpen ? 'rotate-90' : ''}`} />
            <span>INVOICES</span>
            <span className="text-paper/60 font-mono font-normal">{invoices.length}</span>
          </button>
          {ledgerOpen && !empty && (
            <div className="flex items-center gap-1">
              <button onClick={onResetScans} title="Reset all check states" className="btn btn-sm btn-ghost-dark hidden sm:inline-flex">
                <RefreshCw className="w-3.5 h-3.5" /> RESET CHECKS
              </button>
              <div className="flex items-center gap-1.5 bg-white/10 px-2 h-8">
                <Search className="w-3.5 h-3.5 text-paper/70" />
                <input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="inv# / shop / part"
                  className="bg-transparent outline-none text-[12px] w-32 sm:w-44 placeholder:text-paper/40 font-mono font-normal"
                />
              </div>
            </div>
          )}
        </div>

        {ledgerOpen && !empty && (
          <div className="hidden md:grid grid-cols-12 gap-2 px-3 py-1.5 label border-b border-ink/20 bg-line">
            <div className="col-span-2">Invoice #</div>
            <div className="col-span-3">Shop / stop</div>
            <div className="col-span-3">Vendor · vehicle</div>
            <div className="col-span-1">Ship via</div>
            <div className="col-span-1 text-right">Units</div>
            <div className="col-span-1 text-right">Total</div>
            <div className="col-span-1 text-right">Status</div>
          </div>
        )}

        {ledgerOpen && filtered.length === 0 && (
          <div className="px-3 py-8 text-center text-[12px] text-muted">
            <FileSearch className="w-6 h-6 mx-auto mb-2 text-muted/70" />
            {empty ? 'No invoices loaded yet. Upload a PDF to begin.' : 'No invoices match the filter.'}
          </div>
        )}

        {ledgerOpen && filtered.map((inv) => {
          const realIdx = invoices.findIndex(i => i.invoiceNumber === inv.invoiceNumber);
          const shippedItems = inv.lineItems.filter(li => li.shipped > 0);
          const totalUnits = shippedItems.reduce((s, li) => s + li.unitsExpected, 0);
          // Clamp each line's unitsScanned to its unitsExpected so a stale
          // over-increment from a rapid scan burst can't make the ledger
          // total exceed the actual capacity (e.g. "8/2").
          const scannedUnits = shippedItems.reduce((s, li) => s + Math.min(li.unitsScanned || 0, li.unitsExpected), 0);
          const allChecked = totalUnits > 0 && scannedUnits === totalUnits;
          const inProgress = scannedUnits > 0 && !allChecked;
          const hasAnomaly = scanLog.some(l => l.invoiceNumber === inv.invoiceNumber && (l.status === 'WRONG_LANE' || l.status === 'BACK_ORDER_ANOMALY'));
          const status = allChecked
            ? { label: 'DONE', cls: 'bg-green text-white' }
            : hasAnomaly
              ? { label: 'FLAG', cls: 'bg-red text-white' }
              : inProgress
                ? { label: 'WIP', cls: 'bg-blue text-white' }
                : { label: 'OPEN', cls: 'bg-line text-ink' };

          return (
            <button
              key={inv.id}
              onClick={() => onSelectInvoice(realIdx)}
              className="w-full row hover:bg-line/60 transition-colors text-left px-3 py-2.5 md:grid md:grid-cols-12 md:gap-2 md:items-center"
            >
              {/* Phone layout: two lines, status on the right. Desktop: table columns. */}
              <div className="flex items-start justify-between gap-2 md:contents">
                <div className="min-w-0 md:col-span-2">
                  <div className="font-bold text-[14px] md:text-[13px]">{inv.invoiceNumber}</div>
                  <div className="text-[11px] text-muted md:hidden truncate">{inv.customer || '—'}</div>
                </div>
                <div className="hidden md:block md:col-span-3 min-w-0">
                  <div className="text-[12px] font-sans font-bold truncate">{inv.customer || '—'}</div>
                  <div className="text-[10px] text-muted truncate">{inv.customerAddress || ''}</div>
                </div>
                <div className="hidden md:block md:col-span-3 min-w-0">
                  <div className="text-[11px] truncate">{inv.vendor}</div>
                  <div className="text-[10px] text-muted truncate">{inv.vehicle || inv.location || '—'}{inv.vin ? ` · ${inv.vin}` : ''}</div>
                </div>
                <div className="hidden md:block md:col-span-1 text-[11px] truncate">{inv.shipVia || '—'}</div>
                <div className="hidden md:block md:col-span-1 text-right text-[12px]">
                  <span className="font-bold">{scannedUnits}</span>
                  <span className="text-muted">/{totalUnits}</span>
                </div>
                <div className="hidden md:block md:col-span-1 text-right text-[11px]">{inv.total ? `$${inv.total.toFixed(2)}` : '—'}</div>
                <div className="shrink-0 text-right md:col-span-1">
                  <span className={`badge ${status.cls}`}>{status.label}</span>
                  <div className="text-[11px] mt-1 md:hidden">
                    <span className="font-bold">{scannedUnits}</span>
                    <span className="text-muted">/{totalUnits} units</span>
                  </div>
                </div>
              </div>
              <div className="text-[10px] text-muted mt-1 truncate md:hidden">
                {inv.vendor}{inv.shipVia ? ` · ${inv.shipVia}` : ''}{inv.total ? ` · $${inv.total.toFixed(2)}` : ''}
              </div>
            </button>
          );
        })}
      </div>

      {scanLog.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <span>ACTIVITY</span>
            <span className="text-paper/60 font-mono font-normal text-[11px]">last {Math.min(scanLog.length, 15)} of {scanLog.length}</span>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {scanLog.slice(0, 15).map((log, i) => (
              <div key={i} className="row px-3 py-1.5 text-[11px] flex items-center gap-2">
                <span className="text-muted shrink-0 w-14">{log.ts}</span>
                <span className="font-bold truncate flex-1">{log.partNumber}</span>
                <span className="hidden sm:inline text-muted truncate max-w-[40%]">{log.note}</span>
                <StatusBadge status={log.status} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// INVOICE DETAIL
// ============================================================
function InvoiceDetailView({ invoice, scanLog, onScan, onBack, showRawText, setShowRawText, onResetInvoice, onDeleteInvoice }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const shippedRows = invoice.lineItems.filter(li => li.shipped > 0).length;
  const boRows = invoice.lineItems.filter(li => li.backOrdered > 0 && li.shipped === 0).length;

  return (
    <div className="space-y-3">
      <div className="panel border-ink">
        <div className="panel-head">
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={onBack} className="btn btn-sm btn-ghost-dark btn-icon -ml-2" aria-label="Back to dashboard">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <div className="truncate">{invoice.customer || `INVOICE ${invoice.invoiceNumber}`}</div>
              {invoice.customer && <div className="text-[11px] font-mono font-normal text-paper/70">INV {invoice.invoiceNumber}</div>}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={onResetInvoice} title="Reset scan state" className="btn btn-sm btn-ghost-dark btn-icon" aria-label="Reset scans">
              <RefreshCw className="w-4 h-4" />
            </button>
            <button onClick={() => setConfirmDelete(true)} title="Delete invoice" className="btn btn-sm btn-ghost-dark btn-icon" aria-label="Delete invoice">
              <Trash2 className="w-4 h-4" />
            </button>
            <button onClick={onScan} className="btn btn-sm btn-blue">
              <Camera className="w-4 h-4" /> SCAN
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-ink/20">
          <InfoCell label="Vendor" value={invoice.vendor} sub={invoice.location} />
          <InfoCell label="Account" value={invoice.accountNumber || '—'} sub={invoice.yourOrderNo ? `Order ${invoice.yourOrderNo}` : ''} />
          <InfoCell label="Vehicle" value={invoice.vehicle || '—'} sub={invoice.vin || ''} mono />
          <InfoCell label="Ship via" value={invoice.shipVia || '—'} sub={invoice.dateShipped} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span>LINE ITEMS <span className="text-paper/60 font-mono font-normal">{invoice.lineItems.length}</span></span>
          <span className="text-[11px] font-mono font-normal text-paper/70">
            {shippedRows} shipped · {boRows} B/O
          </span>
        </div>

        <div className="hidden md:grid grid-cols-12 gap-1 px-3 py-1.5 label border-b border-ink/20 bg-line">
          <div className="col-span-1">Check</div>
          <div className="col-span-3">Part number</div>
          <div className="col-span-3">Description</div>
          <div className="col-span-1 text-right">Ord</div>
          <div className="col-span-1 text-right">Ship</div>
          <div className="col-span-1 text-right">B/O</div>
          <div className="col-span-1 text-right">Net</div>
          <div className="col-span-1 text-right">Amt</div>
        </div>

        {invoice.lineItems.map((item, i) => {
          const isBackOrdered = item.backOrdered > 0 && item.shipped === 0;
          const partialScan = item.unitsExpected > 0 && (item.unitsScanned || 0) > 0 && (item.unitsScanned || 0) < item.unitsExpected;
          const rowBg = isBackOrdered ? 'bg-red/5' : item.checked ? 'bg-green/10' : partialScan ? 'bg-blue/10' : '';

          return (
            <div key={i} className={`row grid grid-cols-12 gap-1 px-3 py-2 text-[12px] items-center ${rowBg}`}>
              <div className="col-span-2 md:col-span-1 flex items-center">
                {isBackOrdered ? (
                  <span className="badge bg-red/10 text-red">B/O</span>
                ) : item.checked ? (
                  <Check className="w-5 h-5 text-green" strokeWidth={3} />
                ) : partialScan ? (
                  <span className="text-[11px] font-bold text-blue">{item.unitsScanned}/{item.unitsExpected}</span>
                ) : (
                  <div className="w-4 h-4 border border-ink/40"></div>
                )}
              </div>
              <div className="col-span-10 md:col-span-3 font-bold text-[13px]">{item.partNumber}</div>
              <div className="col-span-12 md:col-span-3 text-[11px] pl-[16.67%] md:pl-0">
                {item.description}
                {item.note && <div className="text-[10px] text-red mt-0.5">{item.note}</div>}
              </div>
              <div className="col-span-3 md:col-span-1 text-right"><span className="label md:hidden mr-1">Ord</span>{item.ordered}</div>
              <div className="col-span-3 md:col-span-1 text-right font-bold"><span className="label md:hidden mr-1">Ship</span>{item.shipped}</div>
              <div className="col-span-3 md:col-span-1 text-right text-red"><span className="label md:hidden mr-1">B/O</span>{item.backOrdered || '—'}</div>
              <div className="col-span-3 md:col-span-1 text-right text-muted text-[11px]">{item.netPrice.toFixed(2)}</div>
              <div className="hidden md:block md:col-span-1 text-right text-[11px]">{item.amount > 0 ? item.amount.toFixed(2) : '—'}</div>
            </div>
          );
        })}

        {invoice.total && (
          <div className="grid grid-cols-12 gap-1 px-3 py-2 text-[13px] bg-ink text-paper font-bold">
            <div className="col-span-9 text-right font-sans tracking-wider">TOTAL</div>
            <div className="col-span-3 text-right">${invoice.total.toFixed(2)}</div>
          </div>
        )}
      </div>

      {scanLog.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <span>SCAN HISTORY <span className="text-paper/60 font-mono font-normal">{scanLog.length}</span></span>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {scanLog.slice(0, 20).map((log, i) => (
              <div key={i} className="row px-3 py-1.5 text-[11px] flex items-center gap-2">
                <span className="text-muted shrink-0 w-14">{log.ts}</span>
                <span className="font-bold truncate flex-1">{log.partNumber}</span>
                <span className="hidden sm:inline text-muted truncate max-w-[40%]">{log.note}</span>
                <StatusBadge status={log.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      {invoice.rawText && (
        <div className="panel">
          <button
            onClick={() => setShowRawText(!showRawText)}
            className="w-full bg-line px-3 min-h-[36px] label flex items-center justify-between hover:bg-[#d4d4d4]"
          >
            <span className="flex items-center gap-1.5">
              {showRawText ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />} Raw parse output (debug)
            </span>
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showRawText ? 'rotate-90' : ''}`} />
          </button>
          {showRawText && (
            <pre className="text-[10px] p-3 max-h-64 overflow-auto whitespace-pre-wrap break-all bg-ink text-paper/80">
              {invoice.rawText}
            </pre>
          )}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="DELETE INVOICE"
          body={`Remove invoice ${invoice.invoiceNumber}${invoice.customer ? ` (${invoice.customer})` : ''} and its scan progress?`}
          confirmLabel="DELETE"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { setConfirmDelete(false); onDeleteInvoice(); }}
        />
      )}
    </div>
  );
}

// ============================================================
// BARCODE SCANNER — reusable component
// ============================================================
// Strategy for fast + accurate scanning of auto-parts barcodes:
//
//   1. Format whitelist. Auto parts use Code 128, Code 39, Data Matrix,
//      QR, and ITF. Restricting to these (vs. trying all 17 supported
//      formats every frame) cuts decode time by 3-5×.
//   2. Engine selection. Native BarcodeDetector is preferred on iOS /
//      desktop. On Android Chrome, BarcodeDetector often returns empty
//      without throwing (so a throw-based failover never switches) —
//      we skip native entirely on Android and use ZXing.
//   3. Cropped center-region decode. Each frame is drawn into a canvas
//      cropped to a 70%-wide × 35%-tall center rectangle.
//   4. Confirmation buffer. A code must repeat N times within 700ms.
//      N=2 on iPhone; N=1 on Android (slow decode rarely hits 2-in-700ms).
//   5. Camera constraints. 1080p ideal / 30fps ideal (no hard min fps).
//      OverconstrainedError → retry with facingMode:environment only.
//   6. Optional torch toggle when the camera advertises that capability.
//
// Lifecycle rules (the part that keeps the camera honest):
//
//   - Every start() gets a generation number. Anything that resumes after
//     an await (getUserMedia, ZXing import, native detect) checks it is
//     still the current generation; if not, it releases whatever it holds
//     and exits. This closes the "unmounted while permission prompt was
//     open → camera left on" and "stopped during init → LIVE on a black
//     video" holes.
//   - The decode loop is a single self-rescheduling rAF chain that also
//     checks the generation, so a stop/start cycle can't leave two loops
//     decoding the same frames.
//   - The camera is released when the tab is hidden or the page is being
//     unloaded, and restarted (if it was live) when the tab comes back.
//     A track that ends underneath us (OS or another app took the camera)
//     surfaces as an error with RETRY instead of a frozen frame.
//   - The consumer's onDetect is read through a ref, so a long-running
//     loop always calls the latest handler (with current invoice state)
//     rather than the one captured when the camera started.
//   - After a code is emitted it must leave the frame (not be decoded for
//     REARM_GAP_MS) before the same code can emit again. Holding a part in
//     the box no longer double-counts it.

// Auto-parts barcode formats — keep in sync between native BarcodeDetector
// and ZXing names (different naming conventions per API).
const SCAN_FORMATS_NATIVE = ['code_128', 'code_39', 'data_matrix', 'qr_code', 'itf'];
const SCAN_FORMATS_ZXING = ['CODE_128', 'CODE_39', 'DATA_MATRIX', 'QR_CODE', 'ITF'];

// Center scan region (fraction of frame). Matches the visible bracket.
const CROP_W_FRAC = 0.70;
const CROP_H_FRAC = 0.35;

const IS_ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
const IS_IOS = typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
   (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
// A code must repeat this many times within this window to be accepted.
// Android: 1 — ZXing decode is slow enough that requiring 2-in-700ms often
// never confirms. iPhone keeps 2 for shake/hover rejection.
const CONFIRM_COUNT = IS_ANDROID ? 1 : 2;
const CONFIRM_WINDOW_MS = 700;
// After a successful emit, ignore the same code for at least this long.
const COOLDOWN_MS = 1500;
// ...and additionally require the code to have been absent from the decode
// stream for this long before it can emit again. ZXing on Android misses
// the odd frame on a steady barcode (gaps of ~100–300ms), so this must be
// comfortably larger than that while still feeling instant when the driver
// pulls one unit away and presents the next.
const REARM_GAP_MS = 600;
// Plausibility filter: real part numbers and invoice numbers in this app
// are always 6+ characters. Auto-parts labels often carry a tiny secondary
// barcode encoding the per-pack quantity (a single digit like "1"), or a
// date/batch code. Those reads end up as bogus UNKNOWN flashes that
// interrupt the driver. Drop them at the scanner boundary so the camera
// just keeps running until something part-shaped lands in the box.
const MIN_PLAUSIBLE_CODE_LEN = 6;

function cameraErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    if (IS_IOS) return 'Camera blocked. Tap “AA” in the address bar → Website Settings → Camera → Allow, then retry.';
    if (IS_ANDROID) return 'Camera blocked. Tap the lock icon in the address bar → Permissions → Camera → Allow, then retry.';
    return 'Camera permission denied. Allow camera access for this site in the browser settings, then retry.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No camera found on this device.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'Camera is in use by another app. Close it and retry.';
  if (name === 'OverconstrainedError') return 'No camera matched the requested settings.';
  if (name === 'AbortError') return 'Camera start was interrupted. Retry.';
  return (err && err.message) || 'Camera unavailable';
}

function BarcodeScanner({ onDetect, label = 'BARCODE', autoStart = false, paused = false }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  // Two parallel detector engines. We prefer the native one when it works
  // because it's hardware-accelerated, but the JS-only ZXing fallback is
  // always available as a safety net. On Android we skip native entirely.
  const nativeDetectRef = useRef(null);
  const zxingDetectRef = useRef(null);
  const nativeFailRef = useRef(0);
  const nativeEmptyRef = useRef(0);
  const rafRef = useRef(null);
  const recentRef = useRef([]);
  const lastEmitRef = useRef({ code: null, t: 0, seenAt: 0, rearmed: true });
  // Incremented on every start()/stop(); async continuations compare
  // against it and bail if they're from a previous generation.
  const genRef = useRef(0);
  const mountedRef = useRef(true);
  // True while the camera is (or is becoming) live. Read by the visibility
  // handler to decide whether to restart when the tab comes back.
  const wantLiveRef = useRef(false);
  const resumeOnVisibleRef = useRef(false);
  // Latest-value refs so the long-lived decode loop never calls stale props.
  const onDetectRef = useRef(onDetect);
  const pausedRef = useRef(paused);
  useEffect(() => {
    onDetectRef.current = onDetect;
    pausedRef.current = paused;
  }, [onDetect, paused]);
  // The rAF chain re-enters decodeFrame through this ref.
  const decodeFrameRef = useRef(null);

  const [state, setState] = useState(autoStart ? 'starting' : 'idle');
  const [errorMsg, setErrorMsg] = useState(null);
  const [initError, setInitError] = useState(null);
  const [engineKind, setEngineKind] = useState(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);

  // Create the per-frame decode canvas once, in JS, kept entirely out of the
  // DOM tree. Using a `<canvas className="hidden">` had a problem: `display:
  // none` causes some browsers (Safari especially) to skip image-data work,
  // which silently breaks `getImageData` and the ZXing luminance source.
  useEffect(() => {
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
    }
  }, []);

  // Release hardware + decoders without touching the UI state. Callers
  // decide what state follows (idle / paused / error).
  const releaseCamera = useCallback(() => {
    genRef.current += 1;
    wantLiveRef.current = false;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    nativeDetectRef.current = null;
    zxingDetectRef.current = null;
    nativeFailRef.current = 0;
    nativeEmptyRef.current = 0;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => {
        try { t.onended = null; } catch (e) { }
        try { t.stop(); } catch (e) { }
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      try { videoRef.current.pause(); } catch (e) { }
      try { videoRef.current.srcObject = null; } catch (e) { }
    }
    recentRef.current = [];
    lastEmitRef.current = { code: null, t: 0, seenAt: 0, rearmed: true };
  }, []);

  const stop = useCallback(() => {
    releaseCamera();
    resumeOnVisibleRef.current = false;
    if (!mountedRef.current) return;
    setTorchOn(false);
    setTorchAvailable(false);
    setEngineKind(null);
    setErrorMsg(null);
    setState('idle');
  }, [releaseCamera]);

  const failWith = useCallback((message) => {
    releaseCamera();
    if (!mountedRef.current) return;
    setTorchOn(false);
    setTorchAvailable(false);
    setEngineKind(null);
    setErrorMsg(message);
    setState('error');
  }, [releaseCamera]);

  // Returns true when `code` should be emitted to the consumer.
  const tryConfirm = useCallback((code) => {
    // Implausibility filter — drop reads that are too short to be a real
    // part number or invoice. Common offenders: the small qty-of-1 barcode
    // on a Honda/Mopar parts label, two-digit date markers, etc. These
    // never become a useful match downstream and only generate UNKNOWN
    // flashes that interrupt the driver. Filtered before the confirmation
    // buffer so they can't even claim a slot.
    if (!code || code.length < MIN_PLAUSIBLE_CODE_LEN) return false;

    const now = Date.now();
    const last = lastEmitRef.current;
    if (last.code === code) {
      // Same code as the last emit. It has to disappear from the decode
      // stream for REARM_GAP_MS before it may fire again — otherwise a part
      // held steady in the box would re-count every COOLDOWN_MS.
      const gap = now - last.seenAt;
      last.seenAt = now;
      if (!last.rearmed) {
        if (gap < REARM_GAP_MS) return false;
        last.rearmed = true;
      }
      if (now - last.t < COOLDOWN_MS) return false;
    }
    recentRef.current = recentRef.current
      .filter(e => now - e.t < CONFIRM_WINDOW_MS)
      .concat({ t: now, code });
    const matches = recentRef.current.filter(e => e.code === code).length;
    if (matches >= CONFIRM_COUNT) {
      recentRef.current = [];
      lastEmitRef.current = { code, t: now, seenAt: now, rearmed: false };
      return true;
    }
    return false;
  }, []);

  const decodeFrame = useCallback(async (gen) => {
    if (gen !== genRef.current) return;
    const schedule = () => {
      if (gen !== genRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        if (decodeFrameRef.current) decodeFrameRef.current(gen);
      });
    };

    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth) {
      schedule();
      return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cropW = Math.max(64, Math.floor(vw * CROP_W_FRAC));
    const cropH = Math.max(64, Math.floor(vh * CROP_H_FRAC));
    const cropX = Math.floor((vw - cropW) / 2);
    const cropY = Math.floor((vh - cropH) / 2);
    if (canvas.width !== cropW) canvas.width = cropW;
    if (canvas.height !== cropH) canvas.height = cropH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    let result = null;

    // Native first — but only if it hasn't been consistently throwing OR
    // returning empty. Chrome Android's BarcodeDetector often returns []
    // forever without throwing, so we also bail after ~60 empty results.
    const native = nativeDetectRef.current;
    if (native && nativeFailRef.current < 5) {
      try {
        result = await native(canvas);
        if (gen !== genRef.current) return;
        if (result) {
          nativeFailRef.current = 0;
          nativeEmptyRef.current = 0;
        } else {
          nativeEmptyRef.current++;
          if (nativeEmptyRef.current >= 60) {
            console.warn('[scanner] native BarcodeDetector returned empty 60×, switching to ZXing');
            nativeDetectRef.current = null;
            setEngineKind(IS_ANDROID ? 'android-zxing' : 'zxing');
          }
        }
      } catch (e) {
        if (gen !== genRef.current) return;
        nativeFailRef.current++;
        if (nativeFailRef.current >= 5) {
          console.warn('[scanner] native BarcodeDetector failed 5 times in a row, switching to ZXing');
          nativeDetectRef.current = null;
          setEngineKind(IS_ANDROID ? 'android-zxing' : 'zxing');
        }
      }
    }

    // ZXing fallback — runs when no native detector, native is disabled, or
    // native returned null on this frame. ZXing on a cropped 70%×35% canvas
    // is fast enough (~30ms) to run every frame even without native.
    if (!result && zxingDetectRef.current) {
      try {
        result = zxingDetectRef.current(canvas);
      } catch (e) { /* ignore */ }
    }

    // While the consumer is paused (e.g. a bag-count prompt is open) we keep
    // decoding so the re-arm tracking sees the part is still in the box, but
    // nothing is emitted.
    if (result && result.text && tryConfirm(result.text) && !pausedRef.current) {
      if (navigator.vibrate) {
        try { navigator.vibrate(40); } catch (e) { /* unsupported */ }
      }
      onDetectRef.current(result.text);
    }

    schedule();
  }, [tryConfirm]);
  useEffect(() => { decodeFrameRef.current = decodeFrame; }, [decodeFrame]);

  // Build native + ZXing detectors. On Android we skip native entirely —
  // Chrome's BarcodeDetector returns empty without throwing, which blocks
  // failover. ZXing (bundled) is the reliable path there.
  const buildDetectors = async () => {
    let kind = null;
    const initErrors = [];

    // Native BarcodeDetector — skipped on Android for reliability.
    if (!IS_ANDROID && typeof window.BarcodeDetector === 'function') {
      try {
        let formats = SCAN_FORMATS_NATIVE;
        if (typeof window.BarcodeDetector.getSupportedFormats === 'function') {
          const supported = await window.BarcodeDetector.getSupportedFormats();
          formats = SCAN_FORMATS_NATIVE.filter(f => supported.includes(f));
        }
        if (formats.length > 0) {
          const native = new window.BarcodeDetector({ formats });
          // Convert the canvas to an ImageBitmap before detect — iOS Safari's
          // BarcodeDetector is more reliable with ImageBitmap input than with
          // an HTMLCanvasElement directly.
          nativeDetectRef.current = async (canvas) => {
            let bitmap;
            try {
              bitmap = await createImageBitmap(canvas);
            } catch (e) {
              // createImageBitmap can fail on some inputs; pass canvas
              // directly as a fallback.
              const codes = await native.detect(canvas);
              return codes.length ? { text: codes[0].rawValue, format: codes[0].format } : null;
            }
            try {
              const codes = await native.detect(bitmap);
              return codes.length ? { text: codes[0].rawValue, format: codes[0].format } : null;
            } finally {
              if (bitmap.close) bitmap.close();
            }
          };
          kind = 'native';
        }
      } catch (e) {
        console.warn('[scanner] BarcodeDetector init failed, falling back to ZXing:', e);
        initErrors.push('native: ' + (e.message || String(e)));
      }
    }

    // ZXing — always built so we have a fallback even when native is preferred.
    try {
      const ZXing = await loadZXing();
      if (ZXing && ZXing.MultiFormatReader && ZXing.HTMLCanvasElementLuminanceSource &&
          ZXing.HybridBinarizer && ZXing.BinaryBitmap) {
        const reader = new ZXing.MultiFormatReader();
        const hints = new Map();
        if (ZXing.DecodeHintType && ZXing.BarcodeFormat) {
          const fmts = SCAN_FORMATS_ZXING
            .map(name => ZXing.BarcodeFormat[name])
            .filter(v => v !== undefined);
          if (fmts.length > 0) hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, fmts);
          if (ZXing.DecodeHintType.TRY_HARDER !== undefined) {
            hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
          }
        }
        try { reader.setHints(hints); } catch (e) { /* setHints may not exist on all builds */ }
        // decode(image) with no hints argument re-runs setHints(undefined)
        // on every frame — throwing away the format whitelist and TRY_HARDER
        // and re-allocating every sub-reader. decodeWithState keeps the
        // hints set above.
        const decodeOnce = typeof reader.decodeWithState === 'function'
          ? (bitmap) => reader.decodeWithState(bitmap)
          : (bitmap) => reader.decode(bitmap, hints);

        zxingDetectRef.current = (canvas) => {
          try {
            const lum = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
            const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum));
            const r = decodeOnce(bitmap);
            try { reader.reset(); } catch (_) { }
            return r ? { text: r.getText(), format: r.getBarcodeFormat ? r.getBarcodeFormat() : null } : null;
          } catch (e) {
            try { reader.reset(); } catch (_) { }
            return null;
          }
        };
        if (!kind) kind = IS_ANDROID ? 'android-zxing' : 'zxing';
      } else {
        initErrors.push('zxing: API surface incomplete');
      }
    } catch (e) {
      console.warn('[scanner] ZXing init failed:', e);
      initErrors.push('zxing: ' + (e.message || String(e)));
    }

    if (mountedRef.current) setInitError(initErrors.length ? initErrors.join(' · ') : null);

    if (!nativeDetectRef.current && !zxingDetectRef.current) {
      throw new Error('No barcode decoder could be initialized' +
        (initErrors.length ? ' (' + initErrors.join('; ') + ')' : ''));
    }
    return kind;
  };

  const start = useCallback(async (opts = {}) => {
    const isResume = opts && opts.resume === true;
    // Tear down anything from a previous generation first, then claim a new
    // generation for this attempt.
    releaseCamera();
    const gen = ++genRef.current;
    wantLiveRef.current = true;
    resumeOnVisibleRef.current = false;
    setState('starting');
    setErrorMsg(null);
    setInitError(null);
    setTorchOn(false);
    setTorchAvailable(false);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      failWith('Camera API unavailable. Use HTTPS and a modern browser.');
      return;
    }
    if (typeof window.isSecureContext === 'boolean' && !window.isSecureContext) {
      failWith('Camera requires a secure (HTTPS) connection.');
      return;
    }

    const stillCurrent = () => gen === genRef.current && mountedRef.current;

    try {
      const preferred = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          // ideal only — a hard min fps rejects many Android cameras
          frameRate: { ideal: 30 }
        },
        audio: false
      };
      const fallback = {
        video: { facingMode: 'environment' },
        audio: false
      };

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(preferred);
      } catch (err) {
        if (err && err.name === 'OverconstrainedError') {
          console.warn('[scanner] OverconstrainedError — retrying with facingMode only');
          stream = await navigator.mediaDevices.getUserMedia(fallback);
        } else {
          throw err;
        }
      }
      // The permission prompt can sit open for seconds; if the scanner was
      // closed or restarted in the meantime this stream must not leak.
      if (!stillCurrent()) {
        stream.getTracks().forEach(t => { try { t.stop(); } catch (e) { } });
        return;
      }
      streamRef.current = stream;

      const track = stream.getVideoTracks()[0];
      if (track) {
        // OS revoked the camera (phone call, another app, iOS backgrounding
        // without a visibilitychange). Without this the video freezes on
        // the last frame and the decode loop spins on it forever.
        track.onended = () => {
          if (gen !== genRef.current) return;
          console.warn('[scanner] camera track ended');
          failWith('Camera stream ended — the system or another app took the camera.');
        };
      }
      try {
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        const advanced = [];
        if (caps.focusMode && caps.focusMode.includes && caps.focusMode.includes('continuous')) {
          advanced.push({ focusMode: 'continuous' });
        }
        if (caps.exposureMode && caps.exposureMode.includes && caps.exposureMode.includes('continuous')) {
          advanced.push({ exposureMode: 'continuous' });
        }
        if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes && caps.whiteBalanceMode.includes('continuous')) {
          advanced.push({ whiteBalanceMode: 'continuous' });
        }
        if (advanced.length > 0) {
          await track.applyConstraints({ advanced });
        }
        if (!stillCurrent()) return;
        if (caps && 'torch' in caps) setTorchAvailable(true);
      } catch (e) { /* non-fatal */ }

      const video = videoRef.current;
      if (!video) {
        releaseCamera();
        return;
      }
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      video.setAttribute('webkit-playsinline', 'true');
      video.muted = true;
      video.playsInline = true;
      try { await video.play(); } catch (e) { /* autoplay quirks */ }
      if (!stillCurrent()) return;

      const kind = await buildDetectors();
      if (!stillCurrent()) return;
      setEngineKind(kind);
      setState('live');
      rafRef.current = requestAnimationFrame(() => decodeFrame(gen));
    } catch (err) {
      if (!stillCurrent()) return;
      console.error('Scanner start failed:', err);
      // Some browsers (iOS Safari in particular) refuse a gesture-less
      // getUserMedia even when permission was granted a minute ago. When
      // that happens on an automatic resume, say so instead of telling the
      // driver their permissions are wrong.
      if (isResume && err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        failWith('Camera needs a tap to restart after returning to the app. Tap RETRY.');
      } else {
        failWith(cameraErrorMessage(err));
      }
    }
  }, [decodeFrame, releaseCamera, failWith]);

  const pauseForBackground = useCallback(() => {
    if (!wantLiveRef.current) return;
    releaseCamera();
    resumeOnVisibleRef.current = true;
    if (!mountedRef.current) return;
    setTorchOn(false);
    setTorchAvailable(false);
    setEngineKind(null);
    setState('paused');
  }, [releaseCamera]);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current && streamRef.current.getVideoTracks
      ? streamRef.current.getVideoTracks()[0] : null;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
    } catch (e) {
      console.warn('torch toggle failed:', e);
    }
  }, [torchOn]);

  useEffect(() => {
    mountedRef.current = true;
    if (autoStart) start();

    // Release the camera when the driver switches apps / locks the phone,
    // and bring it back when they return. pagehide covers navigation and
    // bfcache, where no unmount runs.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        pauseForBackground();
      } else if (document.visibilityState === 'visible' && resumeOnVisibleRef.current) {
        resumeOnVisibleRef.current = false;
        start({ resume: true });
      }
    };
    const onPageHide = () => pauseForBackground();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      releaseCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusWord = state === 'live' ? 'LIVE' : state === 'starting' ? 'STARTING' : state === 'error' ? 'ERROR' : state === 'paused' ? 'PAUSED' : 'OFF';
  const hint = state === 'live' ? 'Center the barcode in the box and hold steady' :
    state === 'starting' ? 'Requesting camera…' :
    state === 'error' ? 'Camera error' :
    state === 'paused' ? 'Camera paused' :
    'Tap START CAMERA';

  return (
    <div>
      <div className="aspect-[4/3] bg-ink relative overflow-hidden">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline
          muted
          autoPlay
        />
        {/* The decode canvas is created in JS (see useEffect) and lives outside
            the DOM tree, so display:none doesn't affect getImageData reads. */}

        <div className="absolute inset-0 pointer-events-none">
          {/* Dim mask outside the active scan region — visually communicates
              that only the inner box is being decoded. */}
          <div
            className="absolute inset-0"
            style={{
              background:
                `linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.55) ${(1 - CROP_H_FRAC) / 2 * 100}%, transparent ${(1 - CROP_H_FRAC) / 2 * 100}%, transparent ${(1 + CROP_H_FRAC) / 2 * 100}%, rgba(0,0,0,0.55) ${(1 + CROP_H_FRAC) / 2 * 100}%, rgba(0,0,0,0.55) 100%),` +
                `linear-gradient(to right, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.45) ${(1 - CROP_W_FRAC) / 2 * 100}%, transparent ${(1 - CROP_W_FRAC) / 2 * 100}%, transparent ${(1 + CROP_W_FRAC) / 2 * 100}%, rgba(0,0,0,0.45) ${(1 + CROP_W_FRAC) / 2 * 100}%, rgba(0,0,0,0.45) 100%)`
            }}
          />
          {/* Scan zone — exactly matches the cropped decode region */}
          <div
            className="absolute"
            style={{
              left: `${(1 - CROP_W_FRAC) / 2 * 100}%`,
              right: `${(1 - CROP_W_FRAC) / 2 * 100}%`,
              top: `${(1 - CROP_H_FRAC) / 2 * 100}%`,
              bottom: `${(1 - CROP_H_FRAC) / 2 * 100}%`
            }}
          >
            <div className="absolute top-0 left-0 w-6 h-6 border-l-2 border-t-2 border-white"></div>
            <div className="absolute top-0 right-0 w-6 h-6 border-r-2 border-t-2 border-white"></div>
            <div className="absolute bottom-0 left-0 w-6 h-6 border-l-2 border-b-2 border-white"></div>
            <div className="absolute bottom-0 right-0 w-6 h-6 border-r-2 border-b-2 border-white"></div>
            {state === 'live' && (
              <>
                <div className="absolute left-1 right-1 h-0.5 bg-gradient-to-r from-transparent via-blue to-transparent animate-[scanline_1.4s_ease-in-out_infinite]"></div>
                <style>{`
                  @keyframes scanline {
                    0%, 100% { top: 8%; opacity: 0.95; }
                    50% { top: 92%; opacity: 0.5; }
                  }
                `}</style>
              </>
            )}
          </div>

          <div className="absolute top-2 left-2 flex items-center gap-1.5 font-sans text-[10px] font-bold tracking-wider text-white">
            <span className={`inline-block w-2 h-2 ${state === 'live' ? 'bg-green animate-pulse' : state === 'error' ? 'bg-red' : 'bg-white/50'}`}></span>
            <span>{statusWord}</span>
            {engineKind && state === 'live' && (
              <span className="text-white/60">· {engineKind === 'native' ? 'HW' : 'JS'}</span>
            )}
          </div>
          <div className="absolute bottom-2 left-2 right-2 flex items-end justify-between gap-2 font-sans text-[11px] text-white/90">
            <span>{hint}</span>
            <span className="text-white/60 text-[10px] tracking-wider shrink-0">{label}</span>
          </div>
        </div>

        {(state === 'idle' || state === 'paused') && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink/95 pointer-events-auto">
            <div className="text-center px-4 max-w-xs">
              {state === 'paused' ? <Pause className="w-9 h-9 mx-auto mb-3 text-white/80" /> : <Camera className="w-9 h-9 mx-auto mb-3 text-white/80" />}
              <div className="font-sans text-[12px] font-bold tracking-wider text-white mb-1">
                {state === 'paused' ? 'CAMERA PAUSED' : 'CAMERA OFF'}
              </div>
              <div className="text-[11px] text-white/60 mb-4">
                {state === 'paused' ? 'Released while the app was in the background.' : 'The browser will ask for camera permission.'}
              </div>
              <button onClick={() => start()} className="btn btn-blue">
                <Play className="w-4 h-4" /> {state === 'paused' ? 'RESUME CAMERA' : 'START CAMERA'}
              </button>
            </div>
          </div>
        )}

        {state === 'starting' && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink/85 pointer-events-none">
            <div className="text-center px-4">
              <div className="font-sans text-[12px] font-bold tracking-wider text-white animate-pulse">REQUESTING CAMERA…</div>
              <div className="text-[11px] text-white/60 mt-1">Approve the permission prompt if asked</div>
            </div>
          </div>
        )}

        {state === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink/95 pointer-events-auto">
            <div className="text-center px-4 max-w-sm">
              <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-red" />
              <div className="font-sans text-[12px] font-bold tracking-wider text-red mb-1">CAMERA ERROR</div>
              <div className="text-[12px] text-white/85 mb-4 leading-snug">{errorMsg}</div>
              <button onClick={() => start()} className="btn btn-blue">
                <RotateCcw className="w-4 h-4" /> RETRY
              </button>
            </div>
          </div>
        )}

        {state === 'live' && (
          <div className="absolute top-1 right-1 flex gap-1 pointer-events-auto">
            {torchAvailable && (
              <button
                onClick={toggleTorch}
                className={`btn btn-sm ${torchOn ? 'btn-blue' : 'bg-ink/70 border-white/40 text-white hover:bg-ink hover:text-white'}`}
                aria-label="Toggle torch"
                aria-pressed={torchOn}
              >
                {torchOn ? <FlashlightOff className="w-4 h-4" /> : <Flashlight className="w-4 h-4" />}
              </button>
            )}
            <button
              onClick={stop}
              className="btn btn-sm bg-ink/70 border-white/40 text-white hover:bg-red hover:border-red hover:text-white"
              aria-label="Stop camera"
            >
              <Square className="w-3.5 h-3.5" fill="currentColor" /> STOP
            </button>
          </div>
        )}
      </div>

      {/* Field-debug strip — engine + any init/camera error. Kept quiet
          unless something is wrong; dock troubleshooting relies on it. */}
      {(state === 'live' || state === 'error' || state === 'starting') && (
        <div className={`px-3 py-1 text-[10px] font-mono tracking-wide flex flex-wrap gap-x-3 gap-y-0.5 border-t ${errorMsg || initError ? 'bg-red/10 text-red border-red/30' : 'bg-line text-muted border-ink/15'}`}>
          <span>engine {engineKind || (state === 'starting' ? 'init…' : '—')}</span>
          <span>{IS_ANDROID ? 'android' : IS_IOS ? 'ios' : 'desktop'}</span>
          <span>confirm ×{CONFIRM_COUNT}</span>
          {errorMsg && <span>cam: {errorMsg}</span>}
          {initError && <span>init: {initError}</span>}
        </div>
      )}
    </div>
  );
}

// ============================================================
// SORT VIEW — driver's morning workflow
// ============================================================
// One driver, one lane (the truck), multiple stops on the route. Parts come
// off the truck in mixed order; the driver scans every part one at a time
// and the system routes each one to the stop (body shop) that owns it.
//
// On every scan we get back a status:
//   MATCHED            - found a stop that wants this part, count++
//   DUPLICATE          - already filled that part's quota across the route
//   BACK_ORDER_ANOMALY - listed as back-ordered, shouldn't be in shipment
//   UNKNOWN            - not on any of today's invoices
//
// The view renders three things: live camera at the top (auto-starts on
// entry); a per-stop card list showing each shop's expected/scanned/missing
// counts; and an anomalies panel that aggregates UNKNOWN / BACK_ORDER /
// DUPLICATE scans so the driver can address them at the end of the sort.
// Stop key for grouping: prefers a manual override (set when the user merges
// stops) over the customer-derived default. This is the single source of truth
// for "which stop does this invoice belong to?"
//
// Format conventions for the key:
//   - Manual override:  whatever the user merged into (a normalized customer
//                       name, or a special "merge:<id>" tag for unidentified
//                       merges)
//   - Default:          uppercased + whitespace-collapsed customer name
//   - Unidentified:     "__inv_<invoiceNumber>__" so each unknown stays its
//                       own stop until the driver clears it up
function getStopKey(inv) {
  if (inv.stopId) return inv.stopId;
  const c = inv.customer || '';
  if (!c || /UNKNOWN\s*LANE/i.test(c)) {
    return `__inv_${inv.invoiceNumber || inv.id || ''}__`;
  }
  return c.trim().toUpperCase().replace(/\s+/g, ' ');
}

// Group invoices into stops. One physical delivery destination can carry
// multiple invoices (e.g. Mopar + Honda from different dealer divisions for
// the same body shop). When the customer name on those invoices doesn't
// match exactly — typo, abbreviation, ZIPed-vs-not — the driver can merge
// stops manually; that sets `stopId` on each invoice in the source stop to
// point at the target stop's key, and they re-group together here.
function groupInvoicesIntoStops(invoices) {
  const groups = new Map();
  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i];
    const key = getStopKey(inv);
    if (!groups.has(key)) {
      // Display name for the stop. When merged, prefer any non-unknown
      // customer name in the group; falls back to the placeholder if none
      // was successfully extracted.
      groups.set(key, { key, customer: null, invoices: [] });
    }
    const g = groups.get(key);
    g.invoices.push({ invoice: inv, idx: i });
    const c = inv.customer || '';
    if (!g.customer && c && !/UNKNOWN\s*LANE/i.test(c)) g.customer = c;
  }
  for (const g of groups.values()) {
    if (!g.customer) g.customer = '— UNKNOWN —';
  }
  return Array.from(groups.values()).map(stop => {
    const allLineItems = stop.invoices.flatMap(e => e.invoice.lineItems);
    const shipped = allLineItems.filter(li => li.shipped > 0);
    const expected = shipped.reduce((s, li) => s + li.unitsExpected, 0);
    // A line is "accounted for" by units scanned + units skipped — skipping
    // is the driver's explicit "this part won't make it today" sign-off and
    // counts toward stop completion the same as a scan does.
    // Clamp per-line accounting at unitsExpected so an over-incremented
    // line (e.g. from a stale scan-burst race) can't make the stop totals
    // exceed actual capacity.
    const got = shipped.reduce((s, li) => s + Math.min(li.unitsExpected, (li.unitsScanned || 0) + (li.unitsSkipped || 0)), 0);
    const scannedCount = shipped.reduce((s, li) => s + Math.min(li.unitsScanned || 0, li.unitsExpected), 0);
    const skippedCount = shipped.reduce((s, li) => s + Math.min(li.unitsSkipped || 0, li.unitsExpected), 0);
    const missing = shipped.filter(li => ((li.unitsScanned || 0) + (li.unitsSkipped || 0)) < li.unitsExpected);
    const backOrdered = allLineItems.filter(li => li.backOrdered > 0 && li.shipped === 0).length;
    // A stop counts as "merged" when any of its invoices carries an explicit
    // stopId override. Used to decide whether to show a SPLIT control.
    const isMerged = stop.invoices.some(e => !!e.invoice.stopId);
    return {
      ...stop,
      expected,
      got,
      scannedCount,
      skippedCount,
      complete: expected > 0 && got >= expected,
      missing,
      backOrdered,
      isMerged
    };
  });
}

function SortView({ invoices, scanLog, onScan, onConfirmBag, onConfirmNearMatch, onSkipRemaining, onSelectStop, onMergeStops, onSplitStop, stopOrder, onReorderStops, onPrintDayReport, onExportAnomalies, onBack }) {
  const [flashMessage, setFlashMessage] = useState(null);
  const [bagCount, setBagCount] = useState('');
  const [mergeFromKey, setMergeFromKey] = useState(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualValue, setManualValue] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const flashTimerRef = useRef(null);
  const beep = useBeep();

  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); }, []);

  // Flash dismissal. Single-unit matches auto-dismiss in 1.8s. Multi-unit
  // matches stay open until the driver explicitly confirms the count or
  // closes — they need time to count the bag and type the value.
  const showFlash = (code, status, lineRef, nearest) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashMessage({ code, status, lineRef, nearest, ts: Date.now() });
    const isMultiQty = lineRef && lineRef.unitsExpected > 1 && lineRef.unitsScanned < lineRef.unitsExpected;
    // Interactive flashes (bag-count entry, near-match confirm) stay open
    // until the driver acts; everything else auto-dismisses.
    if (isMultiQty) {
      // Pre-fill the bag-count input with the expected qty so the common
      // case (bag is exactly the ordered count) is a single Confirm tap.
      setBagCount(String(lineRef.unitsExpected));
      flashTimerRef.current = null;
    } else if (nearest) {
      setBagCount('');
      flashTimerRef.current = null;
    } else {
      setBagCount('');
      flashTimerRef.current = setTimeout(() => setFlashMessage(null), 1800);
    }
  };

  const dismissFlash = () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = null;
    setFlashMessage(null);
    setBagCount('');
  };

  const dispatchScan = useCallback((code, source) => {
    const result = onScan(code, source);
    // Keep a backwards-compat path in case onScan ever returns just a string
    const status = result && typeof result === 'object' ? result.status : result;
    const lineRef = result && typeof result === 'object' ? result.lineRef : null;
    const nearest = result && typeof result === 'object' ? result.nearest : null;
    const ok = status === 'MATCHED';
    beep(ok ? 880 : 400, ok ? 80 : 200);
    showFlash(code, status, lineRef, nearest);
    return status;
  }, [onScan, beep]);

  const handleDetect = useCallback((code) => {
    dispatchScan(code, 'sort');
  }, [dispatchScan]);

  const handleManualSubmit = () => {
    const v = manualValue.trim();
    if (!v) return;
    dispatchScan(v, 'manual');
    setManualValue('');
    setManualOpen(false);
  };

  const handleConfirmBag = () => {
    if (!flashMessage || !flashMessage.lineRef) return;
    const ref = flashMessage.lineRef;
    const parsed = parseInt(bagCount, 10);
    const target = Number.isFinite(parsed) ? parsed : ref.unitsExpected;
    onConfirmBag(ref.invIdx, ref.itemIdx, target);
    dismissFlash();
    beep(1100, 60); // higher chirp on confirm
  };

  const handleConfirmNearMatch = () => {
    if (!flashMessage || !flashMessage.nearest) return;
    const n = flashMessage.nearest;
    onConfirmNearMatch(n.invIdx, n.itemIdx, flashMessage.code);
    dismissFlash();
    beep(880, 80);
  };

  // Per-stop summary — one card per delivery destination, even when a
  // destination has multiple invoices (e.g. Mopar + Honda for the same shop).
  // Stops are reordered to follow the driver's chosen route (stopOrder) —
  // any keys we don't yet have an entry for appear at the end in their
  // insertion order. The sync effect at the App level keeps stopOrder
  // up-to-date with the current invoice set, so this filter is just a
  // belt-and-suspenders defense.
  const rawStops = groupInvoicesIntoStops(invoices);
  const stops = (() => {
    if (!stopOrder || stopOrder.length === 0) return rawStops;
    const byKey = new Map(rawStops.map(s => [s.key, s]));
    const ordered = [];
    for (const k of stopOrder) {
      if (byKey.has(k)) {
        ordered.push(byKey.get(k));
        byKey.delete(k);
      }
    }
    // Append any stops missing from stopOrder (race condition: new invoice
    // uploaded just before the sync effect ran).
    for (const s of byKey.values()) ordered.push(s);
    return ordered;
  })();

  // Drag-to-reorder state. draggedKey is the stop currently being dragged;
  // dragOverKey is the stop the pointer is hovering over. Visual feedback
  // is rendered against both so the driver sees what will happen on release.
  const [draggedKey, setDraggedKey] = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null);

  const totalExpected = stops.reduce((s, st) => s + st.expected, 0);
  const totalGot = stops.reduce((s, st) => s + st.got, 0);
  const stopsReady = stops.filter(st => st.complete).length;

  // When a stop has multiple invoices, tapping the card jumps to whichever
  // one is still incomplete — the driver's most likely target — falling
  // back to the first invoice if all are done.
  const handleSelectStop = (stop) => {
    const target = stop.invoices.find(e => {
      const shipped = e.invoice.lineItems.filter(li => li.shipped > 0);
      const exp = shipped.reduce((s, li) => s + li.unitsExpected, 0);
      const got = shipped.reduce((s, li) => s + Math.min(li.unitsExpected, (li.unitsScanned || 0) + (li.unitsSkipped || 0)), 0);
      return exp > 0 && got < exp;
    }) || stop.invoices[0];
    onSelectStop(target.idx);
  };
  const overallPct = totalExpected > 0 ? (totalGot / totalExpected) * 100 : 0;
  const allDone = totalExpected > 0 && totalGot >= totalExpected;

  // Anomalies — derived from the global scan log so we can show what showed
  // up in the truck that doesn't fit any of the loaded invoices, or that
  // was already accounted for.
  const anomalies = scanLog
    .filter(l => l.status === 'UNKNOWN' || l.status === 'BACK_ORDER_ANOMALY' || l.status === 'DUPLICATE')
    .slice(0, 30);

  // Which flash variant is showing. Interactive variants pause the scanner
  // so a part left in the box can't re-scan underneath the prompt and reset
  // the count the driver is typing.
  const flashRef = flashMessage ? flashMessage.lineRef : null;
  const flashNear = flashMessage ? flashMessage.nearest : null;
  const showBagConfirm = !!flashMessage && flashMessage.status === 'MATCHED' && !!flashRef &&
    flashRef.unitsExpected > 1 && flashRef.unitsScanned < flashRef.unitsExpected;
  const showNearMatch = !!flashMessage && !flashRef && !!flashNear &&
    (flashMessage.status === 'UNKNOWN' || flashMessage.status === 'BACK_ORDER_ANOMALY');
  const flashInteractive = showBagConfirm || showNearMatch;
  const scannerPaused = flashInteractive || manualOpen || reportOpen || !!mergeFromKey;

  if (invoices.length === 0) {
    return (
      <div className="panel border-ink p-8 text-center">
        <Package className="w-10 h-10 mx-auto mb-3 text-muted/70" />
        <div className="font-sans text-[14px] font-bold mb-1">NO STOPS LOADED</div>
        <div className="text-[12px] text-muted mb-4">
          Upload today's invoice PDFs on the dashboard to start sorting.
        </div>
        <button onClick={onBack} className="btn btn-dark">
          <ArrowLeft className="w-4 h-4" /> BACK TO DASHBOARD
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 lg:items-start">
      {/* On phones the two "columns" dissolve (display: contents) so the
          panels order themselves camera → route → scans → anomalies. On
          desktop they become real columns. */}
      <div className="contents lg:block lg:space-y-3">
      {/* CAMERA — first on every screen size */}
      <div className="panel border-ink order-1">
        <div className="panel-head">
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={onBack} className="btn btn-sm btn-ghost-dark btn-icon -ml-2" aria-label="Back to dashboard">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <div>SORT</div>
              <div className="text-[11px] font-mono font-normal text-paper/70 truncate">
                {totalGot}/{totalExpected} units · {stopsReady}/{stops.length} ready
              </div>
            </div>
          </div>
          <button onClick={() => setReportOpen(true)} className="btn btn-sm btn-blue shrink-0" title="Run a missing-parts report">
            <ClipboardList className="w-4 h-4" /> FINISH SORT
          </button>
        </div>

        <div className="relative">
          <BarcodeScanner onDetect={handleDetect} label="LANE SORT" autoStart paused={scannerPaused} />

          {/* Manual entry trigger — for unbarcoded parts (e.g. small fasteners
              in an envelope with the part number handwritten on it). Lives
              on the camera overlay so it's reachable without navigating away. */}
          <button
            onClick={() => setManualOpen(true)}
            className="btn btn-sm absolute top-1 left-1/2 -translate-x-1/2 bg-ink/70 border-white/40 text-white hover:bg-ink hover:text-white z-10"
            title="Type part number manually (no barcode)"
          >
            <Keyboard className="w-4 h-4" /> TYPE
          </button>

          {flashMessage && (
            <div className={`absolute inset-0 flex items-center justify-center p-3 ${flashInteractive ? 'pointer-events-auto' : 'pointer-events-none'} z-10 ${flashMessage.status === 'MATCHED' ? 'bg-green/70' : 'bg-red/70'}`}>
              <div className="bg-white border-2 border-ink px-4 py-3 text-center w-full max-w-[340px] relative">
                {flashInteractive && (
                  <button onClick={dismissFlash} className="btn btn-sm btn-ghost btn-icon absolute top-0.5 right-0.5" aria-label="Dismiss">
                    <X className="w-4 h-4" />
                  </button>
                )}
                <div className="flex items-center justify-center gap-2">
                  <StatusBadge status={flashMessage.status} large />
                </div>
                <div className="text-[13px] font-bold mt-2 break-all text-muted">{flashMessage.code}</div>
                {flashRef && (
                  <div className="mt-2">
                    <div className="label">Lane</div>
                    <div className="font-sans text-[20px] font-extrabold leading-tight break-words">{flashRef.customer}</div>
                    <div className="text-[12px] mt-1">
                      {flashRef.description && flashRef.description !== 'PART' && (
                        <span className="text-muted">{flashRef.description} · </span>
                      )}
                      <span className="font-bold">{flashRef.unitsScanned}/{flashRef.unitsExpected}</span>
                    </div>
                  </div>
                )}
                {!flashRef && flashMessage.status !== 'MATCHED' && !showNearMatch && (
                  <div className="text-[12px] text-muted mt-2">
                    {flashMessage.status === 'DUPLICATE' ? 'Already fully scanned for its stop.' :
                     flashMessage.status === 'BACK_ORDER_ANOMALY' ? 'Listed as back-ordered — should not be in this shipment.' :
                     'Not on any invoice loaded today.'}
                  </div>
                )}
                {showBagConfirm && (
                  <div className="mt-3 pt-3 border-t border-ink/20">
                    <div className="text-[12px] text-muted mb-2">Count the bag, confirm the received qty:</div>
                    <div className="flex items-center gap-2 mb-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={bagCount}
                        onChange={(e) => setBagCount(e.target.value.replace(/[^0-9]/g, ''))}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmBag(); }}
                        className="flex-1 border-2 border-ink bg-white px-3 py-2 text-[28px] font-extrabold font-mono text-center outline-none focus:border-green"
                        style={{ minWidth: 0 }}
                        aria-label="Received quantity"
                      />
                      <span className="text-[16px] text-muted font-mono">/ {flashRef.unitsExpected}</span>
                    </div>
                    <button
                      onClick={handleConfirmBag}
                      disabled={!bagCount || parseInt(bagCount, 10) <= flashRef.unitsScanned}
                      className="btn btn-green w-full"
                    >
                      <Check className="w-4 h-4" strokeWidth={3} /> CONFIRM {bagCount || '—'}
                    </button>
                  </div>
                )}
                {showNearMatch && (
                  <div className="mt-3 pt-3 border-t border-ink/20 text-left">
                    <div className="label text-center mb-1.5">Possible match on route</div>
                    <div className="text-[14px] font-bold break-all">{flashNear.partNumber}</div>
                    {flashNear.description && flashNear.description !== 'PART' && (
                      <div className="text-[12px] text-muted mt-0.5">{flashNear.description}</div>
                    )}
                    <div className="font-sans text-[15px] font-extrabold mt-1">
                      {flashNear.customer} <span className="font-mono text-[12px] font-bold">({flashNear.unitsScanned}/{flashNear.unitsExpected})</span>
                    </div>
                    <div className="text-[11px] text-muted mt-1.5 text-center">Verify against the part label before confirming.</div>
                    <button onClick={handleConfirmNearMatch} className="btn btn-blue w-full mt-2">
                      <Check className="w-4 h-4" strokeWidth={3} /> CHECK IN AS THIS
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {allDone && (
            <div className="absolute inset-0 flex items-center justify-center bg-green/90 pointer-events-none z-20">
              <div className="bg-white border-2 border-ink px-6 py-4 text-center">
                <Check className="w-10 h-10 mx-auto mb-2 text-green" strokeWidth={3} />
                <div className="font-sans text-[16px] font-extrabold tracking-wider">LANE SORTED</div>
                <div className="text-[12px] text-muted mt-1">All {stops.length} stop{stops.length === 1 ? '' : 's'} accounted for</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* RECENT SCANS */}
      <div className="panel order-3">
        <div className="panel-head">
          <span>RECENT SCANS</span>
          <span className="text-[11px] font-mono font-normal text-paper/70">last {Math.min(scanLog.length, 12)}</span>
        </div>
        <div className="max-h-72 overflow-y-auto">
          {scanLog.slice(0, 12).map((log, i) => (
            <div key={i} className="row px-3 py-1.5 text-[11px]">
              <div className="flex items-center gap-2">
                <span className="text-muted shrink-0 w-14">{log.ts}</span>
                <span className="font-bold truncate flex-1 text-[12px]">{log.partNumber}</span>
                <StatusBadge status={log.status} />
              </div>
              {log.note && (
                <div className="text-[11px] text-muted mt-0.5 ml-16 truncate">{log.note}</div>
              )}
            </div>
          ))}
          {scanLog.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-muted">Scan a part to begin</div>
          )}
        </div>
      </div>
      </div>

      <div className="contents lg:block lg:space-y-3">
      {/* ROUTE — second on phones (right after the camera), right column on desktop */}
      <div className="panel border-ink order-2">
        <div className="panel-head">
          <span>ROUTE <span className="text-paper/60 font-mono font-normal">{stops.length} stop{stops.length === 1 ? '' : 's'}</span></span>
          <span className="text-[11px] font-mono font-normal text-paper/70">{Math.round(overallPct)}% sorted</span>
        </div>
        <div className="h-1.5 bg-line relative overflow-hidden">
          <div className="h-full bg-green transition-all duration-300" style={{ width: `${overallPct}%` }}></div>
        </div>
        <div className="max-h-[60vh] lg:max-h-[70vh] overflow-y-auto">
          {stops.map((stop, idx) => {
            const invCount = stop.invoices.length;
            const invSummary = invCount === 1
              ? `INV ${stop.invoices[0].invoice.invoiceNumber}${stop.invoices[0].invoice.vendor ? ` · ${stop.invoices[0].invoice.vendor}` : ''}`
              : `${invCount} invoices · ${stop.invoices.map(e => e.invoice.invoiceNumber).slice(0, 3).join(', ')}${invCount > 3 ? ` +${invCount - 3}` : ''}`;
            const isDragged = draggedKey === stop.key;
            const isDropTarget = dragOverKey === stop.key && draggedKey && draggedKey !== stop.key;
            const pct = stop.expected > 0 ? (stop.got / stop.expected) * 100 : 0;
            return (
              <div
                key={stop.key}
                data-stop-key={stop.key}
                onClick={() => { if (!draggedKey) handleSelectStop(stop); }}
                className={`relative row transition-colors cursor-pointer
                  ${stop.complete ? 'bg-green/10' : ''}
                  ${isDragged ? 'opacity-40' : 'hover:bg-line/60'}
                  ${isDropTarget ? 'shadow-[inset_0_3px_0_0_#1a1a1a]' : ''}`}
              >
                <div className="flex items-stretch">
                  {/* Drag handle. touch-action:none keeps a vertical scroll
                      gesture from competing with the drag once the user
                      lands on the handle. Pointer events on the handle
                      get captured so we keep receiving move events even
                      if the pointer drifts outside its bounds. */}
                  <div
                    onPointerDown={(e) => {
                      e.preventDefault();
                      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
                      setDraggedKey(stop.key);
                      setDragOverKey(null);
                    }}
                    onPointerMove={(e) => {
                      if (!draggedKey) return;
                      const el = document.elementFromPoint(e.clientX, e.clientY);
                      const card = el && el.closest ? el.closest('[data-stop-key]') : null;
                      const key = card ? card.getAttribute('data-stop-key') : null;
                      if (key && key !== draggedKey) {
                        setDragOverKey(key);
                      } else if (!key) {
                        setDragOverKey(null);
                      }
                    }}
                    onPointerUp={() => {
                      if (draggedKey && dragOverKey && draggedKey !== dragOverKey) {
                        onReorderStops(draggedKey, dragOverKey);
                      }
                      setDraggedKey(null);
                      setDragOverKey(null);
                    }}
                    onPointerCancel={() => { setDraggedKey(null); setDragOverKey(null); }}
                    onClick={(e) => e.stopPropagation()}
                    className="flex flex-col items-center justify-center w-9 shrink-0 text-muted/60 hover:text-ink cursor-grab active:cursor-grabbing select-none border-r border-ink/10"
                    style={{ touchAction: 'none' }}
                    title="Drag to reorder"
                    aria-label="Drag to reorder"
                  >
                    <span className="font-sans text-[12px] font-bold text-ink">{idx + 1}</span>
                    <GripVertical className="w-4 h-4 mt-0.5" />
                  </div>

                  <div className="py-2.5 px-3 flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-sans text-[15px] font-extrabold leading-tight break-words">
                          {stop.customer}
                          {stop.isMerged && (
                            <span className="badge bg-blue text-white ml-1.5 align-middle">MERGED</span>
                          )}
                        </div>
                        <div className="text-[11px] text-muted mt-0.5 truncate">{invSummary}</div>
                      </div>
                      <div className="text-right shrink-0">
                        {stop.complete ? (
                          <div className="font-sans text-[12px] font-bold text-green tracking-wider flex items-center gap-1 justify-end">
                            <Check className="w-4 h-4" strokeWidth={3} /> READY
                          </div>
                        ) : stop.expected === 0 ? (
                          <div className="text-[11px] text-muted">no parts</div>
                        ) : (
                          <div className="text-[18px] font-bold leading-none">
                            {stop.got}<span className="text-muted text-[13px] font-normal">/{stop.expected}</span>
                          </div>
                        )}
                        {stop.backOrdered > 0 && (
                          <div className="text-[10px] text-red mt-1">{stop.backOrdered} B/O</div>
                        )}
                      </div>
                    </div>
                    {!stop.complete && stop.expected > 0 && (
                      <div className="h-1 bg-line mt-2 relative overflow-hidden">
                        <div className="h-full bg-blue transition-all duration-300" style={{ width: `${pct}%` }}></div>
                      </div>
                    )}
                    {!stop.complete && stop.missing.length > 0 && (
                      <div className="text-[11px] text-muted mt-1.5 truncate">
                        Missing: {stop.missing.slice(0, 3).map(m => m.partNumber).join(', ')}
                        {stop.missing.length > 3 && ` +${stop.missing.length - 3}`}
                      </div>
                    )}
                    {/* Stop-management controls. The wrapping div stops the
                        click from bubbling to the parent (which would otherwise
                        navigate to the stop's invoice). */}
                    {(stops.length > 1 || stop.isMerged) && (
                      <div className="flex gap-1 mt-1.5 -ml-2" onClick={(e) => e.stopPropagation()}>
                        {stops.length > 1 && (
                          <button onClick={() => setMergeFromKey(stop.key)} className="btn btn-sm btn-ghost text-[10px]">
                            <Merge className="w-3.5 h-3.5" /> MERGE INTO…
                          </button>
                        )}
                        {stop.isMerged && (
                          <button onClick={() => onSplitStop(stop.key)} className="btn btn-sm btn-ghost text-[10px] hover:text-red">
                            <Split className="w-3.5 h-3.5" /> SPLIT
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ANOMALIES */}
      {anomalies.length > 0 && (
        <div className="panel border-red/50 order-4">
          <div className="panel-head bg-red text-white">
            <span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> ANOMALIES <span className="font-mono font-normal text-white/80">{anomalies.length}</span></span>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {anomalies.map((log, i) => (
              <div key={i} className="row px-3 py-1.5 text-[11px]">
                <div className="flex items-center gap-2">
                  <span className="text-muted shrink-0 w-14">{log.ts}</span>
                  <span className="font-bold truncate flex-1 text-[12px]">{log.partNumber}</span>
                  <StatusBadge status={log.status} />
                </div>
                {log.note && (
                  <div className="text-[11px] text-muted mt-0.5 ml-16">{log.note}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      </div>

      {/* Merge target picker. Opened from a stop card's MERGE INTO control;
          tapping a target performs the merge and closes the modal. */}
      {mergeFromKey && (() => {
        const sourceStop = stops.find(s => s.key === mergeFromKey);
        const targets = stops.filter(s => s.key !== mergeFromKey);
        if (!sourceStop) return null;
        return (
          <div className="modal-backdrop" onClick={() => setMergeFromKey(null)}>
            <div className="modal max-w-md" onClick={(e) => e.stopPropagation()}>
              <div className="panel-head">
                <span>MERGE STOP INTO…</span>
                <button onClick={() => setMergeFromKey(null)} className="btn btn-sm btn-ghost-dark btn-icon" aria-label="Close">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="panel-sub">
                <div className="label">Source</div>
                <div className="font-sans text-[14px] font-extrabold text-ink mt-0.5">{sourceStop.customer}</div>
                <div className="mt-0.5">
                  {sourceStop.invoices.length} invoice{sourceStop.invoices.length === 1 ? '' : 's'} will move into the stop you pick.
                </div>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {targets.length === 0 && (
                  <div className="px-3 py-6 text-center text-[12px] text-muted">
                    Only one stop loaded — nothing to merge into.
                  </div>
                )}
                {targets.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => { onMergeStops(sourceStop.key, t.key); setMergeFromKey(null); }}
                    className="w-full text-left px-3 py-3 row hover:bg-green hover:text-white transition-colors group"
                  >
                    <div className="font-sans text-[14px] font-extrabold">{t.customer}</div>
                    <div className="text-[11px] text-muted group-hover:text-white/80 mt-0.5">
                      {t.invoices.length} invoice{t.invoices.length === 1 ? '' : 's'} · {t.invoices.map(e => e.invoice.invoiceNumber).slice(0, 3).join(', ')}
                      {t.invoices.length > 3 && ` +${t.invoices.length - 3}`}
                    </div>
                  </button>
                ))}
              </div>
              <div className="panel-sub border-t border-ink/20">
                A merged stop can be split again from its card.
              </div>
            </div>
          </div>
        );
      })()}

      {/* Manual entry modal — for parts that arrive without a scannable
          barcode (e.g. small fasteners in an envelope with the part number
          handwritten on it). Submitted value goes through the same scan
          pipeline as a camera read, just with source='manual'. */}
      {manualOpen && (
        <div className="modal-backdrop" onClick={() => setManualOpen(false)}>
          <div className="modal max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="panel-head">
              <span>TYPE PART NUMBER</span>
              <button onClick={() => setManualOpen(false)} className="btn btn-sm btn-ghost-dark btn-icon" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3">
              <div className="text-[12px] text-muted mb-2">
                For parts without a scannable barcode. Enter the number as printed — case and dashes are normalized.
              </div>
              <input
                value={manualValue}
                onChange={(e) => setManualValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleManualSubmit(); }}
                placeholder="e.g. 6510359AA"
                autoFocus
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className="field w-full text-[18px]"
              />
              <div className="flex gap-2 mt-3 justify-end">
                <button onClick={() => { setManualValue(''); setManualOpen(false); }} className="btn">CANCEL</button>
                <button onClick={handleManualSubmit} disabled={!manualValue.trim()} className="btn btn-dark">SUBMIT</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sort report — opens on FINISH SORT. Lists every line item across
          every stop where unitsScanned + unitsSkipped < unitsExpected, grouped
          by stop. Each row has a SKIP action that marks the remaining units
          as "won't make it today" — that promotes the stop toward READY
          without requiring a physical scan. Driver can also dismiss and go
          back to scanning. When nothing's missing the modal flips to a
          "Lane is ready to load" confirmation. */}
      {reportOpen && (() => {
        const missingByStop = stops.map(stop => {
          const items = [];
          for (const { invoice, idx: invIdx } of stop.invoices) {
            for (let itemIdx = 0; itemIdx < invoice.lineItems.length; itemIdx++) {
              const li = invoice.lineItems[itemIdx];
              if (!(li.shipped > 0)) continue;
              const accounted = (li.unitsScanned || 0) + (li.unitsSkipped || 0);
              if (accounted >= li.unitsExpected) continue;
              items.push({
                invIdx,
                itemIdx,
                invoiceNumber: invoice.invoiceNumber,
                partNumber: li.partNumber,
                description: li.description,
                expected: li.unitsExpected,
                scanned: li.unitsScanned || 0,
                skipped: li.unitsSkipped || 0,
                remaining: li.unitsExpected - accounted
              });
            }
          }
          return { customer: stop.customer, stopKey: stop.key, items };
        }).filter(s => s.items.length > 0);
        const allAccounted = missingByStop.length === 0;
        return (
          <div className="modal-backdrop" onClick={() => setReportOpen(false)}>
            <div className="modal max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className={`panel-head ${allAccounted ? 'bg-green text-white' : ''}`}>
                <span>SORT REPORT <span className="font-mono font-normal opacity-80">{totalGot}/{totalExpected} units</span></span>
                <button onClick={() => setReportOpen(false)} className="btn btn-sm btn-ghost-dark btn-icon" aria-label="Close">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="overflow-y-auto flex-1">
                {allAccounted ? (
                  <div className="p-8 text-center">
                    <Check className="w-12 h-12 mx-auto mb-3 text-green" strokeWidth={3} />
                    <div className="font-sans text-[16px] font-extrabold tracking-wider mb-1">LANE READY TO LOAD</div>
                    <div className="text-[12px] text-muted">Every unit on every stop is either scanned or marked not coming.</div>
                  </div>
                ) : (
                  <>
                    <div className="panel-sub border-b border-ink/20">
                      {missingByStop.reduce((s, st) => s + st.items.length, 0)} line(s) missing across {missingByStop.length} stop(s). Skip a line to mark it as not coming today.
                    </div>
                    {missingByStop.map(stop => (
                      <div key={stop.stopKey} className="border-b border-ink/20">
                        <div className="px-3 py-2 bg-line/50">
                          <div className="font-sans text-[14px] font-extrabold">{stop.customer}</div>
                          <div className="text-[11px] text-muted mt-0.5">{stop.items.length} line(s) outstanding</div>
                        </div>
                        {stop.items.map(m => (
                          <div key={`${m.invIdx}-${m.itemIdx}`} className="px-3 py-2 border-t border-ink/10 flex items-center gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="text-[13px] font-bold truncate">{m.partNumber}</div>
                              <div className="text-[11px] text-muted truncate">
                                {m.description !== 'PART' ? `${m.description} · ` : ''}INV {m.invoiceNumber}
                              </div>
                              <div className="text-[12px] mt-1">
                                <span className="font-bold">{m.scanned}/{m.expected}</span>
                                {m.skipped > 0 && <span className="text-muted"> · {m.skipped} skipped</span>}
                                <span className="text-muted ml-1">— need {m.remaining} more</span>
                              </div>
                            </div>
                            <button onClick={() => onSkipRemaining(m.invIdx, m.itemIdx)} className="btn btn-sm shrink-0" title="Mark the remaining units as not coming today">
                              SKIP {m.remaining}
                            </button>
                          </div>
                        ))}
                      </div>
                    ))}
                  </>
                )}
              </div>
              <div className="px-3 py-2 border-t border-ink/20 bg-line flex justify-between items-center flex-wrap gap-2">
                <button onClick={() => setReportOpen(false)} className="btn btn-sm">
                  <ArrowLeft className="w-4 h-4" /> BACK TO SCAN
                </button>
                <div className="flex gap-1.5 flex-wrap">
                  <button onClick={onPrintDayReport} className="btn btn-sm" title="Print ready stops + anomalies">
                    <Printer className="w-4 h-4" /> DAY REPORT
                  </button>
                  <button onClick={onExportAnomalies} className="btn btn-sm" title="Download anomaly CSV">
                    <FileDown className="w-4 h-4" /> CSV
                  </button>
                  {allAccounted && (
                    <button onClick={() => { setReportOpen(false); onBack(); }} className="btn btn-sm btn-green">
                      <Check className="w-4 h-4" strokeWidth={3} /> DONE
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ============================================================
// SCAN VIEW
// ============================================================
function ScanView({ invoice, scanLog, onScan, onBack }) {
  const [flashMessage, setFlashMessage] = useState(null);
  const flashTimerRef = useRef(null);
  const beep = useBeep();

  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); }, []);

  const showFlash = (code, status) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashMessage({ code, status, ts: Date.now() });
    flashTimerRef.current = setTimeout(() => setFlashMessage(null), 1500);
  };

  const handleDetect = useCallback((code) => {
    const status = onScan(code, 'camera');
    beep(status === 'MATCHED' ? 880 : 400, status === 'MATCHED' ? 80 : 200);
    showFlash(code, status);
  }, [onScan, beep]);

  const shipped = invoice.lineItems.filter(li => li.shipped > 0);
  const totalUnits = shipped.reduce((s, li) => s + li.unitsExpected, 0);
  const scannedUnits = shipped.reduce((s, li) => s + Math.min(li.unitsScanned || 0, li.unitsExpected), 0);
  const pct = totalUnits > 0 ? (scannedUnits / totalUnits) * 100 : 0;
  const awaiting = invoice.lineItems.filter(li => li.shipped > 0 && ((li.unitsScanned || 0) + (li.unitsSkipped || 0)) < li.unitsExpected);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 lg:items-start">
      <div className="panel border-ink">
        <div className="panel-head">
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={onBack} className="btn btn-sm btn-ghost-dark btn-icon -ml-2" aria-label="Back to invoice">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <div className="truncate">{invoice.customer || 'SCAN'}</div>
              <div className="text-[11px] font-mono font-normal text-paper/70">INV {invoice.invoiceNumber} · {scannedUnits}/{totalUnits} units</div>
            </div>
          </div>
        </div>

        <div className="relative">
          <BarcodeScanner onDetect={handleDetect} label="PART BARCODE" autoStart />

          {flashMessage && (
            <div className={`absolute inset-0 flex items-center justify-center p-3 pointer-events-none z-10 ${flashMessage.status === 'MATCHED' ? 'bg-green/70' : 'bg-red/70'}`}>
              <div className="bg-white border-2 border-ink px-4 py-3 text-center max-w-[340px]">
                <StatusBadge status={flashMessage.status} large />
                <div className="text-[13px] font-bold mt-2 break-all text-muted">{flashMessage.code}</div>
              </div>
            </div>
          )}
        </div>

        <div className="p-3 border-t border-ink/20">
          <div className="flex items-baseline justify-between mb-2">
            <div>
              <span className="font-sans text-3xl font-extrabold leading-none">{scannedUnits}</span>
              <span className="text-lg text-muted">/{totalUnits}</span>
              <span className="label ml-2">units</span>
            </div>
            <div className="label">{Math.round(pct)}% verified</div>
          </div>
          <div className="h-2 bg-line relative overflow-hidden">
            <div className="h-full bg-green transition-all duration-300" style={{ width: `${pct}%` }}></div>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="panel">
          <div className="panel-head">
            <span>AWAITING SCAN <span className="text-paper/60 font-mono font-normal">{awaiting.length}</span></span>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {awaiting.map((item, i) => (
              <div key={i} className="row px-3 py-2 text-[12px] flex items-center gap-3">
                <div className="w-4 h-4 border border-ink/40 shrink-0"></div>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-[13px]">{item.partNumber}</div>
                  <div className="text-[11px] text-muted truncate">{item.description}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-bold">{(item.unitsScanned || 0)}<span className="text-muted font-normal">/{item.unitsExpected}</span></div>
                  <div className="text-[10px] text-muted">${item.amount.toFixed(2)}</div>
                </div>
              </div>
            ))}
            {awaiting.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px]">
                <Check className="w-6 h-6 mx-auto mb-1 text-green" strokeWidth={3} />
                <div className="font-sans font-bold">ALL UNITS VERIFIED</div>
                <div className="text-[11px] text-muted mt-1">Invoice ready for sign-off</div>
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span>SCAN LOG</span>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {scanLog.slice(0, 12).map((log, i) => (
              <div key={i} className="row px-3 py-1.5 text-[11px] flex items-center gap-2">
                <span className="text-muted shrink-0 w-14">{log.ts}</span>
                <span className="font-bold truncate flex-1 text-[12px]">{log.partNumber}</span>
                <StatusBadge status={log.status} />
              </div>
            ))}
            {scanLog.length === 0 && (
              <div className="px-3 py-4 text-[12px] text-muted text-center">No scans yet on this invoice</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// SHARED
// ============================================================

// Short confirmation / rejection tones. One AudioContext per mounted view,
// closed on unmount — iOS caps the number of live contexts, and creating a
// fresh one on every Sort entry without closing it eventually silences the
// app. The context is created/resumed on the first user gesture because
// iOS Safari refuses to start one from a non-gesture callback (a camera
// decode is not a gesture).
function useBeep() {
  const ctxRef = useRef(null);
  useEffect(() => {
    const unlock = () => {
      try {
        if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
        if (ctxRef.current.state === 'suspended') ctxRef.current.resume().catch(() => {});
      } catch (e) { /* no audio */ }
    };
    document.addEventListener('pointerdown', unlock, { passive: true });
    document.addEventListener('keydown', unlock);
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx) { try { ctx.close(); } catch (e) { /* already closed */ } }
    };
  }, []);

  return useCallback((frequency = 800, duration = 100) => {
    try {
      if (!ctxRef.current) {
        ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = ctxRef.current;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration / 1000);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration / 1000);
    } catch (e) { /* silent */ }
  }, []);
}

function ConfirmDialog({ title, body, confirmLabel, onCancel, onConfirm }) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head bg-red text-white">
          <span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> {title}</span>
        </div>
        <div className="p-4">
          <div className="text-[13px] mb-4 leading-snug">{body}</div>
          <div className="flex gap-2 justify-end">
            <button onClick={onCancel} className="btn">CANCEL</button>
            <button onClick={onConfirm} className="btn btn-red">{confirmLabel}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ManualInvoiceLookup({ onSubmit }) {
  const [val, setVal] = useState('');
  return (
    <div className="flex gap-1.5">
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && val.trim()) { onSubmit(val); setVal(''); } }}
        placeholder="Invoice number"
        inputMode="text"
        autoCapitalize="characters"
        autoCorrect="off"
        className="field flex-1 min-w-0"
      />
      <button onClick={() => { if (val.trim()) { onSubmit(val); setVal(''); } }} className="btn btn-dark">
        LOOK UP
      </button>
    </div>
  );
}

function StatBox({ label, value, sub, accent }) {
  return (
    <div className="bg-white p-3">
      <div className="label mb-1">{label}</div>
      <div className="font-sans text-2xl md:text-3xl font-extrabold leading-none" style={{ color: accent || undefined }}>{value}</div>
      <div className="text-[11px] text-muted mt-1.5">{sub}</div>
    </div>
  );
}

function InfoCell({ label, value, sub, mono }) {
  return (
    <div className="bg-white px-3 py-2">
      <div className="label">{label}</div>
      <div className={`text-[13px] font-bold mt-0.5 truncate ${mono ? '' : 'font-sans'}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

function StatusBadge({ status, large = false }) {
  const config = {
    MATCHED: { cls: 'bg-green text-white', label: 'MATCH' },
    WRONG_LANE: { cls: 'bg-red text-white', label: 'WRONG STOP' },
    DUPLICATE: { cls: 'bg-blue text-white', label: 'DUPLICATE' },
    BACK_ORDER_ANOMALY: { cls: 'bg-red text-white', label: 'B/O ANOMALY' },
    SKIPPED: { cls: 'bg-ink text-paper', label: 'SKIPPED' },
    UNKNOWN: { cls: 'bg-ink text-paper', label: 'UNKNOWN' }
  };
  const c = config[status] || config.UNKNOWN;
  return (
    <span className={`badge ${c.cls} ${large ? 'text-[14px] px-3 py-1' : ''}`}>
      {c.label}
    </span>
  );
}

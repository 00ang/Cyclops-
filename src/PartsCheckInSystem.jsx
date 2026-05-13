import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, Camera, X, Check, AlertTriangle, FileText, Package, Truck, ChevronRight, Search, Trash2, Download, RefreshCw, Eye, EyeOff, Zap, FileSearch } from 'lucide-react';

// ============================================================
// PARTS CHECK-IN SYSTEM v2.0
// PDF ingestion + barcode scanning + persistence
// ============================================================

const STORAGE_KEYS = {
  INVOICES: 'invoices:list',
  SCAN_LOG: 'scans:log',
  STOP_ORDER: 'stops:order'
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
  } catch (e) {
    console.error('Storage save failed:', e);
  }
}

// ---------- PDF.js loader ----------
let pdfjsLoadPromise = null;
function loadPdfJs() {
  if (pdfjsLoadPromise) return pdfjsLoadPromise;
  pdfjsLoadPromise = new Promise((resolve, reject) => {
    if (window.pdfjsLib) return resolve(window.pdfjsLib);
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return pdfjsLoadPromise;
}

// ---------- ZXing loader ----------
// Different builds expose different globals. Try multiple sources and resolve
// to whichever object actually contains BrowserMultiFormatReader.
let zxingLoadPromise = null;
function findZXingNamespace() {
  const candidates = [
    window.ZXing,
    window.ZXingBrowser,
    window.ZXingJs,
    window.zxing
  ].filter(Boolean);
  for (const ns of candidates) {
    if (ns && (ns.BrowserMultiFormatReader || ns.default?.BrowserMultiFormatReader)) {
      return ns.BrowserMultiFormatReader ? ns : ns.default;
    }
  }
  return null;
}

function loadZXing() {
  if (zxingLoadPromise) return zxingLoadPromise;
  zxingLoadPromise = new Promise((resolve, reject) => {
    const existing = findZXingNamespace();
    if (existing) return resolve(existing);

    // Try sources in order; first one that loads + exposes the API wins.
    const sources = [
      'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js',
      'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/zxing-js/0.21.3/index.min.js'
    ];

    let attempt = 0;
    const tryNext = () => {
      if (attempt >= sources.length) {
        return reject(new Error('Failed to load ZXing barcode library from all CDN sources'));
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

function detectRouteReport(text) {
  // Header signature — all five expected column titles must be present.
  return /\bAccount\s+Name\b/i.test(text)
    && /\bInvoice\s*#/i.test(text)
    && /\bPart\s+Count\b/i.test(text)
    && /\bPart\s*#/i.test(text);
}

// Parse one row by validating the column sequence after the customer name.
// Two report shapes are supported on the same parser:
//   5-column legacy:  Account · Invoice · PartCount · Price · Part#
//   7-column current: Account · Invoice · PartCount · Price · Part# · Description · Qty
// We walk left-to-right looking for the invoice token (validated by the two
// columns that must follow it — PartCount and Price). The customer name is
// everything before that. Price accepts thousand-separator commas like
// 1,315.82. Qty + Description are taken when an integer is found at the end
// of the row and there's at least one Part# token before it; otherwise we
// fall back to the legacy assumption (qty 1, no description).
function parseRouteReportRow(text) {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < 5) return null;

  let invIdx = -1;
  for (let i = 1; i < tokens.length - 3; i++) {
    const okInv   = /^\d{5,8}(?:[A-Z]\d{1,2})?$/i.test(tokens[i]);
    const okCnt   = /^\d{1,3}$/.test(tokens[i + 1]);
    const okPrice = /^\d{1,3}(?:,\d{3})*\.\d{2}$/.test(tokens[i + 2]);
    if (okInv && okCnt && okPrice) { invIdx = i; break; }
  }
  if (invIdx === -1) return null;

  const cntIdx = invIdx + 1;
  const priceIdx = invIdx + 2;
  const partIdx = invIdx + 3;
  if (partIdx >= tokens.length || tokens[partIdx].length < 4) return null;
  if (!/[A-Z0-9]/i.test(tokens[partIdx])) return null;

  // New-format detection: the last token is an integer (Qty), and there's
  // at least one description token between Part# and Qty (or Qty is right
  // after Part# with an empty description — unusual but allowed).
  const lastIdx = tokens.length - 1;
  const lastIsQty = lastIdx > partIdx && /^\d{1,4}$/.test(tokens[lastIdx]);
  let qty = 1;
  let description = 'PART';
  if (lastIsQty) {
    qty = parseInt(tokens[lastIdx], 10);
    if (lastIdx > partIdx + 1) {
      description = tokens.slice(partIdx + 1, lastIdx).join(' ').trim() || 'PART';
    }
  }

  const customer = tokens.slice(0, invIdx).join(' ').trim();
  if (customer.length < 3) return null;

  return {
    customer,
    invoiceNumber: tokens[invIdx].toUpperCase(),
    partCount: parseInt(tokens[cntIdx], 10),
    invoiceTotal: parseFloat(tokens[priceIdx].replace(/,/g, '')),
    partNumber: tokens[partIdx],
    description,
    qty
  };
}

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

// Detect which Zeigler store an invoice block belongs to.
// Returns: 'orland_park' | 'kalamazoo' | 'grandville' | 'unknown'
//
// Only checks the header area (top 12 lines). Van Eck's customer address
// also contains "GRANDVILLE", so a whole-document scan would falsely
// identify every invoice as Grandville, which then forces the wrong
// invoice-number priority and template defaults.
function detectStore(text) {
  const headerArea = text.split('\n').slice(0, 12).join(' ');
  if (/ORLAND\s+PARK/i.test(headerArea) || /ZEIGLER\s+NISSAN/i.test(headerArea)) return 'orland_park';
  if (/KALAMAZOO/i.test(headerArea)) return 'kalamazoo';
  if (/GRANDVILLE/i.test(headerArea) && /ZEIGLER|AUTO\s+GROUP/i.test(headerArea)) return 'grandville';
  return 'unknown';
}

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

// Detect document format. Two distinct layouts exist:
//   - 'cdk_screen': CDK on-screen "CLOSED INVOICE" / "OPEN INVOICE" capture.
//                   Box-drawing characters, "Number:" label, OH/QS/BIN columns,
//                   Ford parts written with "*" as the segment separator.
//   - 'standard':   Printed dealer invoice (the Zeigler form factor).
function detectFormat(text) {
  if (/\b(?:CLOSED|OPEN)\s+INVOICE\b/i.test(text)) return 'cdk_screen';
  if (/(?:^|\n)\s*Number\s*:\s*\d{6,7}/i.test(text)) return 'cdk_screen';
  if (/PART-NO\.?\s*[─\-]+\s*DESC/i.test(text)) return 'cdk_screen';
  return 'standard';
}

// Per-store templates. Each entry tells the parser:
//   - which invoice-number patterns to try (in priority order)
//   - which part-number patterns to try (in priority order)
//   - the canonical vendor / location strings
const STORE_TEMPLATES = {
  orland_park: {
    vendor: 'ZEIGLER NISSAN ORLAND PARK',
    location: 'ORLAND PARK, IL',
    // Orland Park observed forms: 334102X1 (suffix variant), plain 6-7 digits.
    invoiceNumberPatterns: [
      /\b(\d{6,7}[A-Z]\d{1,2})\b/,
      /\b(\d{6,7})\b/
    ],
    partPatterns: ['nissan', 'mopar', 'honda', 'ford', 'ford_compact', 'mercedes']
  },
  kalamazoo: {
    vendor: 'ZEIGLER AUTO GROUP',
    location: 'KALAMAZOO, MI',
    // Kalamazoo observed forms: plain 6-7 digit (e.g. 333572, 1044675).
    // The store is multi-make — sells Honda, CDJR, AND Ford parts (Ford parts
    // use the FL3Z*1629076*AD asterisk-separated format).
    invoiceNumberPatterns: [
      /\b(\d{6,7})\b/,
      /\b(\d{6,7}[A-Z]\d{1,2})\b/
    ],
    partPatterns: ['honda', 'ford', 'mopar', 'nissan', 'ford_compact', 'mercedes']
  },
  grandville: {
    vendor: 'ZEIGLER AUTO GROUP',
    location: 'GRANDVILLE, MI',
    // Grandville observed forms: 1059569 (plain 7-digit).
    invoiceNumberPatterns: [
      /\b(\d{6,7})\b/,
      /\b(\d{6,7}[A-Z]\d{1,2})\b/
    ],
    // Grandville store may carry mixed inventory — try all patterns.
    partPatterns: ['mopar', 'honda', 'nissan', 'ford', 'ford_compact', 'mercedes']
  },
  unknown: {
    vendor: 'ZEIGLER AUTO GROUP',
    location: '',
    invoiceNumberPatterns: [
      /\b(\d{6,7}[A-Z]\d{1,2})\b/,
      /\b(\d{6,7})\b/
    ],
    partPatterns: ['mopar', 'honda', 'nissan', 'ford', 'ford_compact', 'mercedes']
  },
  // CDK on-screen capture for any Ford parts dealer (no Zeigler markers).
  // Used when format=cdk_screen and no Zeigler store could be identified.
  ford_cdk: {
    vendor: 'FORD PARTS DEALER',
    location: '',
    invoiceNumberPatterns: [
      /\b(\d{6,7})\b/,
      /\b(\d{6,7}[A-Z]\d{1,2})\b/
    ],
    partPatterns: ['ford', 'ford_compact', 'mopar', 'honda', 'nissan', 'mercedes']
  }
};

// Part number regex registry, keyed by vendor.
// Honda is a subset of the looser Ford pattern, so order matters at the call site.
const PART_NUMBER_REGEX = {
  // Mopar / CDJR: 7-8 digits + 2 letters. The standard form is 8d+2L
  // (e.g. 68472201AB), but older parts — clips, pins, fasteners, "small parts"
  // — use a 7-digit base (e.g. 6510359AA, 5191234AB). Both end in a 2-letter
  // revision code (AA, AB, AC, …).
  mopar: /\b\d{7,8}[A-Z]{2}\b/,
  // Honda: 5 digits - 3 alphanumeric - 3 alphanumeric, optional ZZ suffix
  // (e.g. 91570-TVA-A01, 04646-TVA-A01ZZ)
  honda: /\b\d{5}-[A-Z0-9]{3}-[A-Z0-9]{3}(?:ZZ)?\b/,
  // Nissan: 5 digits - 5 alphanumeric (e.g. 62022-5ZW0H)
  nissan: /\b\d{5}-[A-Z0-9]{5}\b/,
  // Ford: 2-4 alphanumeric - 4-8 alphanumeric - 1-3 alphanumeric, separator
  // can be either "-" (printed invoice) or "*" (CDK on-screen "CLOSED INVOICE"
  // capture, where * is the field separator)
  // (e.g. FL3Z-1015A00-A, FL3Z*1629076*AD, 7E5Z-9F593-A)
  ford: /\b[A-Z0-9]{2,4}[*-][A-Z0-9]{4,8}[*-][A-Z0-9]{1,3}\b/,
  // Ford with separators stripped: some CDK/dealer formats print Ford parts
  // as one concatenated 10-12 char alphanumeric token, no dashes or asterisks
  // (e.g. 7LY52LAUAA from "7LY5-2LAUA-A", FL3Z1015A00A from "FL3Z-1015A00-A").
  // Constrained so it can't false-match invoice numbers, account numbers,
  // VINs, dates, prices, or other vendors' compact forms:
  //   - exactly 10-12 chars, all [A-Z0-9]
  //   - at least one letter within the first 4 chars (rules out anything
  //     that starts with a long digit run — Mopar, Honda/Nissan compact
  //     forms, invoice/account numbers)
  //   - at least 2 letters AND 2 digits total (rules out pure-letter and
  //     near-pure-digit strings)
  //   - \b at both ends (rules out being part of a longer token like a VIN)
  ford_compact: /\b(?=[A-Z0-9]{0,3}[A-Z])(?=(?:[A-Z0-9]*[A-Z]){2})(?=(?:[A-Z0-9]*[0-9]){2})[A-Z0-9]{10,12}\b/,
  // Mercedes-Benz: letter prefix (A/B/N/Q) + 10 digits, optional spaces between groups
  // (e.g. A 251 880 00 41, A2518800041)
  mercedes: /\b[ABNQ]\s?\d{3}\s?\d{3}\s?\d{2}\s?\d{2}\b/
};

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

function parseLineItems(lines, template = STORE_TEMPLATES.unknown) {
  const items = [];
  // Try each vendor pattern in template-defined priority order. First hit wins.
  // Honda must come before Ford because Honda part numbers (5-3-3) are a subset
  // of the looser Ford pattern (2-4 / 4-8 / 1-3).
  const orderedRegexes = template.partPatterns.map(v => PART_NUMBER_REGEX[v]).filter(Boolean);

  const findPartNumber = (text) => {
    for (const re of orderedRegexes) {
      const m = text.match(re);
      if (m) return m[0];
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
    const partNumber = findPartNumber(text);
    if (!partNumber) continue;
    if (/following\s+parts/i.test(text)) continue;

    // Quantity columns. Tiered fallback so a part can't silently vanish from
    // the sort view when the print layout is unfamiliar — the SortView filters
    // by `shipped > 0`, so a part whose qty couldn't be parsed (defaulting to
    // 0/0/0 previously) would never appear. The last resort assumes
    // shipped=ordered=1 since the part's name is printed on the invoice.
    let ordered = 0, shipped = 0, backOrdered = 0;
    let qtyParseQuality = 'none';
    const qtyMatch3 = text.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s/);
    if (qtyMatch3) {
      // Standard "ORD SHIP B.O." columns at line start (Zeigler layout)
      ordered = parseInt(qtyMatch3[1]);
      shipped = parseInt(qtyMatch3[2]);
      backOrdered = parseInt(qtyMatch3[3]);
      qtyParseQuality = 'exact';
    } else {
      const qtyMatch2 = text.match(/^\s*(\d+)\s+(\d+)\s/);
      if (qtyMatch2) {
        // Two-column form (ORD SHIP, no B.O.) — derive B.O. from the diff
        ordered = parseInt(qtyMatch2[1]);
        shipped = parseInt(qtyMatch2[2]);
        backOrdered = Math.max(0, ordered - shipped);
        qtyParseQuality = 'derived';
      } else {
        const numericItems = line.items.filter(it => /^\d+$/.test(it.str.trim()));
        if (numericItems.length >= 3) {
          // Position-based fallback (qty columns somewhere on the line, not
          // necessarily at the start) — sort by x and take the first three
          const sorted = numericItems.sort((a, b) => a.x - b.x).slice(0, 3);
          ordered = parseInt(sorted[0].str);
          shipped = parseInt(sorted[1].str);
          backOrdered = parseInt(sorted[2].str);
          qtyParseQuality = 'positional';
        } else {
          // Last resort: the part is printed on the invoice with no parseable
          // qty columns. Assume one unit shipped so the driver sees it in the
          // sort view; tag the line for the UI to surface that the qty wasn't
          // confidently parsed.
          ordered = 1;
          shipped = 1;
          backOrdered = 0;
          qtyParseQuality = 'assumed';
        }
      }
    }

    const afterPart = text.substring(text.indexOf(partNumber) + partNumber.length).trim();
    // Description = the alpha run between the part number and the price block.
    // Different printed formats insert 0, 1, or 2 columns between the
    // description and the LIST price:
    //   Zeigler standard:  no extra columns       — "FASCIA-FOG 24.55 …"
    //   Riverbend / Ford:  PAC integer            — "MIRROR-OUT 1 285.00 …"
    //   Gerber Mopar:      PAC integer + BIN code — "PUSH PIN-P 30 1205D10 3.65 …"
    //
    // The optional (?:\s+\d+) absorbs the PAC integer column. The optional
    // (?:\s+\S*\d\S*) absorbs the BIN code; it requires at least one digit so
    // it can't accidentally eat alphabetic description tokens (e.g. the "FR-"
    // in "CLIP, FR-" stays in the description because it has no digit).
    const descMatch = afterPart.match(/^([A-Z][A-Z0-9\s,\-/]{1,40}?)(?:\s+\d+)?(?:\s+\S*\d\S*)?\s+\d+\.\d{2}/);
    let description = descMatch ? descMatch[1].trim() : afterPart.slice(0, 30).trim();

    const prices = (afterPart.match(/\d+\.\d{2}/g) || []).map(parseFloat);
    let listPrice = prices[0] || 0;
    let netPrice = prices[1] || 0;
    let amount = prices[2] !== undefined ? prices[2] : (shipped > 0 ? netPrice * shipped : 0);

    if (shipped === 0 && backOrdered > 0) amount = 0;

    let note = null;
    if (shipped === 0 && backOrdered > 0) note = 'BACK-ORDERED — should not be in lane';
    else if (shipped > 0 && backOrdered > 0) note = `PARTIAL: ${shipped} of ${ordered} shipped`;

    // When qty was assumed (line printed without parseable qty columns), tag
    // the note so the driver can see it's an inferred 1.
    let finalNote = note;
    if (qtyParseQuality === 'assumed' && !finalNote) {
      finalNote = 'Qty inferred (1) — invoice did not have parseable qty columns';
    }

    items.push({
      partNumber,
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
      note: finalNote,
      qtyParseQuality,
      unitsExpected: shipped,
      unitsScanned: 0
    });
  }

  return items;
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
    const normalizedPart = partNumber.replace(/\*/g, '-');

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
// SAMPLE DATA
// ============================================================
const SAMPLE_INVOICES = [
  {
    id: 'sample_1059569',
    invoiceNumber: '1059569',
    accountNumber: '5321626',
    vendor: 'ZEIGLER AUTO GROUP',
    location: 'GRANDVILLE, MI',
    customer: 'VAN ECK AUTO BODY',
    customerAddress: '4520 CHICAGO DR, GRANDVILLE, MI',
    dateShipped: '30 APR 26',
    shipVia: '5/1 RAINBOW',
    salesman: '2694',
    yourOrderNo: '15257',
    vin: null,
    vehicle: 'GM 1033 / HP 1046 / VJH 4/30',
    terms: 'WHOLESALE',
    total: 349.80,
    createdAt: Date.now() - 3600000,
    lineItems: [
      { partNumber: '68472201AB', description: 'FASCIA-FOG', ordered: 1, shipped: 1, backOrdered: 0, listPrice: 24.55, netPrice: 16.20, amount: 16.20, checked: false, scanStatus: null, checkedAt: null, note: null, unitsExpected: 1, unitsScanned: 0 },
      { partNumber: '68575114AA', description: 'FASCIA-FRO', ordered: 1, shipped: 1, backOrdered: 0, listPrice: 487.00, netPrice: 233.60, amount: 233.60, checked: false, scanStatus: null, checkedAt: null, note: null, unitsExpected: 1, unitsScanned: 0 }
    ]
  },
  {
    id: 'sample_334102X1',
    invoiceNumber: '334102X1',
    accountNumber: '132038',
    vendor: 'ZEIGLER NISSAN ORLAND PARK',
    location: 'ORLAND PARK, IL',
    customer: 'PRECISION COLLISION CENTER',
    customerAddress: '1180 INDUSTRIAL DR, ORLAND PARK, IL',
    dateShipped: '30 APR 26',
    shipVia: 'SHIP 2',
    salesman: '7782',
    yourOrderNo: '15182',
    vin: 'JN8AY2NCXK9582915',
    vehicle: '2019 NISSAN ARMADA SL 4WD',
    terms: 'WHSLCHG6',
    total: 157.56,
    createdAt: Date.now() - 7200000,
    lineItems: [
      { partNumber: '62022-5ZW0H', description: 'FASCIA-FRO', ordered: 1, shipped: 0, backOrdered: 1, listPrice: 855.79, netPrice: 564.82, amount: 0.00, checked: false, scanStatus: null, checkedAt: null, note: 'BACK-ORDERED — should not be in lane', unitsExpected: 0, unitsScanned: 0 },
      { partNumber: '63880-1LA1A', description: 'RUBBER-OVE', ordered: 2, shipped: 1, backOrdered: 1, listPrice: 119.36, netPrice: 78.78, amount: 78.78, checked: false, scanStatus: null, checkedAt: null, note: 'PARTIAL: 1 of 2 shipped', unitsExpected: 1, unitsScanned: 0 },
      { partNumber: '63880-1LA1A', description: 'RUBBER-OVE', ordered: 1, shipped: 1, backOrdered: 0, listPrice: 119.36, netPrice: 78.78, amount: 78.78, checked: false, scanStatus: null, checkedAt: null, note: null, unitsExpected: 1, unitsScanned: 0 }
    ]
  },
  {
    id: 'sample_333572',
    invoiceNumber: '333572',
    accountNumber: '2119',
    vendor: 'ZEIGLER AUTO GROUP',
    location: 'KALAMAZOO, MI',
    customer: 'WESTSIDE AUTO BODY',
    customerAddress: '2210 PORTAGE RD, KALAMAZOO, MI',
    dateShipped: '30 APR 26',
    shipVia: 'GV-RAINBOW',
    salesman: '6501',
    yourOrderNo: '15251',
    vin: '1HGCV1F36JA035712',
    vehicle: 'HONDA — PT CDJR',
    terms: 'CHARGE',
    total: null,
    createdAt: Date.now() - 1800000,
    lineItems: [
      { partNumber: '91570-TVA-A01', description: 'CLIP, FR-', ordered: 2, shipped: 0, backOrdered: 2, listPrice: 1.32, netPrice: 0.90, amount: 0, checked: false, scanStatus: null, checkedAt: null, note: 'BACK-ORDERED', unitsExpected: 0, unitsScanned: 0 },
      { partNumber: '72450-TVA-A01', description: 'MOLDING, L', ordered: 1, shipped: 1, backOrdered: 0, listPrice: 106.67, netPrice: 72.54, amount: 72.54, checked: false, scanStatus: null, checkedAt: null, note: null, unitsExpected: 1, unitsScanned: 0 },
      { partNumber: '72965-TVA-A21', description: 'MOLDING, L', ordered: 1, shipped: 0, backOrdered: 1, listPrice: 90.00, netPrice: 61.20, amount: 0, checked: false, scanStatus: null, checkedAt: null, note: 'BACK-ORDERED', unitsExpected: 0, unitsScanned: 0 },
      { partNumber: '73525-SYY-000', description: 'RUBBER, RR', ordered: 3, shipped: 0, backOrdered: 3, listPrice: 20.88, netPrice: 14.20, amount: 0, checked: false, scanStatus: null, checkedAt: null, note: 'BACK-ORDERED (qty 3)', unitsExpected: 0, unitsScanned: 0 },
      { partNumber: '91568-TA0-A00', description: 'CLIP, FR-', ordered: 2, shipped: 0, backOrdered: 2, listPrice: 4.42, netPrice: 3.01, amount: 0, checked: false, scanStatus: null, checkedAt: null, note: 'BACK-ORDERED', unitsExpected: 0, unitsScanned: 0 },
      { partNumber: '91536-SS0-J01', description: 'FASTENER A', ordered: 2, shipped: 0, backOrdered: 2, listPrice: 8.00, netPrice: 5.44, amount: 0, checked: false, scanStatus: null, checkedAt: null, note: 'BACK-ORDERED', unitsExpected: 0, unitsScanned: 0 },
      { partNumber: '91501-S70-003', description: 'FASTENER B', ordered: 2, shipped: 0, backOrdered: 2, listPrice: 7.77, netPrice: 5.28, amount: 0, checked: false, scanStatus: null, checkedAt: null, note: 'BACK-ORDERED', unitsExpected: 0, unitsScanned: 0 },
      { partNumber: '63910-TVA-A00ZZ', description: 'LID, FUEL', ordered: 1, shipped: 0, backOrdered: 1, listPrice: 126.15, netPrice: 85.78, amount: 0, checked: false, scanStatus: null, checkedAt: null, note: 'BACK-ORDERED', unitsExpected: 0, unitsScanned: 0 },
      { partNumber: '04646-TVA-A01ZZ', description: 'PANEL SET', ordered: 1, shipped: 0, backOrdered: 1, listPrice: 802.35, netPrice: 545.60, amount: 0, checked: false, scanStatus: null, checkedAt: null, note: 'BACK-ORDERED', unitsExpected: 0, unitsScanned: 0 },
      { partNumber: '90104-SNW-003', description: 'RIVET (6-4)', ordered: 2, shipped: 0, backOrdered: 2, listPrice: 4.47, netPrice: 3.04, amount: 0, checked: false, scanStatus: null, checkedAt: null, note: 'BACK-ORDERED', unitsExpected: 0, unitsScanned: 0 }
    ]
  }
];

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

  useEffect(() => {
    (async () => {
      const savedInvoices = await loadFromStorage(STORAGE_KEYS.INVOICES, null);
      const savedLog = await loadFromStorage(STORAGE_KEYS.SCAN_LOG, []);
      const savedOrder = await loadFromStorage(STORAGE_KEYS.STOP_ORDER, []);
      if (savedInvoices && savedInvoices.length > 0) {
        setInvoices(savedInvoices);
      } else {
        setInvoices(SAMPLE_INVOICES);
      }
      setScanLog(savedLog);
      if (Array.isArray(savedOrder)) setStopOrder(savedOrder);
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (loaded) saveToStorage(STORAGE_KEYS.INVOICES, invoices);
  }, [invoices, loaded]);

  useEffect(() => {
    if (loaded) saveToStorage(STORAGE_KEYS.STOP_ORDER, stopOrder);
  }, [stopOrder, loaded]);

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

  useEffect(() => {
    if (loaded) saveToStorage(STORAGE_KEYS.SCAN_LOG, scanLog.slice(0, 500));
  }, [scanLog, loaded]);

  const activeInvoice = activeInvoiceIdx !== null ? invoices[activeInvoiceIdx] : null;

  const totalLineItems = invoices.reduce((sum, inv) => sum + inv.lineItems.filter(li => li.shipped > 0).length, 0);
  const checkedItems = invoices.reduce((sum, inv) => sum + inv.lineItems.filter(li => li.checked && li.shipped > 0).length, 0);
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

      setInvoices(prev => {
        // Remove samples on first real upload
        const isFirstRealUpload = prev.every(p => p.id?.startsWith('sample_'));
        const base = isFirstRealUpload ? [] : [...prev];
        const merged = base;
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
          ? `✓ Route report · ${newInvoices.length} invoice(s) · ${totalItems} line items`
          : `✓ Parsed ${newInvoices.length} invoice(s) · ${totalItems} line items`
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
        }
      };
    }
    return { status, lineRef: null };
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

  const clearAll = async () => {
    setInvoices([]);
    setScanLog([]);
    setStopOrder([]);
    setActiveInvoiceIdx(null);
    setView('dashboard');
    await saveToStorage(STORAGE_KEYS.INVOICES, []);
    await saveToStorage(STORAGE_KEYS.SCAN_LOG, []);
    await saveToStorage(STORAGE_KEYS.STOP_ORDER, []);
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
      lineItems: inv.lineItems.map(li => ({ ...li, checked: false, scanStatus: null, checkedAt: null, unitsScanned: 0 }))
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
  };

  if (!loaded) {
    return (
      <div className="min-h-screen bg-[#f4f4f4] flex items-center justify-center" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
        <div className="text-[11px] tracking-widest opacity-60">INITIALIZING...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f4f4f4] text-[#1a1a1a]" style={{ fontFamily: "'IBM Plex Mono', 'Courier New', monospace" }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />

      <header className="border-b-2 border-[#1a1a1a] bg-[#1a1a1a] text-[#f4f4f4]">
        <div className="px-3 py-2 flex items-center justify-between text-[11px]">
          <div className="flex items-center gap-3">
            <div className="font-extrabold tracking-wider" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
              PARTS RECEIVING <span className="text-[#0F62FE]">/</span> LANE CHECK
            </div>
            <div className="hidden md:block opacity-50 text-[10px]">TERMINAL 01 · LANE A · CDK BRIDGE v2.0</div>
          </div>
          <div className="flex items-center gap-3 text-[10px]">
            <button onClick={exportSession} title="Export session JSON" className="opacity-60 hover:opacity-100">
              <Download className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setConfirmClear(true)} title="Clear all data" className="opacity-60 hover:opacity-100">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <span className="opacity-60 hidden sm:inline">{new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            <div className="w-1.5 h-1.5 bg-[#5a8f3d] animate-pulse"></div>
          </div>
        </div>
      </header>

      <div className="border-b border-[#1a1a1a]/30 bg-[#e0e0e0] px-3 py-1 text-[10px] flex items-center gap-1 overflow-x-auto">
        <button onClick={() => { setView('dashboard'); setActiveInvoiceIdx(null); }} className={`px-2 py-0.5 ${view === 'dashboard' ? 'bg-[#1a1a1a] text-[#f4f4f4]' : 'hover:bg-[#1a1a1a]/10'}`}>
          DASHBOARD
        </button>
        <ChevronRight className="w-3 h-3 opacity-30" />
        {view === 'sort' ? (
          <span className="px-2 py-0.5 bg-[#0F62FE] text-white font-bold">SORT</span>
        ) : activeInvoice ? (
          <>
            <button onClick={() => setView('invoice')} className={`px-2 py-0.5 ${view === 'invoice' ? 'bg-[#1a1a1a] text-[#f4f4f4]' : 'hover:bg-[#1a1a1a]/10'}`}>
              STOP · {activeInvoice.customer || `INV ${activeInvoice.invoiceNumber}`}
            </button>
            {view === 'scan' && (
              <>
                <ChevronRight className="w-3 h-3 opacity-30" />
                <span className="px-2 py-0.5 bg-[#0F62FE] text-white font-bold">SCAN</span>
              </>
            )}
          </>
        ) : (
          <span className="px-2 py-0.5 opacity-50">—</span>
        )}
        <div className="flex-1"></div>
        <span className="text-[9px] opacity-40 hidden sm:inline">{invoices.length} STOPS · {scanLog.length} SCANS</span>
      </div>

      <main className="max-w-[1500px] mx-auto p-3 md:p-4">
        {view === 'dashboard' && (
          <DashboardView
            invoices={invoices}
            scanLog={scanLog}
            stats={{ totalLineItems, checkedItems, flaggedItems, backOrderedCount }}
            searchTerm={searchTerm}
            setSearchTerm={setSearchTerm}
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
                  lineItems: next[activeInvoiceIdx].lineItems.map(li => ({ ...li, checked: false, scanStatus: null, checkedAt: null, unitsScanned: 0 }))
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
            scanLog={scanLog.filter(l => l.source === 'sort' || l.source === 'manual' || l.source === 'bag_confirm' || l.source === 'skip')}
            onScan={processGlobalScan}
            onConfirmBag={confirmBag}
            onSkipRemaining={skipRemainingUnits}
            onSelectStop={(idx) => { setActiveInvoiceIdx(idx); setView('invoice'); }}
            onMergeStops={mergeStops}
            onSplitStop={splitStop}
            stopOrder={stopOrder}
            onReorderStops={reorderStops}
            onBack={() => setView('dashboard')}
          />
        )}
      </main>

      {confirmClear && (
        <div className="fixed inset-0 bg-[#1a1a1a]/70 flex items-center justify-center z-50 p-4">
          <div className="bg-[#ffffff] border-2 border-[#1a1a1a] max-w-md w-full">
            <div className="bg-[#a83232] text-white px-3 py-2 text-[11px] font-bold tracking-wider" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
              ⚠ CONFIRM DESTRUCTIVE ACTION
            </div>
            <div className="p-4">
              <div className="text-[12px] mb-4">This will permanently delete all uploaded invoices and the entire scan history. Cannot be undone.</div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setConfirmClear(false)} className="px-3 py-1.5 text-[11px] border border-[#1a1a1a] hover:bg-[#1a1a1a] hover:text-[#f4f4f4]">CANCEL</button>
                <button onClick={clearAll} className="px-3 py-1.5 text-[11px] bg-[#a83232] text-white font-bold hover:bg-[#8a2828]">DELETE ALL</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <footer className="border-t border-[#1a1a1a]/30 bg-[#e0e0e0] px-3 py-2 mt-6 text-[9px] flex items-center justify-between flex-wrap gap-2">
        <div className="opacity-50">PARTS RECEIVING · LANE CHECK · BUILT FOR CDK / TRAX EXPORT</div>
        <div className="opacity-50">DATA PERSISTED LOCALLY · NO BACKEND</div>
      </footer>
    </div>
  );
}

// ============================================================
// DASHBOARD
// ============================================================
function DashboardView({ invoices, scanLog, stats, searchTerm, setSearchTerm, onSelectInvoice, onLookupInvoiceCode, onUpload, uploadStatus, debugDump, onClearDebug, onResetScans, onStartSort }) {
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

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[#1a1a1a]/30 border border-[#1a1a1a]/30 mb-3">
        <StatBox
          label="STOPS LOADED"
          value={groupInvoicesIntoStops(invoices).length}
          sub={`${invoices.length} INVOICE${invoices.length === 1 ? '' : 'S'}`}
        />
        <StatBox label="UNITS · TO SORT" value={stats.totalLineItems} sub="EXPECTED IN LANE" />
        <StatBox label="VERIFIED" value={`${stats.checkedItems}/${stats.totalLineItems}`} sub={`${stats.totalLineItems > 0 ? Math.round((stats.checkedItems / stats.totalLineItems) * 100) : 0}% COMPLETE`} accent={stats.checkedItems === stats.totalLineItems && stats.totalLineItems > 0 ? '#5a8f3d' : null} />
        <StatBox label="ANOMALIES" value={stats.flaggedItems} sub={`${stats.backOrderedCount} B/O ITEMS`} accent={stats.flaggedItems > 0 ? '#a83232' : null} />
      </div>

      {invoices.length > 0 && (
        <button
          onClick={onStartSort}
          disabled={stats.totalLineItems === 0}
          className="w-full mb-3 bg-[#1a1a1a] text-[#0F62FE] hover:bg-[#5a8f3d] hover:text-white disabled:opacity-50 disabled:hover:bg-[#1a1a1a] disabled:cursor-not-allowed transition-colors px-4 py-3 text-[14px] font-extrabold tracking-widest border-2 border-[#1a1a1a] flex items-center justify-center gap-3"
          style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
        >
          <Camera className="w-5 h-5" />
          ▶ START SORT · {stats.checkedItems}/{stats.totalLineItems} UNITS VERIFIED
        </button>
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
        className={`border-2 ${dragOver ? 'border-[#5a8f3d] bg-[#5a8f3d]/5' : 'border-dashed border-[#1a1a1a]/40'} bg-[#ffffff] p-3 mb-3 transition-colors`}
      >
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 border border-[#1a1a1a]/40 flex items-center justify-center bg-[#e0e0e0]">
              <Upload className="w-4 h-4" />
            </div>
            <div>
              <div className="text-[12px] font-bold" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>INTAKE INVOICE</div>
              <div className="text-[10px] opacity-60">Upload PDF or scan printed invoice barcode to look up</div>
            </div>
          </div>
          <div className="flex gap-1.5 items-center flex-wrap">
            {uploadStatus && (
              <div className={`text-[10px] px-2 py-1 ${uploadStatus.stage === 'error' ? 'bg-[#a83232] text-white' : uploadStatus.stage === 'success' ? 'bg-[#5a8f3d] text-white' : 'bg-[#0F62FE] text-white'} font-bold tracking-wider`}>
                {uploadStatus.message}
              </div>
            )}
            {debugDump && (
              <button
                onClick={() => setShowDebug(true)}
                className="border border-[#a83232] text-[#a83232] px-2 py-1 text-[10px] font-bold tracking-wider hover:bg-[#a83232] hover:text-white"
                style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
              >
                VIEW EXTRACTED TEXT
              </button>
            )}
            <input
              type="file"
              accept="application/pdf"
              ref={fileInputRef}
              onChange={(e) => e.target.files[0] && onUpload(e.target.files[0])}
              className="hidden"
            />
            <button
              onClick={() => setInvoiceScanOpen(true)}
              className="border border-[#1a1a1a] bg-[#1a1a1a] text-[#f4f4f4] px-3 py-1.5 text-[11px] hover:bg-[#5a8f3d] transition-colors font-bold flex items-center gap-1.5"
              style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
            >
              <Camera className="w-3.5 h-3.5" /> SCAN INVOICE
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="border border-[#1a1a1a] px-3 py-1.5 text-[11px] hover:bg-[#1a1a1a] hover:text-[#f4f4f4] transition-colors font-bold"
              style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
            >
              UPLOAD PDF →
            </button>
          </div>
        </div>
      </div>

      {/* PDF DEBUG VIEWER */}
      {showDebug && debugDump && (
        <div className="fixed inset-0 bg-[#1a1a1a]/80 flex items-center justify-center z-50 p-4">
          <div className="bg-[#ffffff] border-2 border-[#1a1a1a] max-w-2xl w-full max-h-[85vh] flex flex-col">
            <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 flex items-center justify-between">
              <span className="text-[11px] font-extrabold tracking-wider" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
                EXTRACTED TEXT — {debugDump.fileName}
              </span>
              <button onClick={() => setShowDebug(false)} className="opacity-70 hover:opacity-100">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="bg-[#a83232]/10 border-b border-[#a83232]/30 px-3 py-2 text-[10px]">
              <div className="font-bold text-[#a83232] tracking-wider mb-0.5">PARSE FAILED</div>
              <div className="opacity-80">{debugDump.reason}</div>
              <div className="opacity-60 mt-1">{debugDump.pageCount} page(s) · {debugDump.rawText.length.toLocaleString()} chars extracted</div>
            </div>
            <div className="flex-1 overflow-auto p-3">
              {debugDump.rawText ? (
                <pre className="text-[10px] font-mono whitespace-pre-wrap break-words leading-snug">
                  {debugDump.rawText.slice(0, 20000)}
                  {debugDump.rawText.length > 20000 ? '\n\n... (truncated)' : ''}
                </pre>
              ) : (
                <div className="text-[11px] opacity-60 italic">
                  No text was extracted. The PDF is likely a scanned image — re-export from your DMS as a "text" or "searchable" PDF, or use OCR before uploading.
                </div>
              )}
            </div>
            <div className="border-t border-[#1a1a1a]/20 px-3 py-2 flex justify-end gap-2">
              <button
                onClick={() => { setShowDebug(false); onClearDebug?.(); }}
                className="border border-[#1a1a1a] px-3 py-1 text-[11px] font-bold hover:bg-[#1a1a1a] hover:text-[#f4f4f4]"
                style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
              >
                DISMISS
              </button>
            </div>
          </div>
        </div>
      )}

      {/* INVOICE BARCODE SCAN MODAL */}
      {invoiceScanOpen && (
        <div className="fixed inset-0 bg-[#1a1a1a]/80 flex items-center justify-center z-50 p-4">
          <div className="bg-[#ffffff] border-2 border-[#1a1a1a] max-w-lg w-full">
            <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 flex items-center justify-between">
              <span className="text-[11px] font-extrabold tracking-wider" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
                SCAN INVOICE BARCODE
              </span>
              <button onClick={() => { setInvoiceScanOpen(false); setInvoiceScanResult(null); }} className="opacity-70 hover:opacity-100">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="bg-[#e0e0e0] px-3 py-1.5 text-[10px] tracking-wider opacity-70" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
              POINT CAMERA AT INVOICE NUMBER BARCODE
            </div>

            <BarcodeScanner onDetect={handleInvoiceCodeDetected} label="INVOICE LOOKUP" />

            {invoiceScanResult && (
              <div className="bg-[#a83232]/10 border-t border-[#a83232]/30 px-3 py-3">
                <div className="text-[11px] font-bold text-[#a83232] tracking-wider mb-1">⚠ INVOICE NOT FOUND</div>
                <div className="text-[10px] opacity-70 mb-2">
                  Code <span className="font-mono font-bold">{invoiceScanResult.code}</span> doesn't match any loaded invoice.
                </div>
                <div className="text-[10px] opacity-60">Upload the corresponding PDF to add it to the system.</div>
              </div>
            )}

            <div className="p-3 border-t border-[#1a1a1a]/20">
              <div className="text-[9px] uppercase tracking-wider opacity-60 mb-1.5 font-bold">MANUAL LOOKUP</div>
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

      <div className="border border-[#1a1a1a]/30 bg-[#ffffff] mb-3">
        <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 text-[11px] tracking-wider flex items-center justify-between gap-2 flex-wrap" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
          <button
            onClick={() => setLedgerOpen(o => !o)}
            className="flex items-center gap-1.5 hover:opacity-80 select-none"
            aria-expanded={ledgerOpen}
            title={ledgerOpen ? 'Collapse ledger' : 'Expand ledger'}
          >
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${ledgerOpen ? 'rotate-90' : ''}`} />
            <span className="font-extrabold">INVOICE LEDGER</span>
            <span className="text-[10px] opacity-60 font-mono">· {invoices.length}</span>
          </button>
          {ledgerOpen && (
            <div className="flex items-center gap-2">
              <button onClick={onResetScans} title="Reset all check states" className="text-[10px] opacity-70 hover:opacity-100 flex items-center gap-1">
                <RefreshCw className="w-3 h-3" /> RESET CHECKS
              </button>
              <div className="flex items-center gap-1.5 bg-[#f4f4f4]/10 px-2 py-0.5">
                <Search className="w-3 h-3" />
                <input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="filter by inv# / vin / part..."
                  className="bg-transparent outline-none text-[11px] w-44 placeholder:text-[#f4f4f4]/40"
                />
              </div>
            </div>
          )}
        </div>

        {ledgerOpen && (
          <div className="hidden md:grid grid-cols-12 gap-2 px-3 py-1.5 text-[9px] border-b border-[#1a1a1a]/20 bg-[#e0e0e0] uppercase tracking-wider font-bold">
            <div className="col-span-2">INVOICE #</div>
            <div className="col-span-3">VENDOR / ORIGIN</div>
            <div className="col-span-3">VEHICLE / VIN</div>
            <div className="col-span-1">SHIP VIA</div>
            <div className="col-span-1 text-right">PROG</div>
            <div className="col-span-1 text-right">TOTAL</div>
            <div className="col-span-1 text-right">STATUS</div>
          </div>
        )}

        {ledgerOpen && filtered.length === 0 && (
          <div className="px-3 py-8 text-center text-[11px] opacity-50">
            <FileSearch className="w-6 h-6 mx-auto mb-2 opacity-50" />
            {invoices.length === 0 ? 'No invoices loaded. Upload a PDF to begin.' : 'No invoices match filter.'}
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

          return (
            <button
              key={inv.id}
              onClick={() => onSelectInvoice(realIdx)}
              className="w-full grid grid-cols-12 gap-2 px-3 py-2.5 text-[11px] border-b border-[#1a1a1a]/10 hover:bg-[#e0e0e0]/60 transition-colors text-left items-center"
            >
              <div className="col-span-12 md:col-span-2 font-bold text-[12px]">{inv.invoiceNumber}</div>
              <div className="col-span-12 md:col-span-3">
                <div className="truncate">{inv.vendor}</div>
                <div className="text-[9px] opacity-60">{inv.location}{inv.accountNumber ? ` · acct ${inv.accountNumber}` : ''}</div>
              </div>
              <div className="col-span-12 md:col-span-3">
                <div className="text-[10px] truncate">{inv.vehicle || '—'}</div>
                {inv.vin && <div className="text-[9px] opacity-50 font-mono truncate">{inv.vin}</div>}
              </div>
              <div className="col-span-6 md:col-span-1 text-[10px]">{inv.shipVia}</div>
              <div className="col-span-3 md:col-span-1 text-right">
                <span className="font-bold">{scannedUnits}</span>
                <span className="opacity-50">/{totalUnits}</span>
              </div>
              <div className="col-span-3 md:col-span-1 text-right text-[10px]">{inv.total ? `$${inv.total.toFixed(2)}` : '—'}</div>
              <div className="col-span-12 md:col-span-1 text-right">
                {allChecked ? (
                  <span className="inline-block bg-[#5a8f3d] text-white px-1.5 py-0.5 text-[9px] font-bold tracking-wider">DONE</span>
                ) : hasAnomaly ? (
                  <span className="inline-block bg-[#a83232] text-white px-1.5 py-0.5 text-[9px] font-bold tracking-wider">FLAG</span>
                ) : inProgress ? (
                  <span className="inline-block bg-[#0F62FE] text-white px-1.5 py-0.5 text-[9px] font-bold tracking-wider">WIP</span>
                ) : (
                  <span className="inline-block bg-[#1a1a1a]/15 text-[#1a1a1a] px-1.5 py-0.5 text-[9px] font-bold tracking-wider">OPEN</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {scanLog.length > 0 && (
        <div className="border border-[#1a1a1a]/30 bg-[#ffffff]">
          <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 text-[11px] tracking-wider font-extrabold flex items-center justify-between" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
            <span>ACTIVITY LOG</span>
            <span className="text-[9px] opacity-60">LAST {Math.min(scanLog.length, 15)} OF {scanLog.length}</span>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {scanLog.slice(0, 15).map((log, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 px-3 py-1.5 text-[10px] border-b border-[#1a1a1a]/10 items-center">
                <div className="col-span-2 md:col-span-1 opacity-50 font-mono">{log.ts}</div>
                <div className="col-span-3 md:col-span-2 font-mono">{log.invoiceNumber}</div>
                <div className="col-span-7 md:col-span-3 font-bold truncate">{log.partNumber}</div>
                <div className="col-span-5 md:col-span-2">
                  <StatusBadge status={log.status} />
                </div>
                <div className="col-span-7 md:col-span-4 text-[9px] opacity-70 truncate">{log.note}</div>
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

  return (
    <div>
      <div className="border border-[#1a1a1a] bg-[#ffffff] mb-3">
        <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4" />
            <span className="text-[12px] tracking-wider font-extrabold" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
              INVOICE {invoice.invoiceNumber}
            </span>
            {invoice.id?.startsWith('sample_') && (
              <span className="text-[9px] bg-[#0F62FE] text-white px-1.5 py-0.5 font-bold tracking-wider">SAMPLE</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={onResetInvoice} title="Reset scan state" className="text-[10px] opacity-60 hover:opacity-100 px-2 py-1 hover:bg-white/10 flex items-center gap-1">
              <RefreshCw className="w-3 h-3" /> RESET
            </button>
            <button onClick={() => setConfirmDelete(true)} title="Delete invoice" className="text-[10px] opacity-60 hover:opacity-100 px-2 py-1 hover:bg-white/10">
              <Trash2 className="w-3 h-3" />
            </button>
            <button
              onClick={onScan}
              className="bg-[#0F62FE] text-white px-3 py-1.5 text-[11px] font-extrabold tracking-wider hover:bg-[#0353E9] transition-colors flex items-center gap-1.5"
              style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
            >
              <Camera className="w-3.5 h-3.5" /> ENTER SCAN MODE
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[#1a1a1a]/20">
          <InfoCell label="VENDOR" value={invoice.vendor} sub={invoice.location} />
          <InfoCell label="ACCOUNT" value={invoice.accountNumber || '—'} sub={invoice.yourOrderNo ? `ORDER ${invoice.yourOrderNo}` : ''} />
          <InfoCell label="VEHICLE" value={invoice.vehicle || '—'} sub={invoice.vin || ''} mono />
          <InfoCell label="SHIP VIA" value={invoice.shipVia || '—'} sub={invoice.dateShipped} />
        </div>
      </div>

      <div className="border border-[#1a1a1a]/30 bg-[#ffffff] mb-3">
        <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 text-[11px] tracking-wider font-extrabold flex items-center justify-between" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
          <span>LINE ITEMS · {invoice.lineItems.length} ROWS</span>
          <span className="text-[9px] opacity-70">
            SHIPPED {invoice.lineItems.filter(li => li.shipped > 0).length} · B/O {invoice.lineItems.filter(li => li.backOrdered > 0 && li.shipped === 0).length}
          </span>
        </div>

        <div className="hidden md:grid grid-cols-12 gap-1 px-3 py-1.5 text-[9px] border-b border-[#1a1a1a]/30 bg-[#e0e0e0] uppercase tracking-wider font-bold">
          <div className="col-span-1">CHECK</div>
          <div className="col-span-3">PART NUMBER</div>
          <div className="col-span-3">DESCRIPTION</div>
          <div className="col-span-1 text-right">ORD</div>
          <div className="col-span-1 text-right">SHIP</div>
          <div className="col-span-1 text-right">B/O</div>
          <div className="col-span-1 text-right">NET</div>
          <div className="col-span-1 text-right">AMT</div>
        </div>

        {invoice.lineItems.map((item, i) => {
          const isBackOrdered = item.backOrdered > 0 && item.shipped === 0;
          const partialScan = item.unitsExpected > 0 && (item.unitsScanned || 0) > 0 && (item.unitsScanned || 0) < item.unitsExpected;

          return (
            <div key={i} className={`grid grid-cols-12 gap-1 px-3 py-2 text-[11px] border-b border-[#1a1a1a]/10 items-center ${isBackOrdered ? 'bg-[#a83232]/5' : item.checked ? 'bg-[#5a8f3d]/10' : partialScan ? 'bg-[#0F62FE]/10' : ''}`}>
              <div className="col-span-3 md:col-span-1 flex items-center">
                {isBackOrdered ? (
                  <span className="text-[#a83232] text-[9px] font-bold">B/O</span>
                ) : item.checked ? (
                  <Check className="w-4 h-4 text-[#5a8f3d]" strokeWidth={3} />
                ) : partialScan ? (
                  <span className="text-[9px] font-bold text-[#0F62FE]">{item.unitsScanned}/{item.unitsExpected}</span>
                ) : (
                  <div className="w-3 h-3 border border-[#1a1a1a]/40"></div>
                )}
              </div>
              <div className="col-span-9 md:col-span-3 font-bold font-mono">{item.partNumber}</div>
              <div className="col-span-12 md:col-span-3 text-[10px]">
                {item.description}
                {item.note && <div className="text-[9px] text-[#a83232] mt-0.5">{item.note}</div>}
              </div>
              <div className="col-span-3 md:col-span-1 text-right">{item.ordered}</div>
              <div className="col-span-3 md:col-span-1 text-right font-bold">{item.shipped}</div>
              <div className="col-span-3 md:col-span-1 text-right text-[#a83232]">{item.backOrdered || ''}</div>
              <div className="col-span-3 md:col-span-1 text-right opacity-70 text-[10px]">{item.netPrice.toFixed(2)}</div>
              <div className="col-span-12 md:col-span-1 text-right text-[10px]">{item.amount > 0 ? item.amount.toFixed(2) : '—'}</div>
            </div>
          );
        })}

        {invoice.total && (
          <div className="grid grid-cols-12 gap-1 px-3 py-2 text-[12px] bg-[#1a1a1a] text-[#f4f4f4] font-extrabold">
            <div className="col-span-10 text-right uppercase tracking-wider">TOTAL</div>
            <div className="col-span-2 text-right">${invoice.total.toFixed(2)}</div>
          </div>
        )}
      </div>

      {scanLog.length > 0 && (
        <div className="border border-[#1a1a1a]/30 bg-[#ffffff] mb-3">
          <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 text-[11px] tracking-wider font-extrabold" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
            SCAN HISTORY · {scanLog.length} EVENTS
          </div>
          <div className="max-h-48 overflow-y-auto">
            {scanLog.slice(0, 20).map((log, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 px-3 py-1.5 text-[10px] border-b border-[#1a1a1a]/10 items-center">
                <div className="col-span-2 opacity-50 font-mono">{log.ts}</div>
                <div className="col-span-4 font-bold font-mono truncate">{log.partNumber}</div>
                <div className="col-span-2"><StatusBadge status={log.status} /></div>
                <div className="col-span-4 text-[9px] opacity-70 truncate">{log.note}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {invoice.rawText && (
        <div className="border border-[#1a1a1a]/30 bg-[#ffffff] mb-3">
          <button
            onClick={() => setShowRawText(!showRawText)}
            className="w-full bg-[#e0e0e0] px-3 py-1.5 text-[10px] tracking-wider font-bold flex items-center justify-between hover:bg-[#c6c6c6]"
            style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
          >
            <span>{showRawText ? <EyeOff className="w-3 h-3 inline mr-1" /> : <Eye className="w-3 h-3 inline mr-1" />} RAW PARSE OUTPUT (DEBUG)</span>
            <ChevronRight className={`w-3 h-3 transition-transform ${showRawText ? 'rotate-90' : ''}`} />
          </button>
          {showRawText && (
            <pre className="text-[9px] p-3 max-h-64 overflow-auto whitespace-pre-wrap break-all opacity-70 bg-[#1a1a1a] text-[#0F62FE]">
              {invoice.rawText}
            </pre>
          )}
        </div>
      )}

      <button onClick={onBack} className="text-[10px] opacity-60 hover:opacity-100">
        ← back to dashboard
      </button>

      {confirmDelete && (
        <div className="fixed inset-0 bg-[#1a1a1a]/70 flex items-center justify-center z-50 p-4">
          <div className="bg-[#ffffff] border-2 border-[#1a1a1a] max-w-md w-full">
            <div className="bg-[#a83232] text-white px-3 py-2 text-[11px] font-bold tracking-wider">CONFIRM DELETE INVOICE</div>
            <div className="p-4">
              <div className="text-[12px] mb-4">Remove invoice {invoice.invoiceNumber} from the system?</div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setConfirmDelete(false)} className="px-3 py-1.5 text-[11px] border border-[#1a1a1a]">CANCEL</button>
                <button onClick={() => { setConfirmDelete(false); onDeleteInvoice(); }} className="px-3 py-1.5 text-[11px] bg-[#a83232] text-white font-bold">DELETE</button>
              </div>
            </div>
          </div>
        </div>
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
//   2. Native BarcodeDetector preferred. Chrome on Android and Safari on
//      iOS 17+ ship a hardware-accelerated detector that's typically
//      5-10× faster than the JS-only ZXing decoder. We fall back to
//      ZXing only when BarcodeDetector is unavailable.
//   3. Cropped center-region decode. Each frame is drawn into a canvas
//      cropped to a 70%-wide × 35%-tall center rectangle. Decoding a
//      smaller region is faster, and structurally rejects "corner-of-
//      frame" false reads — anything outside that box won't be seen.
//   4. Confirmation buffer. A code must be detected the same way at
//      least twice within a 700ms window before it's emitted to the
//      caller. Eliminates spurious one-frame reads from camera shake
//      or quick hovers.
//   5. Strong camera constraints. 1080p, 30fps, with continuous-focus /
//      exposure / white-balance applied via applyConstraints() (non-
//      fatal if the device doesn't support them).
//   6. Optional torch toggle when the camera advertises that capability.
//
// Result: a clean barcode in the bracket emits in well under a second
// on modern phones; off-target reads are dropped before they reach
// the consumer.

// Auto-parts barcode formats — keep in sync between native BarcodeDetector
// and ZXing names (different naming conventions per API).
const SCAN_FORMATS_NATIVE = ['code_128', 'code_39', 'data_matrix', 'qr_code', 'itf'];
const SCAN_FORMATS_ZXING = ['CODE_128', 'CODE_39', 'DATA_MATRIX', 'QR_CODE', 'ITF'];

// Center scan region (fraction of frame). Matches the visible bracket.
const CROP_W_FRAC = 0.70;
const CROP_H_FRAC = 0.35;

// A code must repeat this many times within this window to be accepted.
const CONFIRM_COUNT = 2;
const CONFIRM_WINDOW_MS = 700;
// After a successful emit, ignore the same code for this long to avoid
// double-firing on the next frame.
const COOLDOWN_MS = 1500;
// Plausibility filter: real part numbers and invoice numbers in this app
// are always 6+ characters. Auto-parts labels often carry a tiny secondary
// barcode encoding the per-pack quantity (a single digit like "1"), or a
// date/batch code. Those reads end up as bogus UNKNOWN flashes that
// interrupt the driver. Drop them at the scanner boundary so the camera
// just keeps running until something part-shaped lands in the box.
const MIN_PLAUSIBLE_CODE_LEN = 6;

function BarcodeScanner({ onDetect, label = 'BARCODE · 1D/2D', autoStart = false }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  // Two parallel detector engines. We prefer the native one when it works
  // because it's hardware-accelerated, but the JS-only ZXing fallback is
  // always available as a safety net (iOS 17 Safari ships a BarcodeDetector
  // implementation that's known to be flaky).
  const nativeDetectRef = useRef(null);
  const zxingDetectRef = useRef(null);
  const nativeFailRef = useRef(0);
  const rafRef = useRef(null);
  const recentRef = useRef([]);
  const lastEmitRef = useRef({ code: null, t: 0 });
  const [state, setState] = useState(autoStart ? 'starting' : 'idle');
  const [errorMsg, setErrorMsg] = useState(null);
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

  const stop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    nativeDetectRef.current = null;
    zxingDetectRef.current = null;
    nativeFailRef.current = 0;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => { try { t.stop(); } catch (e) { } });
      streamRef.current = null;
    }
    if (videoRef.current) {
      try { videoRef.current.srcObject = null; } catch (e) { }
    }
    recentRef.current = [];
    lastEmitRef.current = { code: null, t: 0 };
    setTorchOn(false);
    setTorchAvailable(false);
    setEngineKind(null);
    setState('idle');
  }, []);

  const tryConfirm = useCallback((code) => {
    // Implausibility filter — drop reads that are too short to be a real
    // part number or invoice. Common offenders: the small qty-of-1 barcode
    // on a Honda/Mopar parts label, two-digit date markers, etc. These
    // never become a useful match downstream and only generate UNKNOWN
    // flashes that interrupt the driver. Filtered before the confirmation
    // buffer so they can't even claim a slot.
    if (!code || code.length < MIN_PLAUSIBLE_CODE_LEN) return false;

    const now = Date.now();
    if (lastEmitRef.current.code === code && now - lastEmitRef.current.t < COOLDOWN_MS) {
      return false;
    }
    recentRef.current = recentRef.current
      .filter(e => now - e.t < CONFIRM_WINDOW_MS)
      .concat({ t: now, code });
    const matches = recentRef.current.filter(e => e.code === code).length;
    if (matches >= CONFIRM_COUNT) {
      recentRef.current = [];
      lastEmitRef.current = { code, t: now };
      if (navigator.vibrate) {
        try { navigator.vibrate(40); } catch (e) { /* unsupported */ }
      }
      return true;
    }
    return false;
  }, []);

  const decodeFrame = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) {
      rafRef.current = requestAnimationFrame(decodeFrame);
      return;
    }
    if (video.readyState < 2 || !video.videoWidth) {
      rafRef.current = requestAnimationFrame(decodeFrame);
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

    // Native first — but only if it hasn't been consistently throwing.
    // After 5 consecutive throws we assume the native detector is broken
    // on this device and fall through to ZXing for the rest of the session.
    const native = nativeDetectRef.current;
    if (native && nativeFailRef.current < 5) {
      try {
        result = await native(canvas);
        nativeFailRef.current = 0;
      } catch (e) {
        nativeFailRef.current++;
        if (nativeFailRef.current >= 5) {
          console.warn('[scanner] native BarcodeDetector failed 5 times in a row, switching to ZXing');
          nativeDetectRef.current = null;
          setEngineKind('zxing');
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

    if (result && result.text) {
      if (tryConfirm(result.text)) {
        onDetect(result.text);
      }
    }

    rafRef.current = requestAnimationFrame(decodeFrame);
  }, [onDetect, tryConfirm]);

  // Build native + ZXing detectors. Both are built when possible so we always
  // have a fallback ready.
  const buildDetectors = async () => {
    let kind = null;

    // Native BarcodeDetector
    if (typeof window.BarcodeDetector === 'function') {
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

        zxingDetectRef.current = (canvas) => {
          try {
            const lum = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
            const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum));
            const r = reader.decode(bitmap);
            try { reader.reset(); } catch (_) { }
            return r ? { text: r.getText(), format: r.getBarcodeFormat ? r.getBarcodeFormat() : null } : null;
          } catch (e) {
            try { reader.reset(); } catch (_) { }
            return null;
          }
        };
        if (!kind) kind = 'zxing';
      }
    } catch (e) {
      console.warn('[scanner] ZXing init failed:', e);
    }

    if (!nativeDetectRef.current && !zxingDetectRef.current) {
      throw new Error('No barcode decoder could be initialized');
    }
    return kind;
  };

  const start = useCallback(async () => {
    setState('starting');
    setErrorMsg(null);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setErrorMsg('Camera API unavailable. Use HTTPS and a modern browser.');
      setState('error');
      return;
    }
    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
      setErrorMsg('Camera requires HTTPS connection.');
      setState('error');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, min: 24 }
        },
        audio: false
      });
      streamRef.current = stream;

      const track = stream.getVideoTracks()[0];
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
        if (caps && 'torch' in caps) setTorchAvailable(true);
      } catch (e) { /* non-fatal */ }

      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      video.muted = true;
      try { await video.play(); } catch (e) { /* autoplay quirks */ }

      const kind = await buildDetectors();
      setEngineKind(kind);

      setState('live');
      rafRef.current = requestAnimationFrame(decodeFrame);
    } catch (err) {
      console.error('Scanner start failed:', err);
      let msg = err.message || 'Camera unavailable';
      if (err.name === 'NotAllowedError') msg = 'Camera permission denied. Allow camera access in browser settings.';
      else if (err.name === 'NotFoundError') msg = 'No camera found on this device.';
      else if (err.name === 'NotReadableError') msg = 'Camera is in use by another app.';
      else if (err.name === 'OverconstrainedError') msg = 'No camera matched the requested settings.';
      setErrorMsg(msg);
      setState('error');
      stop();
    }
  }, [decodeFrame, stop]);

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
    if (autoStart) start();
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="aspect-[4/3] bg-[#1a1a1a] relative overflow-hidden">
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
          <div className="absolute top-0 left-0 w-6 h-6 border-l-2 border-t-2 border-[#0F62FE]"></div>
          <div className="absolute top-0 right-0 w-6 h-6 border-r-2 border-t-2 border-[#0F62FE]"></div>
          <div className="absolute bottom-0 left-0 w-6 h-6 border-l-2 border-b-2 border-[#0F62FE]"></div>
          <div className="absolute bottom-0 right-0 w-6 h-6 border-r-2 border-b-2 border-[#0F62FE]"></div>
          {state === 'live' && (
            <>
              <div className="absolute left-1 right-1 h-0.5 bg-gradient-to-r from-transparent via-[#0F62FE] to-transparent animate-[scanline_1.4s_ease-in-out_infinite]"></div>
              <style>{`
                @keyframes scanline {
                  0%, 100% { top: 8%; opacity: 0.95; }
                  50% { top: 92%; opacity: 0.5; }
                }
              `}</style>
            </>
          )}
        </div>

        <div className="absolute top-2 left-2 right-2 flex justify-between items-center text-[9px] text-[#0F62FE] font-mono">
          <span className={state === 'live' ? 'animate-pulse' : ''}>
            ● {state === 'live' ? 'LIVE' : state === 'starting' ? 'INIT' : state === 'error' ? 'ERR' : 'OFF'}
            {engineKind && state === 'live' && (
              <span className="opacity-70 ml-1">· {engineKind === 'native' ? 'HW' : 'JS'}</span>
            )}
          </span>
          <span>{label}</span>
        </div>
        <div className="absolute bottom-2 left-2 right-2 text-center text-[9px] text-[#0F62FE]/85 font-mono tracking-widest">
          {state === 'live' ? 'CENTER BARCODE IN BOX · HOLD STEADY' :
           state === 'starting' ? 'REQUESTING CAMERA…' :
           state === 'error' ? '⚠ CAMERA ERROR' :
           'TAP START TO ACTIVATE'}
        </div>
      </div>

      {state === 'idle' && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a1a]/95 pointer-events-auto">
          <div className="text-center px-4 max-w-xs">
            <Camera className="w-10 h-10 mx-auto mb-3 text-[#0F62FE]" />
            <div className="text-[10px] text-[#0F62FE] tracking-widest mb-1">CAMERA STANDBY</div>
            <div className="text-[9px] text-[#0F62FE]/60 mb-3">
              Tap to activate camera. Browser will request permission.
            </div>
            <button
              onClick={start}
              className="bg-[#0F62FE] text-white px-4 py-2 text-[11px] font-extrabold tracking-widest hover:bg-[#0353E9]"
              style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
            >
              ▶ START CAMERA
            </button>
          </div>
        </div>
      )}

      {state === 'starting' && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a1a]/85 pointer-events-none">
          <div className="text-center px-4">
            <div className="text-[10px] text-[#0F62FE] tracking-widest animate-pulse">REQUESTING CAMERA…</div>
            <div className="text-[9px] text-[#0F62FE]/60 mt-1">Approve permission prompt</div>
          </div>
        </div>
      )}

      {state === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a1a]/95 pointer-events-auto">
          <div className="text-center px-4 max-w-sm">
            <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-[#a83232]" />
            <div className="text-[10px] text-[#a83232] tracking-widest mb-1">CAMERA ERROR</div>
            <div className="text-[10px] text-[#0F62FE]/80 mb-3">{errorMsg}</div>
            <button
              onClick={start}
              className="bg-[#0F62FE] text-white px-3 py-1.5 text-[10px] font-bold tracking-wider hover:bg-[#0353E9]"
            >
              ↻ RETRY
            </button>
          </div>
        </div>
      )}

      {state === 'live' && (
        <div className="absolute top-2 right-2 flex gap-1 pointer-events-auto">
          {torchAvailable && (
            <button
              onClick={toggleTorch}
              className={`px-2 py-1 text-[9px] font-bold tracking-widest border ${torchOn ? 'bg-[#0F62FE] text-white border-[#0F62FE]' : 'bg-[#1a1a1a]/80 text-[#0F62FE] border-[#0F62FE]/50 hover:border-[#0F62FE]'}`}
              aria-label="Toggle torch"
            >
              {torchOn ? '◉ TORCH' : '○ TORCH'}
            </button>
          )}
          <button
            onClick={stop}
            className="bg-[#1a1a1a]/80 text-[#0F62FE] px-2 py-1 text-[9px] font-bold tracking-widest hover:bg-[#a83232] hover:text-white"
          >
            ■ STOP
          </button>
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

function SortView({ invoices, scanLog, onScan, onConfirmBag, onSkipRemaining, onSelectStop, onMergeStops, onSplitStop, stopOrder, onReorderStops, onBack }) {
  const [flashMessage, setFlashMessage] = useState(null);
  const [bagCount, setBagCount] = useState('');
  const [mergeFromKey, setMergeFromKey] = useState(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualValue, setManualValue] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const audioCtxRef = useRef(null);
  const flashTimerRef = useRef(null);

  const beep = (frequency = 800, duration = 100) => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
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
  };

  // Flash dismissal. Single-unit matches auto-dismiss in 1.8s. Multi-unit
  // matches stay open until the driver explicitly confirms the count or
  // closes — they need time to count the bag and type the value.
  const showFlash = (code, status, lineRef) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashMessage({ code, status, lineRef, ts: Date.now() });
    const isMultiQty = lineRef && lineRef.unitsExpected > 1 && lineRef.unitsScanned < lineRef.unitsExpected;
    if (isMultiQty) {
      // Pre-fill the bag-count input with the expected qty so the common
      // case (bag is exactly the ordered count) is a single Confirm tap.
      setBagCount(String(lineRef.unitsExpected));
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
    const ok = status === 'MATCHED';
    beep(ok ? 880 : 400, ok ? 80 : 200);
    showFlash(code, status, lineRef);
    return status;
  }, [onScan]);

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

  if (invoices.length === 0) {
    return (
      <div className="border border-[#1a1a1a] bg-[#ffffff] p-8 text-center">
        <Package className="w-10 h-10 mx-auto mb-3 opacity-50" />
        <div className="text-[12px] font-bold mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
          NO STOPS LOADED
        </div>
        <div className="text-[10px] opacity-70 mb-4">
          Upload today's invoice PDFs on the dashboard to start sorting.
        </div>
        <button
          onClick={onBack}
          className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-1.5 text-[10px] font-bold tracking-wider hover:bg-[#5a8f3d]"
        >
          ← BACK TO DASHBOARD
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* LEFT: camera + recent scans */}
      <div className="space-y-3">
        <div className="border border-[#1a1a1a] bg-[#ffffff]">
          <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 text-[11px] font-extrabold tracking-wider flex items-center justify-between gap-2" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
            <span className="truncate">SORT MODE · {totalGot}/{totalExpected} UNITS · {stopsReady}/{stops.length} STOPS</span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setReportOpen(true)}
                className="bg-[#0F62FE] text-white px-2 py-1 text-[10px] font-extrabold tracking-widest hover:bg-[#0353E9]"
                title="Run a missing-parts report"
              >
                ▸ FINISH SORT
              </button>
              <button onClick={onBack} className="opacity-70 hover:opacity-100" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="relative">
            <BarcodeScanner onDetect={handleDetect} label="LANE SORT · 1D/2D" autoStart />

            {/* Manual entry trigger — for unbarcoded parts (e.g. small fasteners
                in an envelope with the part number handwritten on it). Lives
                on the camera overlay, top-left, so it's reachable without
                navigating away. */}
            <button
              onClick={() => setManualOpen(true)}
              className="absolute top-2 left-1/2 -translate-x-1/2 bg-[#1a1a1a]/80 text-[#0F62FE] border border-[#0F62FE]/50 hover:bg-[#0F62FE] hover:text-white px-2 py-1 text-[9px] font-bold tracking-widest pointer-events-auto z-10"
              title="Type part number manually (no barcode)"
            >
              ⌨ TYPE
            </button>

            {flashMessage && (() => {
              const ref = flashMessage.lineRef;
              const showBagConfirm = flashMessage.status === 'MATCHED' && ref &&
                ref.unitsExpected > 1 && ref.unitsScanned < ref.unitsExpected;
              return (
                <div className={`absolute inset-0 flex items-center justify-center backdrop-blur-sm ${showBagConfirm ? 'pointer-events-auto' : 'pointer-events-none'} z-10 ${flashMessage.status === 'MATCHED' ? 'bg-[#5a8f3d]/40' : 'bg-[#a83232]/40'}`}>
                  <div className="bg-[#ffffff] border-2 border-[#1a1a1a] px-4 py-3 text-center max-w-[320px] relative">
                    {showBagConfirm && (
                      <button
                        onClick={dismissFlash}
                        className="absolute top-1 right-1 opacity-50 hover:opacity-100"
                        aria-label="Dismiss"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <div className="text-[10px] tracking-widest opacity-60">SCANNED</div>
                    <div className="text-[14px] font-bold font-mono mt-1 break-all">{flashMessage.code}</div>
                    <div className="mt-2"><StatusBadge status={flashMessage.status} /></div>
                    {ref && (
                      <div className="text-[10px] opacity-80 mt-2 font-mono">
                        → {ref.customer}
                        {ref.description && ref.description !== 'PART' && (
                          <span className="opacity-60"> · {ref.description}</span>
                        )}
                        <span className="ml-1 font-bold">({ref.unitsScanned}/{ref.unitsExpected})</span>
                      </div>
                    )}
                    {showBagConfirm && (
                      <div className="mt-3 pt-3 border-t border-[#1a1a1a]/20">
                        <div className="text-[10px] opacity-70 mb-2">
                          Count the bag, confirm received qty:
                        </div>
                        <div className="flex items-center gap-2 mb-2">
                          <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            value={bagCount}
                            onChange={(e) => setBagCount(e.target.value.replace(/[^0-9]/g, ''))}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmBag(); }}
                            className="flex-1 border-2 border-[#1a1a1a] bg-[#ffffff] px-3 py-3 text-[24px] font-extrabold font-mono text-center outline-none focus:border-[#5a8f3d]"
                            style={{ minWidth: 0 }}
                          />
                          <span className="text-[14px] opacity-60 font-mono">/ {ref.unitsExpected}</span>
                        </div>
                        <button
                          onClick={handleConfirmBag}
                          disabled={!bagCount || parseInt(bagCount, 10) <= ref.unitsScanned}
                          className="w-full bg-[#5a8f3d] text-white px-3 py-2 text-[11px] font-extrabold tracking-widest hover:bg-[#4a7a30] disabled:opacity-40 disabled:hover:bg-[#5a8f3d]"
                          style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
                        >
                          ✓ CONFIRM {bagCount || '—'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {allDone && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#5a8f3d]/85 pointer-events-none z-20">
                <div className="bg-[#ffffff] border-2 border-[#1a1a1a] px-6 py-4 text-center">
                  <Check className="w-10 h-10 mx-auto mb-2 text-[#5a8f3d]" strokeWidth={3} />
                  <div className="text-[14px] font-extrabold tracking-widest" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
                    LANE SORTED
                  </div>
                  <div className="text-[10px] opacity-70 mt-1">All {stops.length} stops accounted for</div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Recent scans */}
        <div className="border border-[#1a1a1a]/30 bg-[#ffffff]">
          <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 text-[11px] font-extrabold tracking-wider" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
            RECENT SCANS · LAST {Math.min(scanLog.length, 12)}
          </div>
          <div className="max-h-72 overflow-y-auto">
            {scanLog.slice(0, 12).map((log, i) => (
              <div key={i} className="px-3 py-1.5 text-[10px] border-b border-[#1a1a1a]/10">
                <div className="flex items-baseline gap-2">
                  <span className="opacity-50 font-mono">{log.ts}</span>
                  <span className="font-bold font-mono truncate flex-1">{log.partNumber}</span>
                  <StatusBadge status={log.status} />
                </div>
                {log.note && (
                  <div className="text-[9px] opacity-70 mt-0.5 ml-12 truncate">{log.note}</div>
                )}
              </div>
            ))}
            {scanLog.length === 0 && (
              <div className="px-3 py-6 text-center text-[10px] opacity-50">
                Scan a part to begin
              </div>
            )}
          </div>
        </div>
      </div>

      {/* RIGHT: per-stop progress + anomalies */}
      <div className="space-y-3">
        <div className="border border-[#1a1a1a] bg-[#ffffff]">
          <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 text-[11px] font-extrabold tracking-wider flex items-center justify-between" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
            <span>TODAY'S ROUTE · {stops.length} STOP{stops.length === 1 ? '' : 'S'}</span>
            <span className="text-[10px] opacity-70">{Math.round(overallPct)}% sorted</span>
          </div>
          <div className="h-1 bg-[#e0e0e0] relative overflow-hidden">
            <div className="h-full bg-[#5a8f3d] transition-all duration-300" style={{ width: `${overallPct}%` }}></div>
          </div>
          <div className="max-h-[55vh] overflow-y-auto">
            {stops.map((stop, idx) => {
              const invCount = stop.invoices.length;
              const invSummary = invCount === 1
                ? `INV ${stop.invoices[0].invoice.invoiceNumber} · ${stop.invoices[0].invoice.vendor || ''}`
                : `${invCount} INVOICES · ${stop.invoices.map(e => `INV ${e.invoice.invoiceNumber}`).slice(0, 3).join(' · ')}${invCount > 3 ? ` +${invCount - 3}` : ''}`;
              const isDragged = draggedKey === stop.key;
              const isDropTarget = dragOverKey === stop.key && draggedKey && draggedKey !== stop.key;
              return (
                <div
                  key={stop.key}
                  data-stop-key={stop.key}
                  onClick={() => { if (!draggedKey) handleSelectStop(stop); }}
                  className={`relative border-b border-[#1a1a1a]/10 transition-colors cursor-pointer
                    ${stop.complete ? 'bg-[#5a8f3d]/10' : ''}
                    ${isDragged ? 'opacity-40' : 'hover:bg-[#e0e0e0]'}
                    ${isDropTarget ? 'border-t-2 border-t-[#1a1a1a]' : ''}`}
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
                      className="flex items-center justify-center px-2 -mr-1 text-[#1a1a1a]/40 hover:text-[#1a1a1a] cursor-grab active:cursor-grabbing select-none"
                      style={{ touchAction: 'none' }}
                      title="Drag to reorder"
                      aria-label="Drag to reorder"
                    >
                      <span className="text-[14px] leading-none">⋮⋮</span>
                    </div>

                    {/* Stop number badge — driver's route order */}
                    <div className="flex items-center text-[10px] font-mono opacity-50 mr-2 w-5 justify-end shrink-0">
                      {idx + 1}.
                    </div>

                    <div className="py-2.5 pr-3 flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] font-extrabold tracking-wide truncate flex items-center gap-1.5" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
                            {stop.customer}
                            {stop.isMerged && (
                              <span className="text-[8px] font-mono tracking-widest bg-[#0F62FE] text-white px-1 py-0.5">MERGED</span>
                            )}
                          </div>
                          <div className="text-[9px] opacity-60 font-mono mt-0.5 truncate">
                            {invSummary}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          {stop.complete ? (
                            <div className="text-[10px] font-bold text-[#5a8f3d] tracking-widest flex items-center gap-1">
                              <Check className="w-3.5 h-3.5" strokeWidth={3} /> READY
                            </div>
                          ) : stop.expected === 0 ? (
                            <div className="text-[10px] opacity-60 tracking-widest">— NO PARTS —</div>
                          ) : (
                            <div className="text-[10px] font-bold tracking-widest">
                              {stop.got}/{stop.expected}
                            </div>
                          )}
                          {stop.backOrdered > 0 && (
                            <div className="text-[8px] text-[#a83232] mt-0.5">{stop.backOrdered} B/O</div>
                          )}
                        </div>
                      </div>
                      {!stop.complete && stop.expected > 0 && (
                        <div className="h-0.5 bg-[#e0e0e0] mt-2 relative overflow-hidden">
                          <div
                            className="h-full bg-[#0F62FE] transition-all duration-300"
                            style={{ width: `${(stop.got / stop.expected) * 100}%` }}
                          ></div>
                        </div>
                      )}
                      {!stop.complete && stop.missing.length > 0 && (
                        <div className="text-[9px] opacity-70 mt-1.5 truncate">
                          Missing: {stop.missing.slice(0, 3).map(m => m.partNumber).join(', ')}
                          {stop.missing.length > 3 && ` +${stop.missing.length - 3}`}
                        </div>
                      )}
                      {/* Stop-management controls. The wrapping div stops the
                          click from bubbling to the parent (which would otherwise
                          navigate to the stop's invoice). */}
                      <div className="flex gap-3 mt-2 pt-2 border-t border-[#1a1a1a]/10" onClick={(e) => e.stopPropagation()}>
                        {stops.length > 1 && (
                          <button
                            onClick={() => setMergeFromKey(stop.key)}
                            className="text-[9px] tracking-widest opacity-50 hover:opacity-100 hover:text-[#1a1a1a]"
                          >
                            ⇄ MERGE INTO…
                          </button>
                        )}
                        {stop.isMerged && (
                          <button
                            onClick={() => onSplitStop(stop.key)}
                            className="text-[9px] tracking-widest opacity-50 hover:opacity-100 hover:text-[#a83232]"
                          >
                            ✕ SPLIT
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {anomalies.length > 0 && (
          <div className="border border-[#a83232]/40 bg-[#ffffff]">
            <div className="bg-[#a83232] text-white px-3 py-2 text-[11px] font-extrabold tracking-wider flex items-center gap-2" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
              <AlertTriangle className="w-3.5 h-3.5" />
              ANOMALIES · {anomalies.length}
            </div>
            <div className="max-h-48 overflow-y-auto">
              {anomalies.map((log, i) => (
                <div key={i} className="px-3 py-1.5 text-[10px] border-b border-[#1a1a1a]/10">
                  <div className="flex items-baseline gap-2">
                    <span className="opacity-50 font-mono">{log.ts}</span>
                    <span className="font-bold font-mono truncate flex-1">{log.partNumber}</span>
                    <StatusBadge status={log.status} />
                  </div>
                  {log.note && (
                    <div className="text-[9px] opacity-70 mt-0.5 ml-12">{log.note}</div>
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
          <div className="fixed inset-0 bg-[#1a1a1a]/70 flex items-center justify-center z-50 p-4" onClick={() => setMergeFromKey(null)}>
            <div className="bg-[#ffffff] border-2 border-[#1a1a1a] max-w-md w-full" onClick={(e) => e.stopPropagation()}>
              <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 text-[11px] font-extrabold tracking-wider flex items-center justify-between" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
                <span>MERGE STOP INTO…</span>
                <button onClick={() => setMergeFromKey(null)} className="opacity-70 hover:opacity-100">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="px-3 py-2 border-b border-[#1a1a1a]/20 bg-[#e0e0e0]">
                <div className="text-[9px] uppercase tracking-widest opacity-60">SOURCE</div>
                <div className="text-[12px] font-extrabold mt-0.5" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>{sourceStop.customer}</div>
                <div className="text-[9px] opacity-60 mt-0.5">
                  {sourceStop.invoices.length} invoice{sourceStop.invoices.length === 1 ? '' : 's'} will move into the target stop
                </div>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {targets.length === 0 && (
                  <div className="px-3 py-6 text-center text-[10px] opacity-60">
                    Only one stop loaded — nothing to merge into.
                  </div>
                )}
                {targets.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => { onMergeStops(sourceStop.key, t.key); setMergeFromKey(null); }}
                    className="w-full text-left px-3 py-2.5 border-b border-[#1a1a1a]/10 hover:bg-[#5a8f3d] hover:text-white transition-colors"
                  >
                    <div className="text-[12px] font-extrabold tracking-wide" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>{t.customer}</div>
                    <div className="text-[9px] opacity-60 mt-0.5">
                      {t.invoices.length} invoice{t.invoices.length === 1 ? '' : 's'} ·
                      {' '}{t.invoices.map(e => `INV ${e.invoice.invoiceNumber}`).slice(0, 3).join(' · ')}
                      {t.invoices.length > 3 && ` +${t.invoices.length - 3}`}
                    </div>
                  </button>
                ))}
              </div>
              <div className="px-3 py-2 border-t border-[#1a1a1a]/20 bg-[#e0e0e0] text-[9px] opacity-70">
                Tip: split a merged stop later from its card if you change your mind.
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
        <div className="fixed inset-0 bg-[#1a1a1a]/70 flex items-center justify-center z-50 p-4" onClick={() => setManualOpen(false)}>
          <div className="bg-[#ffffff] border-2 border-[#1a1a1a] max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 text-[11px] font-extrabold tracking-wider flex items-center justify-between" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
              <span>TYPE PART NUMBER</span>
              <button onClick={() => setManualOpen(false)} className="opacity-70 hover:opacity-100">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3">
              <div className="text-[10px] opacity-70 mb-2">
                For parts without a scannable barcode. Enter the number exactly as printed; case and dashes are normalized automatically.
              </div>
              <input
                value={manualValue}
                onChange={(e) => setManualValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleManualSubmit(); }}
                placeholder="e.g. 6510359AA"
                autoFocus
                className="w-full border border-[#1a1a1a]/40 bg-[#ffffff] px-2 py-2 text-[14px] outline-none focus:border-[#1a1a1a] font-mono"
              />
              <div className="flex gap-2 mt-3 justify-end">
                <button
                  onClick={() => { setManualValue(''); setManualOpen(false); }}
                  className="px-3 py-1.5 text-[10px] border border-[#1a1a1a] hover:bg-[#1a1a1a] hover:text-[#f4f4f4] font-bold tracking-widest"
                >
                  CANCEL
                </button>
                <button
                  onClick={handleManualSubmit}
                  disabled={!manualValue.trim()}
                  className="px-3 py-1.5 text-[10px] bg-[#1a1a1a] text-[#f4f4f4] font-bold tracking-widest hover:bg-[#5a8f3d] disabled:opacity-50 disabled:hover:bg-[#1a1a1a]"
                  style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
                >
                  SUBMIT
                </button>
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
          <div className="fixed inset-0 bg-[#1a1a1a]/70 flex items-center justify-center z-50 p-4" onClick={() => setReportOpen(false)}>
            <div className="bg-[#ffffff] border-2 border-[#1a1a1a] max-w-2xl w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className={`px-3 py-2 text-[11px] font-extrabold tracking-wider flex items-center justify-between ${allAccounted ? 'bg-[#5a8f3d] text-white' : 'bg-[#1a1a1a] text-[#f4f4f4]'}`} style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
                <span>SORT REPORT · {totalGot}/{totalExpected} UNITS</span>
                <button onClick={() => setReportOpen(false)} className="opacity-70 hover:opacity-100" aria-label="Close">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="overflow-y-auto flex-1">
                {allAccounted ? (
                  <div className="p-8 text-center">
                    <Check className="w-12 h-12 mx-auto mb-3 text-[#5a8f3d]" strokeWidth={3} />
                    <div className="text-[14px] font-extrabold tracking-widest mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
                      LANE READY TO LOAD
                    </div>
                    <div className="text-[10px] opacity-70">
                      Every unit on every stop is either scanned or marked not coming.
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="px-3 py-2 bg-[#e0e0e0] text-[10px] opacity-80 border-b border-[#1a1a1a]/20">
                      {missingByStop.reduce((s, st) => s + st.items.length, 0)} line(s) missing across {missingByStop.length} stop(s). Skip a line to mark it as not coming today.
                    </div>
                    {missingByStop.map(stop => (
                      <div key={stop.stopKey} className="border-b border-[#1a1a1a]/20">
                        <div className="px-3 py-2 bg-[#e0e0e0]/50">
                          <div className="text-[12px] font-extrabold tracking-wide" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>{stop.customer}</div>
                          <div className="text-[9px] opacity-60 mt-0.5">{stop.items.length} line(s) outstanding</div>
                        </div>
                        {stop.items.map(m => (
                          <div key={`${m.invIdx}-${m.itemIdx}`} className="px-3 py-2 border-t border-[#1a1a1a]/10 flex items-center gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="text-[11px] font-bold font-mono truncate">{m.partNumber}</div>
                              <div className="text-[9px] opacity-60 truncate">
                                {m.description !== 'PART' ? `${m.description} · ` : ''}INV {m.invoiceNumber}
                              </div>
                              <div className="text-[10px] mt-1">
                                <span className="font-bold">{m.scanned}/{m.expected}</span>
                                {m.skipped > 0 && <span className="opacity-60"> · {m.skipped} skipped</span>}
                                <span className="opacity-80 ml-1">— need {m.remaining} more</span>
                              </div>
                            </div>
                            <button
                              onClick={() => onSkipRemaining(m.invIdx, m.itemIdx)}
                              className="shrink-0 border border-[#1a1a1a] bg-[#ffffff] hover:bg-[#1a1a1a] hover:text-[#0F62FE] px-2 py-1 text-[10px] font-bold tracking-widest"
                              title="Mark the remaining units as not coming today"
                            >
                              SKIP {m.remaining}
                            </button>
                          </div>
                        ))}
                      </div>
                    ))}
                  </>
                )}
              </div>
              <div className="px-3 py-2 border-t border-[#1a1a1a]/20 bg-[#e0e0e0] flex justify-between items-center">
                <button
                  onClick={() => setReportOpen(false)}
                  className="px-3 py-1.5 text-[10px] border border-[#1a1a1a] hover:bg-[#1a1a1a] hover:text-[#f4f4f4] font-bold tracking-widest"
                >
                  ← BACK TO SCAN
                </button>
                {allAccounted && (
                  <button
                    onClick={() => { setReportOpen(false); onBack(); }}
                    className="px-3 py-1.5 text-[10px] bg-[#5a8f3d] text-white font-bold tracking-widest hover:bg-[#4a7a30]"
                  >
                    ✓ DONE — RETURN TO DASHBOARD
                  </button>
                )}
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
  const audioCtxRef = useRef(null);

  const beep = (frequency = 800, duration = 100) => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
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
  };

  const showFlash = (code, status) => {
    setFlashMessage({ code, status, ts: Date.now() });
    setTimeout(() => setFlashMessage(null), 1500);
  };

  const handleDetect = useCallback((code) => {
    const status = onScan(code, 'camera');
    beep(status === 'MATCHED' ? 880 : 400, status === 'MATCHED' ? 80 : 200);
    showFlash(code, status);
  }, [onScan]);

  const shipped = invoice.lineItems.filter(li => li.shipped > 0);
  const totalUnits = shipped.reduce((s, li) => s + li.unitsExpected, 0);
  const scannedUnits = shipped.reduce((s, li) => s + Math.min(li.unitsScanned || 0, li.unitsExpected), 0);
  const pct = totalUnits > 0 ? (scannedUnits / totalUnits) * 100 : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <div className="border border-[#1a1a1a] bg-[#ffffff]">
        <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 text-[11px] font-extrabold tracking-wider flex items-center justify-between" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
          <span>SCAN INTERFACE · INV {invoice.invoiceNumber}</span>
          <button onClick={onBack} className="opacity-70 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="relative">
          <BarcodeScanner onDetect={handleDetect} label="PART BARCODE · 1D/2D" autoStart />

          {flashMessage && (
            <div className={`absolute inset-0 flex items-center justify-center backdrop-blur-sm pointer-events-none z-10 ${flashMessage.status === 'MATCHED' ? 'bg-[#5a8f3d]/40' : 'bg-[#a83232]/40'}`}>
              <div className="bg-[#ffffff] border-2 border-[#1a1a1a] px-4 py-3 text-center">
                <div className="text-[10px] tracking-widest opacity-60">SCANNED</div>
                <div className="text-[14px] font-bold font-mono mt-1 break-all max-w-[280px]">{flashMessage.code}</div>
                <div className="mt-2"><StatusBadge status={flashMessage.status} /></div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <div className="border border-[#1a1a1a]/30 bg-[#ffffff]">
          <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 text-[11px] font-extrabold tracking-wider" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
            PROGRESS
          </div>
          <div className="p-3">
            <div className="flex items-baseline justify-between mb-2">
              <div>
                <span className="text-3xl font-extrabold leading-none" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>{scannedUnits}</span>
                <span className="text-lg opacity-50">/{totalUnits}</span>
                <span className="text-[10px] opacity-60 ml-2">UNITS</span>
              </div>
              <div className="text-[10px] uppercase tracking-wider opacity-60">{Math.round(pct)}% verified</div>
            </div>
            <div className="h-2 bg-[#e0e0e0] relative overflow-hidden">
              <div className="h-full bg-[#5a8f3d] transition-all duration-300" style={{ width: `${pct}%` }}></div>
            </div>
          </div>
        </div>

        <div className="border border-[#1a1a1a]/30 bg-[#ffffff]">
          <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 text-[11px] font-extrabold tracking-wider" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
            AWAITING SCAN
          </div>
          <div className="max-h-64 overflow-y-auto">
            {invoice.lineItems
              .filter(li => li.shipped > 0 && ((li.unitsScanned || 0) + (li.unitsSkipped || 0)) < li.unitsExpected)
              .map((item, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 px-3 py-2 text-[11px] border-b border-[#1a1a1a]/10 items-center">
                  <div className="col-span-1">
                    <div className="w-3 h-3 border border-[#1a1a1a]/40"></div>
                  </div>
                  <div className="col-span-7">
                    <div className="font-bold font-mono">{item.partNumber}</div>
                    <div className="text-[9px] opacity-60">{item.description}</div>
                  </div>
                  <div className="col-span-2 text-right text-[9px] opacity-70">
                    {(item.unitsScanned || 0)}/{item.unitsExpected}
                  </div>
                  <div className="col-span-2 text-right font-bold text-[10px]">${item.amount.toFixed(2)}</div>
                </div>
              ))}
            {invoice.lineItems.filter(li => li.shipped > 0 && ((li.unitsScanned || 0) + (li.unitsSkipped || 0)) < li.unitsExpected).length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] opacity-60">
                <Check className="w-6 h-6 mx-auto mb-1 text-[#5a8f3d]" strokeWidth={3} />
                <div className="font-bold">ALL UNITS VERIFIED</div>
                <div className="text-[9px] mt-1 opacity-70">Invoice ready for sign-off</div>
              </div>
            )}
          </div>
        </div>

        <div className="border border-[#1a1a1a]/30 bg-[#ffffff]">
          <div className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-2 text-[11px] font-extrabold tracking-wider" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
            SCAN LOG
          </div>
          <div className="max-h-48 overflow-y-auto">
            {scanLog.slice(0, 12).map((log, i) => (
              <div key={i} className="px-3 py-1.5 text-[10px] border-b border-[#1a1a1a]/10 grid grid-cols-12 gap-1 items-center">
                <span className="col-span-2 opacity-50 font-mono">{log.ts}</span>
                <span className="col-span-6 font-bold font-mono truncate">{log.partNumber}</span>
                <span className="col-span-4 text-right"><StatusBadge status={log.status} /></span>
              </div>
            ))}
            {scanLog.length === 0 && (
              <div className="px-3 py-4 text-[10px] opacity-50 text-center">No scans yet on this invoice</div>
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
function ManualInvoiceLookup({ onSubmit }) {
  const [val, setVal] = useState('');
  return (
    <div className="flex gap-1">
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && val.trim()) { onSubmit(val); setVal(''); } }}
        placeholder="Enter invoice number..."
        className="flex-1 border border-[#1a1a1a]/40 bg-[#ffffff] px-2 py-1.5 text-[12px] outline-none focus:border-[#1a1a1a] font-mono"
      />
      <button
        onClick={() => { if (val.trim()) { onSubmit(val); setVal(''); } }}
        className="bg-[#1a1a1a] text-[#f4f4f4] px-3 py-1.5 text-[11px] font-extrabold hover:bg-[#5a8f3d]"
        style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
      >
        LOOKUP
      </button>
    </div>
  );
}

function StatBox({ label, value, sub, accent }) {
  return (
    <div className="bg-[#ffffff] p-3">
      <div className="text-[9px] uppercase tracking-wider opacity-60 font-bold mb-1">{label}</div>
      <div className="text-2xl md:text-3xl font-extrabold leading-none" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: accent || undefined }}>{value}</div>
      <div className="text-[9px] uppercase tracking-wider opacity-50 mt-1.5">{sub}</div>
    </div>
  );
}

function InfoCell({ label, value, sub, mono }) {
  return (
    <div className="bg-[#ffffff] px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider opacity-60 font-bold">{label}</div>
      <div className={`text-[12px] font-bold mt-0.5 truncate ${mono ? 'font-mono' : ''}`}>{value}</div>
      {sub && <div className="text-[10px] opacity-60 mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

function StatusBadge({ status }) {
  const config = {
    MATCHED: { bg: '#5a8f3d', text: 'white', label: 'MATCH' },
    WRONG_LANE: { bg: '#a83232', text: 'white', label: 'DIFF STOP' },
    DUPLICATE: { bg: '#0F62FE', text: '#1a1a1a', label: 'DUPLICATE' },
    BACK_ORDER_ANOMALY: { bg: '#a83232', text: 'white', label: 'B/O ANOMALY' },
    SKIPPED: { bg: '#1a1a1a', text: '#0F62FE', label: 'SKIPPED' },
    UNKNOWN: { bg: '#1a1a1a', text: '#f4f4f4', label: 'UNKNOWN' }
  };
  const c = config[status] || config.UNKNOWN;
  return (
    <span className="inline-block px-1.5 py-0.5 text-[9px] font-bold tracking-wider whitespace-nowrap" style={{ backgroundColor: c.bg, color: c.text }}>
      {c.label}
    </span>
  );
}

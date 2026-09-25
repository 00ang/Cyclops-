/**
 * Pure Zeigler / CDK invoice parse helpers.
 * Extracted from PartsCheckInSystem.jsx so Node smoke tests can import them
 * without loading React / PDF.js / the browser. Behavior must stay identical.
 */

export function detectRouteReport(text) {
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
export function parseRouteReportRow(text) {
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

export function detectStore(text) {
  const headerArea = text.split('\n').slice(0, 12).join(' ');
  if (/ORLAND\s+PARK/i.test(headerArea) || /ZEIGLER\s+NISSAN/i.test(headerArea)) return 'orland_park';
  if (/KALAMAZOO/i.test(headerArea)) return 'kalamazoo';
  if (/GRANDVILLE/i.test(headerArea) && /ZEIGLER|AUTO\s+GROUP/i.test(headerArea)) return 'grandville';
  return 'unknown';
}

// Detect document format. Two distinct layouts exist:
//   - 'cdk_screen': CDK on-screen "CLOSED INVOICE" / "OPEN INVOICE" capture.
//                   Box-drawing characters, "Number:" label, OH/QS/BIN columns,
//                   Ford parts written with "*" as the segment separator.
//   - 'standard':   Printed dealer invoice (the Zeigler form factor).
export function detectFormat(text) {
  if (/\b(?:CLOSED|OPEN)\s+INVOICE\b/i.test(text)) return 'cdk_screen';
  if (/(?:^|\n)\s*Number\s*:\s*\d{6,7}/i.test(text)) return 'cdk_screen';
  if (/PART-NO\.?\s*[─\-]+\s*DESC/i.test(text)) return 'cdk_screen';
  return 'standard';
}

// Per-store templates. Each entry tells the parser:
//   - which invoice-number patterns to try (in priority order)
//   - which part-number patterns to try (in priority order)
//   - the canonical vendor / location strings
export const STORE_TEMPLATES = {
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
export const PART_NUMBER_REGEX = {
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

export function parseLineItems(lines, template = STORE_TEMPLATES.unknown) {
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


/** Normalize Ford/CDK asterisk separators to dashes for storage / matching. */
export function normalizePartNumber(part) {
  if (!part) return '';
  return String(part).replace(/\*/g, '-');
}

/**
 * Extract an invoice number from free text using labelled patterns first,
 * then per-template frequency scoring (same priority as parseInvoiceBlock).
 */
export function extractInvoiceNumber(text, template = STORE_TEMPLATES.unknown) {
  if (!text) return null;
  let invoiceNumber = null;
  const labelPatterns = [
    /\bINVOICE\s*(?:NUMBER|NO\.?|#)\s*[:.\-]?\s*(\d{6,7}(?:[A-Z]\d{1,2})?)\b/i,
    /\bINV\s*(?:NUMBER|NO\.?|#)\s*[:.\-]?\s*(\d{6,7}(?:[A-Z]\d{1,2})?)\b/i,
    /\bINVOICE\s*[:#]\s*(\d{6,7}(?:[A-Z]\d{1,2})?)\b/i,
    /\b(?:DOCUMENT|DOC)\s*(?:NUMBER|NO\.?|#)\s*[:.\-]?\s*(\d{6,7}(?:[A-Z]\d{1,2})?)\b/i,
    /(?:^|\n)\s*Number\s*[:.]?\s*(\d{6,7}(?:[A-Z]\d{1,2})?)\b/i
  ];
  for (const pat of labelPatterns) {
    const m = text.match(pat);
    if (m) { invoiceNumber = m[1].toUpperCase(); break; }
  }
  if (!invoiceNumber) {
    const counts = new Map();
    for (const pat of template.invoiceNumberPatterns) {
      const re = new RegExp(pat.source, 'gi');
      const matches = text.match(re) || [];
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
  if (!invoiceNumber) {
    for (const pat of template.invoiceNumberPatterns) {
      const m = text.match(pat);
      if (m) { invoiceNumber = m[1].toUpperCase(); break; }
    }
  }
  return invoiceNumber;
}

/** Turn plain text lines into the {y, items:[{str,x}]} shape parseLineItems expects. */
export function textLinesToParseLines(textLines) {
  return textLines.map((str, i) => {
    const y = 2000 - i * 14;
    const tokens = String(str).trim().split(/\s+/).filter(Boolean);
    return {
      y,
      items: tokens.map((tok, j) => ({ str: tok, x: j * 48, y, w: 40, h: 10 }))
    };
  });
}

/**
 * Smoke-friendly entry: detect store + format, extract invoice #, parse line items
 * from plain text lines (synthetic Zeigler-like fixtures).
 */
export function parseZeiglerTextLines(textLines) {
  const allText = textLines.join('\n');
  const store = detectStore(allText);
  const format = detectFormat(allText);
  const template = (store === 'unknown' && format === 'cdk_screen')
    ? STORE_TEMPLATES.ford_cdk
    : STORE_TEMPLATES[store];
  const invoiceNumber = extractInvoiceNumber(allText, template);
  const lines = textLinesToParseLines(textLines);
  const lineItems = parseLineItems(lines, template);
  return { store, format, vendor: template.vendor, location: template.location, invoiceNumber, lineItems };
}

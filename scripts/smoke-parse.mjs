#!/usr/bin/env node
/**
 * Regression smoke for Zeigler-tuned invoice parse helpers.
 * Runs against fixtures/zeigler-sample-lines.json — no PDF.js / React required.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseZeiglerTextLines,
  normalizePartNumber,
  parseRouteReportRow,
  detectRouteReport,
  extractInvoiceNumber,
  STORE_TEMPLATES
} from '../src/invoiceParse.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(root, 'fixtures', 'zeigler-sample-lines.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

let failed = 0;
const ok = (cond, msg) => {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    console.error(`  FAIL  ${msg}`);
    failed += 1;
  }
};

console.log(`Zeigler parse smoke · ${fixture.cases.length} cases`);
console.log(`STORE_TEMPLATES vendors: ${Object.values(STORE_TEMPLATES).map(t => t.vendor).join(' | ')}`);

for (const c of fixture.cases) {
  console.log(`\n[${c.id}]`);
  const exp = c.expected || {};

  if (c.routeReportRow) {
    const row = parseRouteReportRow(c.routeReportRow);
    ok(!!row, 'parseRouteReportRow returned a row');
    if (row && exp.route) {
      for (const [k, v] of Object.entries(exp.route)) {
        ok(row[k] === v, `route.${k} === ${JSON.stringify(v)} (got ${JSON.stringify(row[k])})`);
      }
    }
    ok(detectRouteReport('Account Name Invoice# Part Count Price Part#'), 'detectRouteReport header signature');
    continue;
  }

  if (exp.normalizePart) {
    const out = normalizePartNumber(exp.normalizePart.input);
    ok(out === exp.normalizePart.output, `normalizePartNumber(${exp.normalizePart.input}) → ${exp.normalizePart.output} (got ${out})`);
  }

  if (c.textLines && c.textLines.length) {
    const result = parseZeiglerTextLines(c.textLines);
    if (exp.store) ok(result.store === exp.store, `store === ${exp.store} (got ${result.store})`);
    if (exp.vendor) ok(result.vendor === exp.vendor, `vendor === ${exp.vendor} (got ${result.vendor})`);
    if (exp.invoiceNumber) {
      ok(result.invoiceNumber === exp.invoiceNumber, `invoiceNumber === ${exp.invoiceNumber} (got ${result.invoiceNumber})`);
      const extracted = extractInvoiceNumber(c.textLines.join('\n'), STORE_TEMPLATES[exp.store] || STORE_TEMPLATES.unknown);
      ok(extracted === exp.invoiceNumber, `extractInvoiceNumber === ${exp.invoiceNumber} (got ${extracted})`);
    }
    if (exp.parts) {
      ok(result.lineItems.length === exp.parts.length, `part count ${exp.parts.length} (got ${result.lineItems.length})`);
      for (let i = 0; i < exp.parts.length; i++) {
        const want = exp.parts[i];
        const got = result.lineItems[i];
        if (!got) {
          ok(false, `missing part[${i}] ${want.partNumber}`);
          continue;
        }
        ok(got.partNumber === want.partNumber, `part[${i}].partNumber === ${want.partNumber}`);
        ok(got.ordered === want.ordered, `part[${i}].ordered === ${want.ordered} (got ${got.ordered})`);
        ok(got.shipped === want.shipped, `part[${i}].shipped === ${want.shipped} (got ${got.shipped})`);
        ok(got.backOrdered === want.backOrdered, `part[${i}].backOrdered === ${want.backOrdered} (got ${got.backOrdered})`);
      }
    }
  }
}

// Guard: Zeigler STORE_TEMPLATES must not drift to non-Zeigler brands for Racine lanes.
ok(STORE_TEMPLATES.orland_park.vendor.includes('ZEIGLER'), 'orland_park vendor stays Zeigler');
ok(STORE_TEMPLATES.kalamazoo.vendor.includes('ZEIGLER'), 'kalamazoo vendor stays Zeigler');
ok(STORE_TEMPLATES.grandville.vendor.includes('ZEIGLER'), 'grandville vendor stays Zeigler');
ok(STORE_TEMPLATES.unknown.vendor.includes('ZEIGLER'), 'unknown vendor stays Zeigler');

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll parse smoke assertions passed.');

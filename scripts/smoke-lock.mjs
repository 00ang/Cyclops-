#!/usr/bin/env node
/**
 * Smoke for the route late-add / lock rules (src/routeLock.js).
 * Pure functions, device-local clock — no React required.
 */
import {
  CUTOFF_LABEL,
  cutoffTimestampFor,
  isPastCutoff,
  openRoute,
  isLocked,
  shouldAutoLock,
  openedAfterCutoff,
  lockRoute,
  applyAutoLock,
  checkingHasStarted,
  classifyAdd
} from '../src/routeLock.js';

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { console.error(`  FAIL  ${msg}`); failed += 1; }
};

// Local-time helper: today at hh:mm.
const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };

console.log(`Route lock smoke · cutoff ${CUTOFF_LABEL}`);

console.log('\n[cutoff arithmetic]');
const cutoff = cutoffTimestampFor(at(5, 30));
ok(new Date(cutoff).getHours() === 6 && new Date(cutoff).getMinutes() === 45, 'cutoffTimestampFor lands on 06:45 local');
ok(cutoffTimestampFor(at(23, 59)) === cutoff, 'same local day → same cutoff');
ok(!isPastCutoff(at(6, 44)), '06:44 is before cutoff');
ok(isPastCutoff(at(6, 45)), '06:45 is at/after cutoff');
ok(isPastCutoff(at(9, 0)), '09:00 is after cutoff');

console.log('\n[auto lock]');
const early = openRoute(at(5, 50));
ok(!isLocked(early), 'fresh route is not locked');
ok(!shouldAutoLock(early, at(6, 30)), 'route opened 05:50 does not auto-lock at 06:30');
ok(!shouldAutoLock(early, at(6, 44)), 'route opened 05:50 does not auto-lock at 06:44');
ok(shouldAutoLock(early, at(6, 45)), 'route opened 05:50 auto-locks at 06:45');
ok(shouldAutoLock(early, at(7, 10)), 'route opened 05:50 auto-locks when noticed at 07:10 (phone was asleep)');
const autoLocked = applyAutoLock(early, at(7, 10));
ok(isLocked(autoLocked), 'applyAutoLock produces a locked route');
ok(autoLocked.lock.reason === 'cutoff', 'auto lock reason is cutoff');
ok(autoLocked.lock.at === cutoff, 'auto lock is stamped at 06:45, not at the time it was noticed');
ok(applyAutoLock(early, at(6, 0)) === early, 'applyAutoLock returns the same object when not due');
ok(applyAutoLock(autoLocked, at(8, 0)) === autoLocked, 'applyAutoLock is a no-op on an already-locked route');

const lateStart = openRoute(at(7, 5));
ok(!shouldAutoLock(lateStart, at(7, 6)), 'route opened 07:05 (after cutoff) is not auto-locked on first upload');
ok(!shouldAutoLock(lateStart, at(11, 0)), 'route opened after cutoff never auto-locks that day');
ok(openedAfterCutoff(lateStart), 'route opened 07:05 is flagged as opened after cutoff');
ok(!openedAfterCutoff(early), 'route opened 05:50 is not flagged as opened after cutoff');

console.log('\n[manual lock]');
const manual = lockRoute(early, at(6, 20), 'manual');
ok(isLocked(manual) && manual.lock.reason === 'manual', 'manual lock at 06:20');
ok(lockRoute(manual, at(6, 30), 'manual') === manual, 'second lock is a no-op');
ok(!shouldAutoLock(manual, at(6, 45)), 'cutoff does not re-stamp a manually locked route');
ok(!isLocked(null), 'null route is not locked');
ok(lockRoute(null, at(6, 0), 'manual') === null, 'locking a null route stays null');

console.log('\n[late add classification]');
const li = (over) => ({ partNumber: 'X', shipped: 1, unitsExpected: 1, unitsScanned: 0, unitsSkipped: 0, checked: false, ...over });
const untouched = [{ invoiceNumber: '1', lineItems: [li(), li()] }];
const scannedOne = [{ invoiceNumber: '1', lineItems: [li({ unitsScanned: 1, checked: true }), li()] }];
const skippedOne = [{ invoiceNumber: '1', lineItems: [li({ unitsSkipped: 1, checked: true }), li()] }];
ok(!checkingHasStarted(untouched, []), 'no scans, no skips → checking not started');
ok(checkingHasStarted(scannedOne, []), 'a scanned unit → checking started');
ok(checkingHasStarted(skippedOne, []), 'a skipped unit → checking started');
ok(checkingHasStarted(untouched, [{ status: 'UNKNOWN' }]), 'a logged scan (even UNKNOWN) → checking started');

ok(classifyAdd(null, [], []) === 'open', 'first PDF of the day is a normal add');
ok(classifyAdd(early, untouched, []) === 'open', 'second PDF before any scanning is a normal add (not LATE ADD)');
ok(classifyAdd(early, scannedOne, []) === 'late', 'PDF after scanning started is a LATE ADD');
ok(classifyAdd(early, untouched, [{ status: 'MATCHED' }]) === 'late', 'PDF after a logged scan is a LATE ADD');
ok(classifyAdd(manual, scannedOne, []) === 'exception', 'PDF after manual lock is an exception');
ok(classifyAdd(autoLocked, untouched, []) === 'exception', 'PDF after cutoff lock is an exception even with no scans');
ok(classifyAdd(lateStart, scannedOne, []) === 'late', 'route opened after cutoff but unlocked → still a normal late add');

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll route lock smoke assertions passed.');

// Route open / late-add / lock rules for the morning dock.
//
// Pure helpers — no React, no storage — so the cutoff arithmetic can be
// smoke-tested in Node (scripts/smoke-lock.mjs) the same way the Zeigler
// parse helpers are.
//
// Vocabulary:
//   route      — today's session once the first invoice is loaded. It is
//                OPEN until it is locked; it never re-opens the same day.
//   late add   — an invoice added to an OPEN route after checking has
//                started (any scan / skip recorded). Its own lines start
//                unchecked; nothing already scanned is touched.
//   lock       — freezes the invoice set. Manual (driver taps LOCK) or
//                automatic when the device clock reaches the cutoff while
//                the route is open. Scanning keeps working after lock.
//   exception  — an invoice added after the lock. Never accepted silently:
//                the driver has to acknowledge the cutoff passed first.
//
// All times are the device's local clock. The dock runs on Chicago time,
// so the cutoff is labelled as a plain wall-clock time.

export const CUTOFF_HOUR = 6;
export const CUTOFF_MINUTE = 45;
export const CUTOFF_LABEL = '6:45 AM';

// Timestamp of the cutoff on the same local calendar day as `ts`.
export function cutoffTimestampFor(ts) {
  const d = new Date(ts);
  d.setHours(CUTOFF_HOUR, CUTOFF_MINUTE, 0, 0);
  return d.getTime();
}

export function isPastCutoff(now) {
  return now >= cutoffTimestampFor(now);
}

// A fresh route record, created on the first upload of the day.
export function openRoute(now) {
  return { openedAt: now, lock: null };
}

export function isLocked(route) {
  return !!(route && route.lock && Number.isFinite(route.lock.at));
}

// The automatic lock fires only when the clock *crosses* the cutoff while
// the route is open. A route that is first opened after the cutoff (late
// start, afternoon re-run) is not slammed shut on its first upload — the
// driver still has the manual LOCK control and the status strip says the
// route was opened past the cutoff.
export function shouldAutoLock(route, now) {
  if (!route || isLocked(route) || !Number.isFinite(route.openedAt)) return false;
  const cutoff = cutoffTimestampFor(route.openedAt);
  return route.openedAt < cutoff && now >= cutoff;
}

export function openedAfterCutoff(route) {
  if (!route || !Number.isFinite(route.openedAt)) return false;
  return route.openedAt >= cutoffTimestampFor(route.openedAt);
}

// reason: 'manual' | 'cutoff'
export function lockRoute(route, now, reason) {
  if (!route) return route;
  if (isLocked(route)) return route;
  return { ...route, lock: { at: now, reason } };
}

// Apply the automatic cutoff lock if it is due. Returns the same object
// when nothing changes so callers can use it inside a state setter without
// forcing a re-render.
export function applyAutoLock(route, now) {
  if (!shouldAutoLock(route, now)) return route;
  // Stamp the lock at the cutoff moment, not "whenever the timer noticed",
  // so a phone that was asleep at 6:45 still reports the lock at 6:45.
  return lockRoute(route, cutoffTimestampFor(route.openedAt), 'cutoff');
}

// Checking has started once any unit has been scanned or skipped on any
// line, or any scan has been logged. This is what turns a plain "add
// another PDF" into a LATE ADD — uploading the morning's five PDFs one
// after another before scanning is not a late add.
export function checkingHasStarted(invoices, scanLog) {
  if (Array.isArray(scanLog) && scanLog.length > 0) return true;
  if (!Array.isArray(invoices)) return false;
  return invoices.some(inv => Array.isArray(inv.lineItems) && inv.lineItems.some(li =>
    (li.unitsScanned || 0) > 0 || (li.unitsSkipped || 0) > 0 || li.checked === true
  ));
}

// How an incoming PDF should be treated against the current route.
//   'open'      — no route yet, or route open and no checking yet: normal add
//   'late'      — route open, checking started, not locked: LATE ADD
//   'exception' — route locked: must be acknowledged, never silent
export function classifyAdd(route, invoices, scanLog) {
  if (isLocked(route)) return 'exception';
  if (Array.isArray(invoices) && invoices.length > 0 && checkingHasStarted(invoices, scanLog)) return 'late';
  return 'open';
}

export function formatClock(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

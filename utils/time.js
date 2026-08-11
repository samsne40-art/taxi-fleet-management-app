'use strict';
/**
 * South Africa Standard Time utilities.
 * SAST = UTC+2, no daylight saving.
 * All SQLite timestamps are stored in UTC ("YYYY-MM-DD HH:MM:SS").
 * Use date(col, '+2 hours') in SQL to get the SAST date from a UTC timestamp.
 */

const TZ_OFFSET_MS = 2 * 60 * 60 * 1000; // 2 hours in ms

/** Returns a Date whose .getUTC*() fields represent the current SAST date/time. */
function saNow() {
  return new Date(Date.now() + TZ_OFFSET_MS);
}

/** Format a SAST Date as YYYY-MM-DD. */
function _str(sa) {
  return `${sa.getUTCFullYear()}-${String(sa.getUTCMonth() + 1).padStart(2, '0')}-${String(sa.getUTCDate()).padStart(2, '0')}`;
}

/** Today's SAST date as YYYY-MM-DD. */
function saToday() { return _str(saNow()); }

/**
 * Start of the current SAST week (Monday) as YYYY-MM-DD.
 * getUTCDay(): 0=Sun, 1=Mon, …, 6=Sat.
 */
function saWeekStart() {
  const sa  = saNow();
  const dow = sa.getUTCDay();
  const toMon = (dow === 0) ? 6 : dow - 1; // days back to Monday
  return _str(new Date(sa.getTime() - toMon * 86_400_000));
}

/** End of the current SAST week (Sunday) as YYYY-MM-DD. */
function saWeekEnd() {
  const start = new Date(saWeekStart() + 'T00:00:00Z');
  return _str(new Date(start.getTime() + 6 * 86_400_000));
}

/** First day of the current SAST month as YYYY-MM-DD. */
function saMonthStart() {
  const sa = saNow();
  return `${sa.getUTCFullYear()}-${String(sa.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** Last day of the current SAST month as YYYY-MM-DD. */
function saMonthEnd() {
  const sa = saNow();
  // Day 0 of the *next* month = last day of the current month
  const last = new Date(Date.UTC(sa.getUTCFullYear(), sa.getUTCMonth() + 1, 0));
  return _str(last);
}

/** Full English name of the current SAST month. */
function saMonthName() {
  const MONTHS = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December',
  ];
  return MONTHS[saNow().getUTCMonth()];
}

module.exports = { saToday, saWeekStart, saWeekEnd, saMonthStart, saMonthEnd, saMonthName };

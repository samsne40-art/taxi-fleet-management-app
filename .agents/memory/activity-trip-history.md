---
name: Activity / Trip History feature
description: Architecture and security decisions for the Activity/Trip History feature added to owner and driver dashboards.
---

## What was built
- Owner: new "📋 Activity" section in sidebar + control-centre grid → `section-activity` panel
- Driver: enhanced existing `historyCard` with period filter tabs (All/Today/Week/Month) and summary bar

## New API endpoints
- `GET /api/owner/:ownerId/trips` — extended with `offset` param; still returns array (backward-compat)
- `GET /api/owner/:ownerId/trips/summary` — returns `{total_trips, total_fare, cash_total, eft_total, other_total, avg_fare, cash_trips, eft_trips, other_trips}`
- `GET /api/driver/:driverId/trips` — extended with `offset` + `payment_method` filter; still returns array
- `GET /api/driver/:driverId/trips/summary` — same shape as owner summary

## Security rules
- All endpoints require session auth (`requireOwner` / `requireDriver`)
- `driver_id` and `taxi_id` filter params are positive-integer validated; ownership enforced via `WHERE owner_id=?` in SQL (parameterized)
- `payment_method` allowlisted to `['CASH','EFT','OTHER']`
- Date params validated with `/^\d{4}-\d{2}-\d{2}$/` regex; inverted ranges rejected with 400
- start_date must not be > end_date (400 if so)
- Non-integer driver_id/taxi_id rejected with 400
- Session userId used server-side; frontend-supplied IDs are never trusted for ownership

**Why:** The backend `buildOwnerTripFilters` / `buildDriverTripFilters` helpers centralize all validation so it cannot be bypassed.

## Pagination
- Default limit=50, max=200, offset=0 for owner Activity section
- Default limit=20 (TRIP_PAGE), offset via `histTripOffset` for driver history
- "Load more" appends next page using offset; shows/hides button based on whether a full page was returned

## SAST date helpers (client-side)
- `actGetSaToday/Yesterday/Week/Month()` in `owner/app.js`
- `histGetToday/Week/Month()` in `driver/app.js`
- Both mirror server `utils/time.js` using UTC+2 offset

## Files changed
- `routes/owner.js` — buildOwnerTripFilters helper, extended /trips, new /trips/summary
- `routes/driver.js` — buildDriverTripFilters helper, extended /trips, new /trips/summary
- `public/owner/index.html` — sidebar button, cc-card, section-activity panel, trip detail modal
- `public/owner/app.js` — SECTION_LOADERS entry, full activity section logic + trip cache + detail modal
- `public/driver/index.html` — filter tabs + summary bar added to historyCard
- `public/driver/app.js` — rewrote history block with offset pagination, tabs, summary
- `public/style.css` — activity section styles, trip detail modal styles, driver history bar styles
- `test_activity.js` — 81-test suite (new file)

## Test results
- test_activity.js: 81/81 passed
- test_all.js (existing): 97/97 passed (requires LOGIN_RATE_MAX=5 LOGIN_RATE_WINDOW_MS=5000)

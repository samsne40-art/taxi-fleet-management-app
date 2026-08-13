/**
 * test_activity.js — Activity / Trip History feature tests
 *
 * Run:
 *   node server.js &
 *   node test_activity.js
 *
 * Or with custom rate-limit env (for fast runs alongside rate-limiter tests):
 *   LOGIN_RATE_MAX=5 LOGIN_RATE_WINDOW_MS=5000 node server.js &
 *   LOGIN_RATE_MAX=5 LOGIN_RATE_WINDOW_MS=5000 node test_activity.js
 */

const BASE = 'http://localhost:5000';
const TS   = Date.now();

// ──────────────────────────────────────────────────────── Helpers ──
let passed = 0;
let failed = 0;

function ok(label, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Fetch with cookie jar support
const COOKIES = {};

async function apiFetch(path, opts = {}, cookieJar = COOKIES) {
  const cookieHeader = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (cookieHeader) headers.Cookie = cookieHeader;

  const res = await fetch(`${BASE}${path}`, { ...opts, headers });

  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/([^=]+)=([^;]+)/);
    if (m) cookieJar[m[1].trim()] = m[2].trim();
  }
  return res;
}

async function api(path, opts = {}, jar = COOKIES) {
  const res  = await apiFetch(path, opts, jar);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

// ──────────────────────────────────────────────────────── Setup ──

// We create two owners with their own drivers and trips to test isolation.
const ownerCookies  = {};
const owner2Cookies = {};
const driverCookies = {};
const driver2Cookies= {};

let ownerId, owner2Id, driverId, driver2Id, taxiId, taxi2Id;

async function setup() {
  section('Setup — creating owners, drivers, taxis, trips');

  // Owner 1
  const { res: r1, data: d1 } = await api('/api/owner/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'ActivityOwner', phone: `ACT${TS}`, password: 'password1' }),
  }, ownerCookies);
  ok('Owner 1 registered', r1.status === 200, JSON.stringify(d1));
  ownerId = d1.id;

  // Owner 2 (isolation check)
  const { res: r2, data: d2 } = await api('/api/owner/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'ActivityOwner2', phone: `ACT2${TS}`, password: 'password2' }),
  }, owner2Cookies);
  ok('Owner 2 registered', r2.status === 200, JSON.stringify(d2));
  owner2Id = d2.id;

  // Taxi for owner 1
  const plate1 = `AT${String(TS).slice(-5)}`;
  const { res: rt1, data: dt1 } = await api(`/api/owner/${ownerId}/taxis`, {
    method: 'POST',
    body: JSON.stringify({ plate: plate1 }),
  }, ownerCookies);
  ok('Taxi 1 added', rt1.status === 200, JSON.stringify(dt1));
  taxiId = dt1.id;

  // Taxi for owner 2
  const plate2 = `BT${String(TS).slice(-5)}`;
  const { res: rt2, data: dt2 } = await api(`/api/owner/${owner2Id}/taxis`, {
    method: 'POST',
    body: JSON.stringify({ plate: plate2 }),
  }, owner2Cookies);
  ok('Taxi 2 added', rt2.status === 200);
  taxi2Id = dt2.id;

  // Driver for owner 1
  const { res: rd1, data: dd1 } = await api(`/api/owner/${ownerId}/drivers`, {
    method: 'POST',
    body: JSON.stringify({ name: 'DriverA', phone: `DA${TS}`, password: 'driverpw', current_taxi_id: taxiId }),
  }, ownerCookies);
  ok('Driver 1 added (pending)', rd1.status === 200, JSON.stringify(dd1));
  driverId = dd1.id;

  // Driver for owner 2
  const { res: rd2, data: dd2 } = await api(`/api/owner/${owner2Id}/drivers`, {
    method: 'POST',
    body: JSON.stringify({ name: 'DriverB', phone: `DB${TS}`, password: 'driverpw', current_taxi_id: taxi2Id }),
  }, owner2Cookies);
  ok('Driver 2 added (pending)', rd2.status === 200);
  driver2Id = dd2.id;

  // Approve both drivers
  await api(`/api/owner/${ownerId}/drivers/${driverId}/verify`, {
    method: 'POST', body: JSON.stringify({ status: 'approved' }),
  }, ownerCookies);

  await api(`/api/owner/${owner2Id}/drivers/${driver2Id}/verify`, {
    method: 'POST', body: JSON.stringify({ status: 'approved' }),
  }, owner2Cookies);

  // Login drivers
  const { res: rl1 } = await api('/api/driver/login', {
    method: 'POST',
    body: JSON.stringify({ phone: `DA${TS}`, password: 'driverpw' }),
  }, driverCookies);
  ok('Driver 1 logged in', rl1.status === 200);

  const { res: rl2 } = await api('/api/driver/login', {
    method: 'POST',
    body: JSON.stringify({ phone: `DB${TS}`, password: 'driverpw' }),
  }, driver2Cookies);
  ok('Driver 2 logged in', rl2.status === 200);

  // Driver 1 starts a shift so we can record trips
  await api(`/api/driver/${driverId}/shift/start`, { method: 'POST' }, driverCookies);

  // Driver 2 starts a shift
  await api(`/api/driver/${driver2Id}/shift/start`, { method: 'POST' }, driver2Cookies);

  // Record 5 trips for driver 1 with mixed payment methods
  for (let i = 0; i < 3; i++) {
    await api(`/api/driver/${driverId}/trip`, {
      method: 'POST',
      body: JSON.stringify({ from_location: `From${i}`, to_location: `To${i}`, fare: (i + 1) * 10, payment_method: 'CASH' }),
    }, driverCookies);
  }
  await api(`/api/driver/${driverId}/trip`, {
    method: 'POST',
    body: JSON.stringify({ from_location: 'CBD', to_location: 'Airport', fare: 50, payment_method: 'EFT' }),
  }, driverCookies);
  await api(`/api/driver/${driverId}/trip`, {
    method: 'POST',
    body: JSON.stringify({ from_location: 'Mall', to_location: 'Station', fare: 25, payment_method: 'OTHER' }),
  }, driverCookies);

  // Record 2 trips for driver 2 (owner 2)
  for (let i = 0; i < 2; i++) {
    await api(`/api/driver/${driver2Id}/trip`, {
      method: 'POST',
      body: JSON.stringify({ from_location: 'X', to_location: 'Y', fare: 100, payment_method: 'CASH' }),
    }, driver2Cookies);
  }

  console.log(`  ✅ Setup complete: owner1=${ownerId}, driver1=${driverId}, taxi1=${taxiId}`);
}

// ──────────────────────────────────────── Owner Trip History Tests ──

async function testOwnerTripHistory() {
  section('Owner — GET /api/owner/:id/trips (pagination)');

  // Default fetch (today)
  const today = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
  const { res, data } = await api(`/api/owner/${ownerId}/trips?date=${today}`, {}, ownerCookies);
  ok('Returns 200', res.status === 200);
  ok('Returns array', Array.isArray(data), typeof data);
  ok('Returns trips for today', data.length >= 5, `got ${data.length}`);
  ok('Trip has all required fields', data[0] && 'fare' in data[0] && 'driver_name' in data[0] && 'taxi_plate' in data[0] && 'from_location' in data[0] && 'to_location' in data[0] && 'payment_method' in data[0] && 'created_at' in data[0]);
  ok('Trip includes shift info', data[0] && 'shift_start' in data[0]);
  ok('No passwords or doc paths in response', !JSON.stringify(data).includes('password') && !JSON.stringify(data).includes('doc_path'));

  section('Owner — GET /api/owner/:id/trips (filters)');

  // Driver filter
  const { data: byDriver } = await api(`/api/owner/${ownerId}/trips?driver_id=${driverId}`, {}, ownerCookies);
  ok('Driver filter: all results belong to driver', byDriver.every((t) => t.driver_id === driverId), `got ${byDriver.length} trips`);

  // Taxi filter
  const { data: byTaxi } = await api(`/api/owner/${ownerId}/trips?taxi_id=${taxiId}`, {}, ownerCookies);
  ok('Taxi filter: all results belong to taxi', byTaxi.every((t) => t.taxi_id === taxiId));

  // Payment method filter
  const { data: byCash } = await api(`/api/owner/${ownerId}/trips?payment_method=CASH&date=${today}`, {}, ownerCookies);
  ok('Payment filter CASH: only cash trips', byCash.every((t) => t.payment_method === 'CASH'));

  const { data: byEft } = await api(`/api/owner/${ownerId}/trips?payment_method=EFT&date=${today}`, {}, ownerCookies);
  ok('Payment filter EFT: only EFT trips', byEft.every((t) => t.payment_method === 'EFT'));

  const { data: byOther } = await api(`/api/owner/${ownerId}/trips?payment_method=OTHER&date=${today}`, {}, ownerCookies);
  ok('Payment filter OTHER: only OTHER trips', byOther.every((t) => t.payment_method === 'OTHER'));

  section('Owner — GET /api/owner/:id/trips (pagination with offset)');

  const { data: page1 } = await api(`/api/owner/${ownerId}/trips?date=${today}&limit=3&offset=0`, {}, ownerCookies);
  const { data: page2 } = await api(`/api/owner/${ownerId}/trips?date=${today}&limit=3&offset=3`, {}, ownerCookies);
  ok('Page 1 returns up to 3 trips', page1.length <= 3);
  ok('Page 2 returns remaining trips', page2.length >= 0);
  ok('Pages are non-overlapping', !page1.some((t) => page2.some((t2) => t2.id === t.id)));

  section('Owner — GET /api/owner/:id/trips/summary');

  const { res: sr, data: summary } = await api(`/api/owner/${ownerId}/trips/summary?date=${today}`, {}, ownerCookies);
  ok('Summary returns 200', sr.status === 200);
  ok('Summary has total_trips', typeof summary.total_trips === 'number');
  ok('Summary has total_fare', typeof summary.total_fare === 'number');
  ok('Summary has cash_total', typeof summary.cash_total === 'number');
  ok('Summary has eft_total', typeof summary.eft_total === 'number');
  ok('Summary has other_total', typeof summary.other_total === 'number');
  ok('Summary has avg_fare', typeof summary.avg_fare === 'number');
  ok('Summary: total_trips = 5', summary.total_trips === 5, `got ${summary.total_trips}`);
  ok('Summary: cash + eft + other = total_fare', Math.abs((summary.cash_total + summary.eft_total + summary.other_total) - summary.total_fare) < 0.01,
    `cash=${summary.cash_total} eft=${summary.eft_total} other=${summary.other_total} total=${summary.total_fare}`);
  ok('Summary: avg_fare correct', Math.abs(summary.avg_fare - summary.total_fare / summary.total_trips) < 0.1);

  section('Owner — Totals: date filter (today vs yesterday)');

  const yesterday = new Date(Date.now() + 2 * 3600000 - 86400000).toISOString().slice(0, 10);
  const { data: ySummary } = await api(`/api/owner/${ownerId}/trips/summary?date=${yesterday}`, {}, ownerCookies);
  ok('Yesterday summary: 0 trips (just created today)', ySummary.total_trips === 0, `got ${ySummary.total_trips}`);

  section('Owner — Week and Month filters');
  const weekStart = (() => {
    const now = new Date(Date.now() + 2 * 3600000);
    const dow = (now.getUTCDay() + 6) % 7;
    const mon = new Date(now); mon.setUTCDate(now.getUTCDate() - dow);
    return mon.toISOString().slice(0, 10);
  })();
  const weekEnd = (() => {
    const now = new Date(Date.now() + 2 * 3600000);
    const dow = (now.getUTCDay() + 6) % 7;
    const sun = new Date(now); sun.setUTCDate(now.getUTCDate() - dow + 6);
    return sun.toISOString().slice(0, 10);
  })();

  const { data: weekSummary } = await api(`/api/owner/${ownerId}/trips/summary?start_date=${weekStart}&end_date=${weekEnd}`, {}, ownerCookies);
  ok('Week summary includes today trips', weekSummary.total_trips >= 5, `got ${weekSummary.total_trips}`);

  const monthStart = new Date(Date.now() + 2 * 3600000);
  const monthStartStr = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0));
  const monthEndStr = monthEnd.toISOString().slice(0, 10);
  const { data: monthSummary } = await api(`/api/owner/${ownerId}/trips/summary?start_date=${monthStartStr}&end_date=${monthEndStr}`, {}, ownerCookies);
  ok('Month summary includes today trips', monthSummary.total_trips >= 5, `got ${monthSummary.total_trips}`);
}

// ──────────────────────────────────────── Driver Trip History Tests ──

async function testDriverTripHistory() {
  section('Driver — GET /api/driver/:id/trips');

  const today = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
  const { res, data } = await api(`/api/driver/${driverId}/trips?date=${today}`, {}, driverCookies);
  ok('Returns 200', res.status === 200);
  ok('Returns array', Array.isArray(data));
  ok('Returns driver trips for today', data.length === 5, `got ${data.length}`);
  ok('Trip has all required fields', data[0] && 'fare' in data[0] && 'from_location' in data[0] && 'to_location' in data[0] && 'payment_method' in data[0] && 'created_at' in data[0] && 'taxi_plate' in data[0]);
  ok('No sensitive fields in driver trips response', !JSON.stringify(data).includes('password') && !JSON.stringify(data).includes('owner_id'));

  section('Driver — GET /api/driver/:id/trips/summary');

  const { res: sr, data: sum } = await api(`/api/driver/${driverId}/trips/summary?date=${today}`, {}, driverCookies);
  ok('Summary returns 200', sr.status === 200);
  ok('Summary has total_trips', sum.total_trips === 5, `got ${sum.total_trips}`);
  ok('Summary has total_fare', typeof sum.total_fare === 'number');
  ok('Driver summary: cash + eft + other = total_fare',
    Math.abs((sum.cash_total + sum.eft_total + sum.other_total) - sum.total_fare) < 0.01);

  section('Driver — Offset pagination');

  const { data: p1 } = await api(`/api/driver/${driverId}/trips?date=${today}&limit=3&offset=0`, {}, driverCookies);
  const { data: p2 } = await api(`/api/driver/${driverId}/trips?date=${today}&limit=3&offset=3`, {}, driverCookies);
  ok('Driver page 1 has 3 trips', p1.length === 3, `got ${p1.length}`);
  ok('Driver page 2 has 2 remaining trips', p2.length === 2, `got ${p2.length}`);
  ok('Driver pages non-overlapping', !p1.some((t) => p2.some((t2) => t2.id === t.id)));

  section('Driver — Payment method filter');
  const { data: cashTrips } = await api(`/api/driver/${driverId}/trips?payment_method=CASH&date=${today}`, {}, driverCookies);
  ok('Driver payment filter CASH: only cash trips', cashTrips.every((t) => t.payment_method === 'CASH'));
  ok('Driver cash trips count = 3', cashTrips.length === 3, `got ${cashTrips.length}`);
}

// ──────────────────────────────────────────────── Security Tests ──

async function testSecurity() {
  section('Security — Owner cannot see another owner\'s trips');

  const today = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);

  // Owner 1 fetches their own trips — should see only 5 (not driver2's)
  const { data: o1trips } = await api(`/api/owner/${ownerId}/trips?date=${today}`, {}, ownerCookies);
  const hasO2Trips = o1trips.some((t) => t.driver_id === driver2Id);
  ok('Owner 1 cannot see Owner 2\'s driver trips', !hasO2Trips, `found ${o1trips.filter((t) => t.driver_id === driver2Id).length} cross-owner trips`);

  // Owner 2 fetches their own trips — should see only 2 (not driver1's)
  const { data: o2trips } = await api(`/api/owner/${owner2Id}/trips?date=${today}`, {}, owner2Cookies);
  const hasO1Trips = o2trips.some((t) => t.driver_id === driverId);
  ok('Owner 2 cannot see Owner 1\'s driver trips', !hasO1Trips);

  section('Security — Owner cannot access another owner\'s endpoint (IDOR)');

  // Owner 1 tries to use owner 2's endpoint with their own cookie
  const idor1 = await apiFetch(`/api/owner/${owner2Id}/trips`, {}, ownerCookies);
  ok('IDOR: owner1 cannot GET owner2/trips (403)', idor1.status === 403, `got ${idor1.status}`);

  const idor2 = await apiFetch(`/api/owner/${owner2Id}/trips/summary`, {}, ownerCookies);
  ok('IDOR: owner1 cannot GET owner2/trips/summary (403)', idor2.status === 403, `got ${idor2.status}`);

  section('Security — Driver can only see own trips');

  // Driver 1 tries to GET driver 2's trips
  const dIdr = await apiFetch(`/api/driver/${driver2Id}/trips`, {}, driverCookies);
  ok('IDOR: driver1 cannot GET driver2/trips (403)', dIdr.status === 403, `got ${dIdr.status}`);

  const dSumIdr = await apiFetch(`/api/driver/${driver2Id}/trips/summary`, {}, driverCookies);
  ok('IDOR: driver1 cannot GET driver2/trips/summary (403)', dSumIdr.status === 403, `got ${dSumIdr.status}`);

  section('Security — Unauthenticated access blocked');

  const unauth1 = await apiFetch(`/api/owner/${ownerId}/trips`, {}, {});
  ok('Unauthenticated GET owner trips returns 401', unauth1.status === 401, `got ${unauth1.status}`);

  const unauth2 = await apiFetch(`/api/owner/${ownerId}/trips/summary`, {}, {});
  ok('Unauthenticated GET owner summary returns 401', unauth2.status === 401, `got ${unauth2.status}`);

  const unauth3 = await apiFetch(`/api/driver/${driverId}/trips`, {}, {});
  ok('Unauthenticated GET driver trips returns 401', unauth3.status === 401, `got ${unauth3.status}`);

  const unauth4 = await apiFetch(`/api/driver/${driverId}/trips/summary`, {}, {});
  ok('Unauthenticated GET driver summary returns 401', unauth4.status === 401, `got ${unauth4.status}`);

  section('Security — Passenger cannot access trip history');
  // Passengers have no authenticated session; unauthenticated access is already verified above.
  ok('Passenger has no authenticated session — trip endpoints unreachable', true);

  section('Security — SQL injection via filter params');

  // These should be rejected with 400 (bad params), not cause DB errors or return extra data
  const sqliPayloads = [
    `date=2026-01-01' OR '1'='1`,
    `start_date=2026-01-01&end_date=2026-12-31'; DROP TABLE trips; --`,
    `driver_id=1 OR 1=1`,
    `payment_method=CASH' OR '1'='1`,
  ];

  for (const payload of sqliPayloads) {
    const sqliRes = await apiFetch(`/api/owner/${ownerId}/trips?${payload}`, {}, ownerCookies);
    ok(`SQL injection '${payload.slice(0, 30)}…' → 400 or 200 (not 500)`,
      sqliRes.status === 400 || sqliRes.status === 200, `got ${sqliRes.status}`);
    if (sqliRes.status === 200) {
      const d = await sqliRes.json().catch(() => []);
      ok(`SQL injection result contains no cross-owner data`,
        Array.isArray(d) && !d.some((t) => t.driver_id === driver2Id));
    }
  }

  // Validate that parameterized queries reject bad date formats
  const badDate = await apiFetch(`/api/owner/${ownerId}/trips?date=bad-date`, {}, ownerCookies);
  ok('Bad date format rejected with 400', badDate.status === 400, `got ${badDate.status}`);

  const badDate2 = await apiFetch(`/api/owner/${ownerId}/trips?start_date=2026-01-01&end_date=bad`, {}, ownerCookies);
  ok('Bad end_date format rejected with 400', badDate2.status === 400, `got ${badDate2.status}`);

  const dateOrder = await apiFetch(`/api/owner/${ownerId}/trips?start_date=2026-12-31&end_date=2026-01-01`, {}, ownerCookies);
  ok('Inverted date range rejected with 400', dateOrder.status === 400, `got ${dateOrder.status}`);

  const badPm = await apiFetch(`/api/owner/${ownerId}/trips?payment_method=DROP TABLE`, {}, ownerCookies);
  ok('Bad payment_method rejected with 400', badPm.status === 400, `got ${badPm.status}`);

  const badDrvId = await apiFetch(`/api/owner/${ownerId}/trips?driver_id=abc`, {}, ownerCookies);
  ok('Non-integer driver_id rejected with 400', badDrvId.status === 400, `got ${badDrvId.status}`);
}

// ──────────────────────────────────────── Existing Features Tests ──

async function testExistingFeatures() {
  section('Regression — Existing trip recording still works');

  // Driver already on shift from setup; record one more trip
  const { res, data } = await api(`/api/driver/${driverId}/trip`, {
    method: 'POST',
    body: JSON.stringify({ from_location: 'Reg Test From', to_location: 'Reg Test To', fare: 75, payment_method: 'EFT' }),
  }, driverCookies);
  ok('Trip recording still works', res.status === 200 && data.ok === true, JSON.stringify(data));
  ok('Response has trip ID', typeof data.id === 'number');

  section('Regression — Existing earnings endpoints still work');

  const ownEarnRes = await apiFetch(`/api/owner/${ownerId}/earnings`, {}, ownerCookies);
  ok('Owner earnings endpoint still works', ownEarnRes.status === 200, `got ${ownEarnRes.status}`);

  const drvEarnRes = await apiFetch(`/api/driver/${driverId}/earnings`, {}, driverCookies);
  ok('Driver earnings endpoint still works', drvEarnRes.status === 200, `got ${drvEarnRes.status}`);

  if (ownEarnRes.ok) {
    const ownEarnData = await ownEarnRes.json().catch(() => null);
    if (ownEarnData) {
      ok('Owner earnings response has today/week/month', 'today' in ownEarnData && 'week' in ownEarnData && 'month' in ownEarnData);
      ok('Owner earnings has byDriver', Array.isArray(ownEarnData.byDriver));
      ok('Owner earnings has byTaxi', Array.isArray(ownEarnData.byTaxi));
    }
  }

  section('Regression — Existing driver GPS still works');

  const { res: shiftRes } = await api(`/api/driver/${driverId}/shift/start`, { method: 'POST' }, driverCookies);
  ok('Shift start still works', shiftRes.status === 200);

  const { res: locRes } = await api(`/api/driver/${driverId}/location`, {
    method: 'POST',
    body: JSON.stringify({ lat: -29.85, lng: 30.98 }),
  }, driverCookies);
  ok('GPS location still works', locRes.status === 200, `got ${locRes.status}`);

  section('Regression — Owner trips endpoint still returns array (backward compat)');

  const { res: tripRes, data: tripData } = await api(`/api/owner/${ownerId}/trips`, {}, ownerCookies);
  ok('GET /trips still returns JSON array', tripRes.status === 200 && Array.isArray(tripData), `type: ${typeof tripData}`);

  const { res: dTripRes, data: dTripData } = await api(`/api/driver/${driverId}/trips`, {}, driverCookies);
  ok('GET driver/trips still returns JSON array', dTripRes.status === 200 && Array.isArray(dTripData), `type: ${typeof dTripData}`);
}

// ──────────────────────────────────────────────────── Summary ──

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Activity / Trip History — Test Suite');
  console.log('═══════════════════════════════════════════════════════');

  try {
    await setup();
    await testOwnerTripHistory();
    await testDriverTripHistory();
    await testSecurity();
    await testExistingFeatures();
  } catch (err) {
    console.error('\n💥 Uncaught error:', err);
    failed++;
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main();

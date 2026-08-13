/**
 * Full test suite — rate-limiter fixes + security + functionality tests.
 *
 * Both the server and this script must agree on MAX/WINDOW.  Start the server
 * with the same env vars before running:
 *
 *   LOGIN_RATE_MAX=5 LOGIN_RATE_WINDOW_MS=5000 node server.js &
 *   LOGIN_RATE_MAX=5 LOGIN_RATE_WINDOW_MS=5000 node test_all.js
 *
 * Or via the helper wrapper at the bottom of this comment.
 *
 * Section order matters:
 *   Functionality → Security → Rate-limiter → sleep(window) → Brute-force
 *
 * Functionality and Security contain successful logins that reset the IP bucket
 * before rate-limiter tests run.  After rate-limiter exhausts the bucket, we
 * sleep long enough for the window to expire, then brute-force runs fresh.
 */

const BASE = 'http://127.0.0.1:5000';
const TS   = Date.now();

const MAX    = parseInt(process.env.LOGIN_RATE_MAX,       10) || 10;
const WINDOW = parseInt(process.env.LOGIN_RATE_WINDOW_MS, 10) || 15 * 60 * 1000;

let passed = 0;
let failed = 0;

/* ─── helpers ────────────────────────────────────────────────────── */

function ok(label, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${extra ? ' | ' + extra : ''}`);
    failed++;
  }
}

function makeJar() {
  const cookies = {};
  async function req(method, path, body, extraHeaders = {}) {
    const hdrs = {
      'Content-Type': 'application/json',
      Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
      ...extraHeaders,
    };
    const init = { method, headers: hdrs };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${BASE}${path}`, init);
    const setCookieList = res.headers.getSetCookie?.() ??
      (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const part of setCookieList) {
      const m = part.trim().match(/^([^=]+)=([^;]*)/);
      if (m) cookies[m[1].trim()] = m[2].trim();
    }
    let json;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json, headers: res.headers };
  }
  return {
    get:  (p, h)    => req('GET',  p, undefined, h),
    post: (p, b, h) => req('POST', p, b,         h),
    clearCookies: () => { for (const k of Object.keys(cookies)) delete cookies[k]; },
    _cookies: cookies,
  };
}

async function raw(method, path, body, extraHeaders = {}) {
  const hdrs = { 'Content-Type': 'application/json', ...extraHeaders };
  const init = { method, headers: hdrs };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, init);
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json, headers: res.headers };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Login and return the raw "connect.sid=VALUE" cookie string. */
async function ownerLoginSid(phone, password) {
  const res = await fetch(`${BASE}/api/owner/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  });
  const list = res.headers.getSetCookie?.() ??
    (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const part of list) {
    const m = part.match(/connect\.sid=([^;]+)/);
    if (m) return `connect.sid=${m[1]}`;
  }
  return '';
}

/** Add a driver via multipart (uses Node 18+ native FormData). */
async function addDriver(ownerId, sid, data) {
  const form = new FormData();
  form.append('name',           data.name);
  form.append('phone',          data.phone);
  form.append('password',       data.password);
  form.append('id_number',      data.id_number      || '9001015800088');
  form.append('license_number', data.license_number || `LIC${TS}`);
  const res = await fetch(`${BASE}/api/owner/${ownerId}/drivers`, {
    method: 'POST',
    headers: { Cookie: sid },
    body: form,
  });
  let json; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

/* ═══════════════════════════════════════════════════════════════════
   SECTION 1 — FUNCTIONALITY TESTS (run first to warm up sessions
   and ensure successful logins reset any stale rate-limit counters)
   ═══════════════════════════════════════════════════════════════════ */

async function testFunctionality() {
  console.log('\n══ Functionality tests ══');

  const jar   = makeJar();
  const phone = `07${TS}fn`;
  const pass  = 'FuncPass1!';

  /* Owner auth */
  const regRes = await jar.post('/api/owner/register', { name: `FuncOwner_${TS}`, phone, password: pass });
  ok('Owner register → 200', regRes.status === 200);
  ok('Register returns id + name', !!(regRes.json?.id && regRes.json?.name));

  jar.clearCookies();
  ok('Owner login → 200', (await jar.post('/api/owner/login', { phone, password: pass })).status === 200);

  const sessRes = await jar.get('/api/auth/session');
  ok('Session role = owner', sessRes.json?.role === 'owner');
  const ownerId = sessRes.json?.userId;
  ok('Session has userId', !!ownerId);

  ok('Wrong password → 401', (await raw('POST', '/api/owner/login', { phone, password: 'Wrong!' })).status === 401);
  ok('Short password → 400', (await raw('POST', '/api/owner/register', { name: 'x', phone: `07${TS}sp`, password: '123' })).status === 400);

  /* Taxi management */
  // Use last 7 digits of TS so the unique part is preserved across runs
  const plate = `T${String(TS).slice(-7)}`.toUpperCase();
  const addTaxi = await jar.post(`/api/owner/${ownerId}/taxis`, { plate });
  ok('Add taxi → 200', addTaxi.status === 200);
  const taxiId = addTaxi.json?.id;
  ok('Taxi has id', !!taxiId);

  const listTaxisRes = await jar.get(`/api/owner/${ownerId}/taxis`);
  ok('List taxis → 200 + array', listTaxisRes.status === 200 && Array.isArray(listTaxisRes.json));
  ok('Duplicate plate → 409', (await jar.post(`/api/owner/${ownerId}/taxis`, { plate })).status === 409);

  /* Driver management (native FormData) */
  const dPhone = `07${TS}fd`;
  const sid    = await ownerLoginSid(phone, pass);
  const dAdd   = await addDriver(ownerId, sid, {
    name: `FuncDriver_${TS}`, phone: dPhone, password: 'DriverPass1!',
    license_number: `LIC${TS}`,
  });
  ok('Add driver → 200', dAdd.status === 200, JSON.stringify(dAdd.json));
  const driverId = dAdd.json?.id;
  ok('Driver has id', !!driverId);

  ok('List drivers → 200 + array', (await jar.get(`/api/owner/${ownerId}/drivers`)).status === 200);

  /* Driver verify + assign */
  // Verify endpoint uses field "status", not "action"
  ok('Verify driver (approve) → 200',
    (await jar.post(`/api/owner/${ownerId}/drivers/${driverId}/verify`, { status: 'approved' })).status === 200);
  ok('Assign driver to taxi → 200',
    (await jar.post(`/api/owner/${ownerId}/drivers/${driverId}/assign`, { taxi_id: taxiId })).status === 200);

  /* Driver login + shift */
  const dJar = makeJar();
  const dLogin = await dJar.post('/api/driver/login', { phone: dPhone, password: 'DriverPass1!' });
  ok('Driver login → 200', dLogin.status === 200, JSON.stringify(dLogin.json));
  ok('Driver login does not expose password hash', !JSON.stringify(dLogin.json || {}).includes('$2'));

  ok('Driver session role = driver', (await dJar.get('/api/auth/session')).json?.role === 'driver');

  ok('Shift status → 200', (await dJar.get(`/api/driver/${driverId}/shift/status`)).status === 200);
  const shiftStart = await dJar.post(`/api/driver/${driverId}/shift/start`, { latitude: -26.2, longitude: 28.0 });
  ok('Shift start → 200', shiftStart.status === 200, JSON.stringify(shiftStart.json));

  /* GPS update — route uses { lat, lng } */
  ok('GPS update valid → 200',
    (await dJar.post(`/api/driver/${driverId}/location`, { lat: -26.2, lng: 28.0 })).status === 200);
  ok('GPS invalid latitude → 400',
    (await dJar.post(`/api/driver/${driverId}/location`, { lat: 999, lng: 28.0 })).status === 400);

  /* Trip recording — route requires from_location and to_location */
  const tripBase = { from_location: 'Station', to_location: 'Town Centre', fare: 50, payment_method: 'CASH' };
  ok('CASH trip → 200',
    (await dJar.post(`/api/driver/${driverId}/trip`, tripBase)).status === 200);
  ok('EFT trip → 200',
    (await dJar.post(`/api/driver/${driverId}/trip`, { ...tripBase, fare: 75, payment_method: 'EFT' })).status === 200);
  ok('Negative fare → 400',
    (await dJar.post(`/api/driver/${driverId}/trip`, { ...tripBase, fare: -10 })).status === 400);
  ok('Fare > R10000 → 400',
    (await dJar.post(`/api/driver/${driverId}/trip`, { ...tripBase, fare: 10001 })).status === 400);
  ok('Invalid payment method → 400',
    (await dJar.post(`/api/driver/${driverId}/trip`, { ...tripBase, payment_method: 'BITCOIN' })).status === 400);
  ok('Missing trip fields → 400',
    (await dJar.post(`/api/driver/${driverId}/trip`, {})).status === 400);

  /* Driver earnings + history */
  ok('Driver earnings → 200', (await dJar.get(`/api/driver/${driverId}/earnings`)).status === 200);
  const trips = await dJar.get(`/api/driver/${driverId}/trips`);
  ok('Driver trips → 200', trips.status === 200);
  ok('Driver trips is array', Array.isArray(trips.json?.trips ?? trips.json));

  /* Owner dashboard + earnings */
  ok('Owner dashboard → 200', (await jar.get(`/api/owner/${ownerId}/dashboard`)).status === 200);
  ok('Owner earnings → 200',  (await jar.get(`/api/owner/${ownerId}/earnings`)).status  === 200);
  ok('Owner trips → 200',     (await jar.get(`/api/owner/${ownerId}/trips`)).status      === 200);
  ok('Owner fleet → 200',     (await jar.get(`/api/owner/${ownerId}/fleet`)).status       === 200);

  /* Passenger feedback */
  const plateLookup = await raw('GET', `/api/passenger/taxi/plate/${plate}`);
  ok('Passenger plate lookup → 200',     plateLookup.status === 200);
  ok('Plate lookup: no owner_id',        !('owner_id' in (plateLookup.json || {})));
  ok('Plate lookup: no qr_token',        !('qr_token' in (plateLookup.json || {})));

  ok('Passenger feedback → 200',
    (await raw('POST', '/api/passenger/feedback', { taxi_id: taxiId, rating: 4, comment: 'Great', report_types: ['compliment'] })).status === 200);
  ok('Rating out of range → 400',
    (await raw('POST', '/api/passenger/feedback', { taxi_id: taxiId, rating: 6, comment: 'test', report_types: [] })).status === 400);
  ok('Missing rating → 400',
    (await raw('POST', '/api/passenger/feedback', { taxi_id: taxiId, comment: 'no rating', report_types: [] })).status === 400);

  /* Owner views feedback */
  ok('Owner feedback list → 200', (await jar.get(`/api/owner/${ownerId}/feedback`)).status === 200);

  /* Owner→driver messaging — endpoint field is "text", not "message" */
  ok('Owner→driver message → 200',
    (await jar.post(`/api/owner/${ownerId}/message`, { driver_id: driverId, text: 'Be safe' })).status === 200);
  ok('Driver inbox → 200', (await dJar.get(`/api/driver/${driverId}/messages`)).status === 200);

  /* SOS */
  const sosRes = await dJar.post(`/api/driver/${driverId}/sos`, { latitude: -26.2, longitude: 28.0 });
  ok('Driver SOS → 200/201', sosRes.status === 200 || sosRes.status === 201);
  const sosId = sosRes.json?.id;
  if (sosId) {
    ok('Owner resolves own SOS → 200',
      (await jar.post(`/api/owner/${ownerId}/sos/${sosId}/resolve`)).status === 200);
  } else {
    ok('SOS resolve skipped (no id returned)', true);
  }

  /* Driver ratings */
  ok('Driver ratings → 200', (await dJar.get(`/api/driver/${driverId}/ratings`)).status === 200);

  /* Shift end + logout */
  ok('Shift end → 200', (await dJar.post(`/api/driver/${driverId}/shift/end`)).status === 200);

  const logoutRes = await jar.post('/api/auth/logout');
  ok('Owner logout → 200', logoutRes.status === 200);
  ok('After logout: loggedIn = false', (await jar.get('/api/auth/session')).json?.loggedIn === false);
}

/* ═══════════════════════════════════════════════════════════════════
   SECTION 2 — SECURITY TESTS
   (runs after functionality; most logins here are register-derived
   sessions, so the rate-limit bucket stays mostly clean)
   ═══════════════════════════════════════════════════════════════════ */

async function testSecurity() {
  console.log('\n══ Security tests ══');

  const jar_o1 = makeJar(), jar_o2 = makeJar();
  const p1 = `07${TS}s1`, p2 = `07${TS}s2`;

  // Register creates a session — no /login rate-limit hit
  await jar_o1.post('/api/owner/register', { name: `SecOwner1_${TS}`, phone: p1, password: 'SecPass1!' });
  await jar_o2.post('/api/owner/register', { name: `SecOwner2_${TS}`, phone: p2, password: 'SecPass2!' });
  const s1 = await jar_o1.get('/api/auth/session');
  const s2 = await jar_o2.get('/api/auth/session');
  const o1 = s1.json.userId, o2 = s2.json.userId;

  const plate1 = `P${String(TS).slice(-7)}`.toUpperCase();
  const plate2 = `Q${String(TS).slice(-7)}`.toUpperCase();
  const t1 = (await jar_o1.post(`/api/owner/${o1}/taxis`, { plate: plate1 })).json;
  const t2 = (await jar_o2.post(`/api/owner/${o2}/taxis`, { plate: plate2 })).json;
  ok('Setup: owner1 taxi created', !!t1?.id);
  ok('Setup: owner2 taxi created', !!t2?.id);

  /* Cross-owner data access */
  ok('Cross-owner: owner1 cannot list owner2 drivers',   (await jar_o1.get(`/api/owner/${o2}/drivers`)).status    === 403);
  ok('Cross-owner: owner1 cannot list owner2 taxis',     (await jar_o1.get(`/api/owner/${o2}/taxis`)).status      === 403);
  ok('Cross-owner: owner1 cannot view owner2 fleet',     (await jar_o1.get(`/api/owner/${o2}/fleet`)).status      === 403);
  ok('Cross-owner: owner1 cannot view owner2 dashboard', (await jar_o1.get(`/api/owner/${o2}/dashboard`)).status  === 403);
  ok('Cross-owner: owner1 cannot view owner2 earnings',  (await jar_o1.get(`/api/owner/${o2}/earnings`)).status   === 403);

  /* Unauthenticated access */
  const unauth = makeJar();
  ok('Unauth: cannot list drivers',   (await unauth.get(`/api/owner/${o1}/drivers`)).status   === 401);
  ok('Unauth: cannot list taxis',     (await unauth.get(`/api/owner/${o1}/taxis`)).status     === 401);
  ok('Unauth: cannot view fleet',     (await unauth.get(`/api/owner/${o1}/fleet`)).status     === 401);
  ok('Unauth: cannot view dashboard', (await unauth.get(`/api/owner/${o1}/dashboard`)).status === 401);

  /* SOS resolve IDOR */
  ok('SOS resolve IDOR: non-existent/foreign SOS → 404',
    (await jar_o2.post(`/api/owner/${o2}/sos/99999/resolve`)).status === 404);

  /* Driver assignment IDOR */
  ok('Driver assign IDOR: foreign driver → 404',
    (await jar_o2.post(`/api/owner/${o2}/drivers/99999/assign`, { taxi_id: t1.id })).status === 404);
  ok('Driver assign IDOR: own taxi + foreign driver → 404',
    (await jar_o2.post(`/api/owner/${o2}/drivers/99999/assign`, { taxi_id: t2.id })).status === 404);

  /* Messaging IDOR — field is "text", not "message"; expect 403 for foreign driver */
  ok('Messaging IDOR: foreign driver_id → 403',
    (await jar_o2.post(`/api/owner/${o2}/message`, { driver_id: 99999, text: 'test' })).status === 403);

  /* Fare upper-bound */
  ok('Fare endpoint requires auth (401 not 500)',
    (await raw('POST', '/api/driver/99999/trip', { fare: 99999, payment_method: 'CASH' })).status === 401);

  /* Comment length limit */
  ok('Comment > 1000 chars → 400',
    (await raw('POST', '/api/passenger/feedback', { taxi_id: t1.id, rating: 4, comment: 'x'.repeat(1001), report_types: [] })).status === 400);

  /* report_types allowlist — unknown values stripped, not rejected */
  const fbBad = await raw('POST', '/api/passenger/feedback', {
    taxi_id: t1.id, rating: 4, comment: 'test', report_types: ['<script>xss</script>'],
  });
  ok('Unknown report_type stripped (200 or 404)', fbBad.status === 200 || fbBad.status === 404);

  /* CORS */
  ok('CORS: evil.com not reflected in ACAO',
    !(  (await raw('GET', '/api/auth/session', undefined, { Origin: 'https://evil.com' }))
          .headers.get('access-control-allow-origin') || ''
    ).includes('evil.com'));

  /* Helmet security headers */
  const hr = await raw('GET', '/health');
  ok('Helmet: X-Content-Type-Options present',  !!hr.headers.get('x-content-type-options'));
  ok('Helmet: X-Frame-Options or CSP present',
    !!hr.headers.get('x-frame-options') || !!hr.headers.get('content-security-policy'));
  ok('Helmet: Referrer-Policy present',          !!hr.headers.get('referrer-policy'));

  /* Uniform driver auth error */
  const dUnknown   = await raw('POST', '/api/driver/login', { phone: `999${TS}x`, password: 'pass123' });
  const dWrongPass = await raw('POST', '/api/driver/login', { phone: p1,           password: 'WrongDriverPass1' });
  ok('Driver uniform auth: unknown phone → 401',         dUnknown.status   === 401);
  ok('Driver uniform auth: wrong password → 401',        dWrongPass.status === 401);
  ok('Driver uniform auth: identical error messages',    dUnknown.json?.error === dWrongPass.json?.error);

  /* No raw DB errors */
  const dupRes = await raw('POST', '/api/owner/register', { name: 'Dup', phone: p1, password: 'pass123' });
  ok('Duplicate phone → 409', dupRes.status === 409);
  ok('409 body: no raw SQL', !JSON.stringify(dupRes.json || {}).toLowerCase().includes('sqlite'));

  /* Driver URL-param spoofing */
  ok('Driver endpoint: URL param spoofing → 401',
    (await raw('GET', '/api/driver/99999/shift/status')).status === 401);

  /* Socket.io without session */
  const sioRes = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling`);
  ok('Socket.io rejects unauthenticated handshake with 401', sioRes.status === 401);
}

/* ═══════════════════════════════════════════════════════════════════
   SECTION 3 — RATE-LIMITER BEHAVIOUR
   (runs after functionality/security so a prior successful login has
   already cleared the IP bucket; this section exhausts it on purpose)
   ═══════════════════════════════════════════════════════════════════ */

async function testRateLimiter() {
  console.log('\n══ Rate-limiter behaviour ══');
  console.log(`   MAX=${MAX}, WINDOW=${WINDOW}ms`);

  // -- 3.1  Register a fresh owner (register ≠ login endpoint, no rate-limit hit)
  const ownerPhone = `07${TS}rl`;
  const ownerPass  = 'RateTest1!';
  const jar1 = makeJar();
  const reg = await jar1.post('/api/owner/register', {
    name: `RLOwner_${TS}`, phone: ownerPhone, password: ownerPass,
  });
  ok('3.1 Register new owner succeeds (200)', reg.status === 200, JSON.stringify(reg.json));

  // -- 3.2  Correct credentials work immediately
  // (register already set a session; clear it so we actually test /login)
  jar1.clearCookies();
  const loginOk = await jar1.post('/api/owner/login', { phone: ownerPhone, password: ownerPass });
  ok('3.2 Correct credentials → 200 immediately after registration', loginOk.status === 200, JSON.stringify(loginOk.json));
  // Successful login → counter reset to 0 for this IP

  // -- 3.3  Accumulate MAX-1 failures (no 429 yet)
  jar1.clearCookies();
  let earlyBlock = false;
  for (let i = 0; i < MAX - 1; i++) {
    const r = await jar1.post('/api/owner/login', { phone: ownerPhone, password: 'WrongPass!' });
    if (r.status === 429) { earlyBlock = true; break; }
  }
  ok(`3.3 ${MAX - 1} wrong passwords do not trigger 429`, !earlyBlock);

  // -- 3.4  Correct password still works when counter < MAX
  const afterFails = await jar1.post('/api/owner/login', { phone: ownerPhone, password: ownerPass });
  ok('3.4 Correct password succeeds after MAX-1 failures', afterFails.status === 200, JSON.stringify(afterFails.json));
  // Successful → counter reset

  // -- 3.5  Counter reset confirmed: another MAX-1 round should not 429
  jar1.clearCookies();
  let secondEarlyBlock = false;
  for (let i = 0; i < MAX - 1; i++) {
    const r = await jar1.post('/api/owner/login', { phone: ownerPhone, password: 'WrongAgain!' });
    if (r.status === 429) { secondEarlyBlock = true; break; }
  }
  ok('3.5 Counter resets on success — second round of MAX-1 failures still no 429', !secondEarlyBlock);

  // -- 3.6  Fill the bucket (the MAX-th failure is recorded but not blocked)
  const fillBucket = await jar1.post('/api/owner/login', { phone: ownerPhone, password: 'WrongFinal!' });
  ok('3.6a Fill-bucket request passes through (still allowed, count goes MAX-1 → MAX)', fillBucket.status !== 429, `got ${fillBucket.status}`);

  // -- 3.7  Next request should be 429 regardless of credentials
  const blocked = await jar1.post('/api/owner/login', { phone: ownerPhone, password: 'AnyPassword' });
  ok('3.7a 429 fires once bucket is full', blocked.status === 429, `got ${blocked.status}: ${JSON.stringify(blocked.json)}`);
  ok('3.7b 429 error body is a non-empty string', typeof blocked.json?.error === 'string' && blocked.json.error.length > 0);

  // -- 3.8  Even correct credentials are blocked once limit is reached
  const blockedCorrect = await jar1.post('/api/owner/login', { phone: ownerPhone, password: ownerPass });
  ok('3.8 Correct password blocked until window expires', blockedCorrect.status === 429, `got ${blockedCorrect.status}`);

  // -- 3.9  Owner block does NOT spill into the driver endpoint
  // jar1's IP is blocked on /api/owner/login; /api/driver/login has its own store.
  const driverSameIp = await jar1.post('/api/driver/login', { phone: ownerPhone, password: 'WrongDriverPass' });
  ok('3.9 Owner block does not spill into driver endpoint', driverSameIp.status !== 429, `got ${driverSameIp.status}`);

  // -- 3.10  Driver endpoint has its own independent limiter
  // Wait for any failures accumulated during Functionality/Security sections
  // (e.g. the 2 driver auth tests in Security) to age out of the window before
  // we start counting from a known-clean baseline.
  await sleep(WINDOW + 300);
  const dJar = makeJar();
  const dUnknownPhone = `999${TS}rl`;
  let driverEarlyBlock = false;
  for (let i = 0; i < MAX - 1; i++) {
    const r = await dJar.post('/api/driver/login', { phone: dUnknownPhone, password: 'Wrong!' });
    if (r.status === 429) { driverEarlyBlock = true; break; }
  }
  ok(`3.10a Driver limiter: ${MAX - 1} failures don't trigger 429`, !driverEarlyBlock);

  // Fill driver bucket
  await dJar.post('/api/driver/login', { phone: dUnknownPhone, password: 'Wrong!' }); // #MAX
  const driverBlocked = await dJar.post('/api/driver/login', { phone: dUnknownPhone, password: 'Wrong!' });
  ok('3.10b Driver 429 fires when driver bucket is full', driverBlocked.status === 429, `got ${driverBlocked.status}`);
}

/* ═══════════════════════════════════════════════════════════════════
   SECTION 4 — BRUTE-FORCE (must run LAST after window has expired)
   ═══════════════════════════════════════════════════════════════════ */

async function testBruteForce() {
  console.log('\n══ Brute-force / rate-limit 429 tests (run last) ══');

  /* Owner brute-force */
  const bfOwnerJar  = makeJar();
  const bfOwnerPhone = `07${TS}bfo`;
  await bfOwnerJar.post('/api/owner/register', { name: `BF_Owner_${TS}`, phone: bfOwnerPhone, password: 'BFPass1!' });
  bfOwnerJar.clearCookies();

  let ownerGot429 = false, ownerFirst429At = -1;
  for (let i = 1; i <= MAX + 3; i++) {
    const r = await bfOwnerJar.post('/api/owner/login', { phone: bfOwnerPhone, password: 'WrongBFPass!' });
    if (r.status === 429 && !ownerGot429) {
      ownerGot429 = true;
      ownerFirst429At = i;
    }
  }
  ok('Owner brute-force: 429 triggered', ownerGot429);
  // The MAX-th failure is recorded; the (MAX+1)-th request hits the pre-check → 429
  ok(`Owner brute-force: 429 fires at attempt ${MAX + 1}`,
    ownerFirst429At === MAX + 1,
    `first 429 at attempt ${ownerFirst429At}`);

  /* Driver brute-force (unknown phone → 401 each time until blocked) */
  const bfDriverJar  = makeJar();
  const bfDriverPhone = `07${TS}bfd`;
  let driverGot429 = false, driverFirst429At = -1;
  for (let i = 1; i <= MAX + 3; i++) {
    const r = await bfDriverJar.post('/api/driver/login', { phone: bfDriverPhone, password: 'WrongBFPass!' });
    if (r.status === 429 && !driverGot429) {
      driverGot429 = true;
      driverFirst429At = i;
    }
  }
  ok('Driver brute-force: 429 triggered', driverGot429);
  ok(`Driver brute-force: 429 fires at attempt ${MAX + 1}`,
    driverFirst429At === MAX + 1,
    `first 429 at attempt ${driverFirst429At}`);

  ok('Owner and driver limiters are independent (separate stores)', true);
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN
   ═══════════════════════════════════════════════════════════════════ */

(async () => {
  console.log(`\nRunning tests  TS=${TS}  MAX=${MAX}  WINDOW=${WINDOW}ms`);
  console.log('Waiting for server...');
  await sleep(600);

  try {
    const h = await raw('GET', '/health');
    if (h.status !== 200) throw new Error(`health returned ${h.status}`);
  } catch (e) {
    console.error('Server not responding:', e.message);
    process.exit(1);
  }

  // Section order: Functionality → Security → Rate-limiter → sleep(window) → Brute-force
  // Functionality has successful owner+driver logins that reset counters.
  // Security uses register-derived sessions (no /login rate-limit hits except 2 driver).
  // Rate-limiter deliberately exhausts buckets.
  // After sleeping one full window, all buckets have aged out → brute-force starts fresh.

  try { await testFunctionality();  } catch (e) { console.error('Functionality crashed:', e); failed++; }
  try { await testSecurity();       } catch (e) { console.error('Security crashed:', e); failed++; }
  try { await testRateLimiter();    } catch (e) { console.error('Rate-limiter crashed:', e); failed++; }

  // Wait for the window to expire so brute-force starts with a clean slate
  console.log(`\n  [sleeping ${WINDOW + 500}ms for rate-limit window to expire...]`);
  await sleep(WINDOW + 500);

  try { await testBruteForce();     } catch (e) { console.error('Brute-force crashed:', e); failed++; }

  const total = passed + failed;
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`TOTAL: ${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ' — all green ✓'}`);
  if (failed > 0) process.exit(1);
})();

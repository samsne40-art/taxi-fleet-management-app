// ─── Driver state ─────────────────────────────────────────────────────────────
let driver = null;
let socket = null;

// GPS tracking state
let watchId = null;
let onShift = false;
let lastSentLat = null;
let lastSentLng = null;
let lastSentTime = 0;
let pendingLocation = null;
let sendRetryTimer = null;

const MIN_INTERVAL_MS = 30_000;
const MIN_DISTANCE_M  = 30;

// Trip entry state
let selectedPayment = 'CASH';

// History pagination & filter state
let tripHistoryLoaded = 0;
let histTripOffset    = 0;
let histTab           = 'all';
const TRIP_PAGE = 20;

// ─── SAST date/time helpers ───────────────────────────────────────────────────

const SA_OFFSET_MS = 2 * 60 * 60 * 1000; // UTC+2

const MONTHS_LONG  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Convert a UTC ISO string (stored in DB) to SAST display strings.
 * Returns { date: '11 August 2026', dateShort: '11 Aug 2026', time: '07:35' }
 */
function formatSADateTime(utcStr) {
  if (!utcStr) return { date: '—', dateShort: '—', time: '—' };
  const ms = new Date(utcStr).getTime() + SA_OFFSET_MS;
  const sa = new Date(ms);
  return {
    date:      `${sa.getUTCDate()} ${MONTHS_LONG[sa.getUTCMonth()]} ${sa.getUTCFullYear()}`,
    dateShort: `${sa.getUTCDate()} ${MONTHS_SHORT[sa.getUTCMonth()]} ${sa.getUTCFullYear()}`,
    time:      `${String(sa.getUTCHours()).padStart(2,'0')}:${String(sa.getUTCMinutes()).padStart(2,'0')}`,
  };
}

/**
 * Format a YYYY-MM-DD SAST date string (as returned by the earnings API)
 * to display strings.
 * Returns { long: '11 August 2026', short: '11 Aug 2026' }
 */
function formatSADate(ymd) {
  if (!ymd) return { long: '—', short: '—' };
  const [y, m, d] = ymd.split('-').map(Number);
  return {
    long:  `${d} ${MONTHS_LONG[m-1]} ${y}`,
    short: `${d} ${MONTHS_SHORT[m-1]} ${y}`,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function distanceMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function login() {
  const phone    = document.getElementById('loginPhone').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl    = document.getElementById('authError');
  errEl.classList.add('hidden');

  if (!phone || !password) {
    errEl.textContent = 'Phone and password are required.';
    errEl.classList.remove('hidden');
    return;
  }

  const res  = await fetch('/api/driver/login', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  });
  const data = await res.json();
  if (!res.ok) {
    errEl.textContent = data.error;
    errEl.classList.remove('hidden');
    return;
  }
  driver = data;
  boot();
}

async function logout() {
  stopWatching();
  if (onShift) {
    await fetch(`/api/driver/${driver.id}/shift/end`, { method: 'POST', credentials: 'include' });
  }
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.reload();
}

// ─── Session restore ──────────────────────────────────────────────────────────

async function restoreSession() {
  try {
    const res  = await fetch('/api/auth/session', { credentials: 'include' });
    const data = await res.json();
    if (!data.loggedIn || data.role !== 'driver') return;

    driver = { id: data.userId, name: data.name };
    boot();

    const sr   = await fetch(`/api/driver/${driver.id}/shift/status`, { credentials: 'include' });
    const sdata = await sr.json();
    if (sdata.onShift) {
      onShift = true;
      setShiftUI(true, sdata.taxiPlate);
      startWatching();
    }
  } catch (_) {
    // Network error — show login form
  }
}

// ─── App boot ─────────────────────────────────────────────────────────────────

function boot() {
  document.getElementById('authSection').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('driverName').textContent = `— ${escapeHtml(driver.name)}`;
  const backBtn = document.getElementById('backBtn');
  if (backBtn) backBtn.classList.add('hidden');

  socket = io({ withCredentials: true });
  socket.emit('join_driver_room', driver.id);
  socket.on('new_message', (msg) => prependMessage(msg));
  socket.on('verification_update', ({ status }) => {
    if (status !== 'approved') {
      stopWatching();
      alert(`Your account status has changed to: ${status.toUpperCase()}. You will be logged out.`);
      logout();
    }
  });
  socket.on('new_notification', (notif) => {
    driverNotifUnread++;
    updateDriverNotifBadge();
    prependDriverNotif(notif);
  });

  loadEarnings();
  loadTripHistory();
  loadRatings();
  loadMessages();
  loadDriverNotifications(false);
}

// ─── Shift ────────────────────────────────────────────────────────────────────

async function startShift() {
  document.getElementById('startBtn').disabled = true;
  const res  = await fetch(`/api/driver/${driver.id}/shift/start`, {
    method: 'POST', credentials: 'include',
  });
  const data = await res.json();
  document.getElementById('startBtn').disabled = false;

  if (!res.ok) {
    alert(data.error);
    return;
  }

  onShift = true;
  setShiftUI(true, data.plate);
  startWatching();
}

async function endShift() {
  stopWatching();
  const res = await fetch(`/api/driver/${driver.id}/shift/end`, {
    method: 'POST', credentials: 'include',
  });
  if (res.ok) {
    onShift = false;
    setShiftUI(false, null);
  }
}

function setShiftUI(active, plate) {
  const shiftBadge = document.getElementById('shiftStatus');
  const taxiInfo   = document.getElementById('taxiInfo');
  const startBtn   = document.getElementById('startBtn');
  const endBtn     = document.getElementById('endBtn');
  const recordBtn  = document.getElementById('recordTripBtn');

  shiftBadge.textContent = active ? 'ON DUTY'  : 'OFF DUTY';
  shiftBadge.className   = active ? 'badge online' : 'badge offline';

  if (active && plate) {
    taxiInfo.textContent = `🚐 Taxi: ${escapeHtml(plate)}`;
    taxiInfo.classList.remove('hidden');
  } else {
    taxiInfo.classList.add('hidden');
  }

  startBtn.classList.toggle('hidden', active);
  endBtn.classList.toggle('hidden', !active);

  // Show RECORD TRIP button only when on duty
  if (recordBtn) recordBtn.classList.toggle('hidden', !active);

  if (!active) {
    document.getElementById('locDetail').classList.add('hidden');
    document.getElementById('gpsStatus').textContent = 'INACTIVE';
    document.getElementById('gpsStatus').className   = 'badge offline';
    setLocMsg('');
  }
}

// ─── GPS tracking ─────────────────────────────────────────────────────────────

function startWatching() {
  if (!navigator.geolocation) {
    setLocMsg('⚠️ Geolocation not supported on this device/browser.');
    return;
  }

  setLocMsg('Requesting location permission…');

  watchId = navigator.geolocation.watchPosition(
    onPosition,
    onPositionError,
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
  );
}

function stopWatching() {
  if (watchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  clearTimeout(sendRetryTimer);
  pendingLocation = null;
  lastSentLat = null;
  lastSentLng = null;
  lastSentTime = 0;
}

function onPosition(pos) {
  if (!onShift) return;

  const { latitude: lat, longitude: lng, accuracy } = pos.coords;

  document.getElementById('gpsStatus').textContent = 'ACTIVE';
  document.getElementById('gpsStatus').className   = 'badge online';
  document.getElementById('locDetail').classList.remove('hidden');
  document.getElementById('locCoords').textContent  = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  document.getElementById('locAccuracy').textContent = ` ±${Math.round(accuracy)}m`;

  const now      = Date.now();
  const timeDiff = now - lastSentTime;
  const dist     = (lastSentLat != null)
    ? distanceMetres(lastSentLat, lastSentLng, lat, lng)
    : Infinity;

  if (timeDiff < MIN_INTERVAL_MS && dist < MIN_DISTANCE_M) return;

  pendingLocation = { lat, lng };
  sendLocation(lat, lng);
}

function onPositionError(err) {
  const msgs = {
    1: '⚠️ Location permission denied. Enable it in your browser settings.',
    2: '⚠️ Location unavailable — check GPS/signal.',
    3: '⚠️ Location request timed out — retrying…',
  };
  setLocMsg(msgs[err.code] || `⚠️ Location error: ${err.message}`);
  document.getElementById('gpsStatus').textContent = 'ERROR';
  document.getElementById('gpsStatus').className   = 'badge pending';
}

async function sendLocation(lat, lng) {
  clearTimeout(sendRetryTimer);
  try {
    const res = await fetch(`/api/driver/${driver.id}/location`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng }),
    });

    if (res.ok) {
      lastSentLat  = lat;
      lastSentLng  = lng;
      lastSentTime = Date.now();
      pendingLocation = null;
      setLocMsg('');
    } else {
      const d = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setLocMsg('⚠️ Shift no longer active. Please reload.');
      } else {
        setLocMsg(`⚠️ Server error: ${d.error || res.status}`);
      }
    }
  } catch (_) {
    pendingLocation = { lat, lng };
    setLocMsg('⚠️ No internet connection — will retry when back online…');
    sendRetryTimer = setTimeout(() => {
      if (onShift && pendingLocation) sendLocation(pendingLocation.lat, pendingLocation.lng);
    }, 15000);
  }
}

function setLocMsg(msg) {
  document.getElementById('locStatusMsg').textContent = msg;
}

// ─── Trip Modal ───────────────────────────────────────────────────────────────

function openTripModal() {
  // Reset form
  document.getElementById('tripFrom').value  = '';
  document.getElementById('tripTo').value    = '';
  document.getElementById('tripFare').value  = '';
  document.getElementById('tripError').classList.add('hidden');
  document.getElementById('tripSuccess').classList.add('hidden');
  document.getElementById('tripSubmitBtn').disabled    = false;
  document.getElementById('tripSubmitBtn').textContent = '✓ RECORD TRIP';
  setPayment('CASH');

  document.getElementById('tripModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('tripFrom').focus(), 150);
}

function closeTripModal() {
  document.getElementById('tripModal').classList.add('hidden');
}

function modalBackdropClick(e) {
  // Close only if user clicked the dark backdrop, not the sheet itself
  if (e.target === document.getElementById('tripModal')) closeTripModal();
}

function setPayment(method) {
  selectedPayment = method;
  document.getElementById('pmCash').classList.toggle('active',  method === 'CASH');
  document.getElementById('pmEft').classList.toggle('active',   method === 'EFT');
  document.getElementById('pmOther').classList.toggle('active', method === 'OTHER');
}

async function submitTrip() {
  const from  = document.getElementById('tripFrom').value.trim();
  const to    = document.getElementById('tripTo').value.trim();
  const fare  = document.getElementById('tripFare').value;
  const errEl = document.getElementById('tripError');
  const okEl  = document.getElementById('tripSuccess');
  const btn   = document.getElementById('tripSubmitBtn');

  errEl.classList.add('hidden');
  okEl.classList.add('hidden');

  // Client-side validation
  if (!from) {
    errEl.textContent = 'Starting point is required.';
    errEl.classList.remove('hidden');
    document.getElementById('tripFrom').focus();
    return;
  }
  if (!to) {
    errEl.textContent = 'Destination is required.';
    errEl.classList.remove('hidden');
    document.getElementById('tripTo').focus();
    return;
  }
  const fareNum = parseFloat(fare);
  if (!fare || isNaN(fareNum) || fareNum <= 0) {
    errEl.textContent = 'Fare must be a positive number.';
    errEl.classList.remove('hidden');
    document.getElementById('tripFare').focus();
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Saving…';

  try {
    const res  = await fetch(`/api/driver/${driver.id}/trip`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from_location:  from,
        to_location:    to,
        fare:           fareNum,
        payment_method: selectedPayment,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      errEl.textContent = data.error;
      errEl.classList.remove('hidden');
      btn.disabled    = false;
      btn.textContent = '✓ RECORD TRIP';
      return;
    }

    // Success — show confirmation, reset fields for next entry
    const rDisplay = fareNum.toFixed(0);
    okEl.textContent = `✅ Recorded — ${from} → ${to}  ·  R${rDisplay}  ·  ${selectedPayment}`;
    okEl.classList.remove('hidden');

    document.getElementById('tripFrom').value = '';
    document.getElementById('tripTo').value   = '';
    document.getElementById('tripFare').value = '';
    setPayment('CASH');

    btn.disabled    = false;
    btn.textContent = '✓ RECORD TRIP';

    // Refresh earnings and history silently in the background
    loadEarnings();
    loadTripHistory();

    // Auto-close modal after 2 s so driver can continue
    setTimeout(closeTripModal, 2000);

  } catch (_) {
    errEl.textContent = 'Network error — please check your connection and try again.';
    errEl.classList.remove('hidden');
    btn.disabled    = false;
    btn.textContent = '✓ RECORD TRIP';
  }
}

// ─── Passenger Ratings ────────────────────────────────────────────────────────

async function loadRatings() {
  try {
    const res = await fetch(`/api/driver/${driver.id}/ratings`, { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    renderRatings(data);
  } catch (_) { /* silent — network error */ }
}

function renderRatings(data) {
  const body = document.getElementById('ratingsBody');

  if (!data || !data.total_ratings) {
    body.innerHTML = '<p class="muted">No passenger ratings yet.</p>';
    return;
  }

  const avg    = data.avg_rating;
  const filled = Math.round(avg);
  const stars  = '★'.repeat(filled) + '☆'.repeat(5 - filled);

  const recentHtml = (data.recent || []).map((r) => {
    const s = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
    const { dateShort } = formatSADateTime(r.created_at);
    return `<div class="rating-item">
      <span class="rating-stars">${s}</span>
      ${r.comment ? `<span class="rating-comment">"${escapeHtml(r.comment)}"</span>` : ''}
      <span class="rating-date muted">${escapeHtml(dateShort)}</span>
    </div>`;
  }).join('');

  body.innerHTML = `
    <div class="rating-avg-row">
      <div class="rating-avg-stars">${stars}</div>
      <div class="rating-avg-num">${Number(avg).toFixed(1)}/5</div>
      <div class="muted" style="font-size:12px;margin-top:4px;">
        ${data.total_ratings} rating${data.total_ratings !== 1 ? 's' : ''}
      </div>
    </div>
    ${data.recent && data.recent.length
      ? `<h3 class="card-subh" style="margin:12px 0 8px;font-size:13px;">Recent feedback</h3>${recentHtml}`
      : ''}`;
}

// ─── Earnings ─────────────────────────────────────────────────────────────────

async function loadEarnings() {
  try {
    const res = await fetch(`/api/driver/${driver.id}/earnings`, { credentials: 'include' });
    if (!res.ok) return;
    const e = await res.json();

    // Today
    const todayFmt = formatSADate(e.today.date);
    document.getElementById('earnTodayDate').textContent  = todayFmt.long;
    document.getElementById('earnTodayTotal').textContent = 'R' + Number(e.today.total).toFixed(0);
    document.getElementById('earnTodayTrips').textContent = e.today.trips + (e.today.trips === 1 ? ' trip' : ' trips');

    // This week
    const ws = formatSADate(e.week.start);
    const we = formatSADate(e.week.end);
    document.getElementById('earnWeekDate').textContent  = `${ws.short} – ${we.short}`;
    document.getElementById('earnWeekTotal').textContent = 'R' + Number(e.week.total).toFixed(0);
    document.getElementById('earnWeekTrips').textContent = e.week.trips + (e.week.trips === 1 ? ' trip' : ' trips');

    // This month
    const ms = formatSADate(e.month.start);
    const me = formatSADate(e.month.end);
    document.getElementById('earnMonthDate').textContent  = `${e.month.name} · ${ms.short} – ${me.short}`;
    document.getElementById('earnMonthTotal').textContent = 'R' + Number(e.month.total).toFixed(0);
    document.getElementById('earnMonthTrips').textContent = e.month.trips + (e.month.trips === 1 ? ' trip' : ' trips');
  } catch (_) { /* silent — network error */ }
}

// ─── Trip History (with date filters & offset pagination) ─────────────────────

// SAST date helpers (mirrors server utils/time.js and owner/app.js)
const HIST_SA_OFFSET_MS = 2 * 60 * 60 * 1000;
function histSaNow() { return new Date(Date.now() + HIST_SA_OFFSET_MS); }
function histFmt(d) {
  const y   = d.getUTCFullYear();
  const m   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function histGetToday() { return histFmt(histSaNow()); }
function histGetWeek()  {
  const now = histSaNow();
  const dow = (now.getUTCDay() + 6) % 7; // Mon=0
  const mon = new Date(now); mon.setUTCDate(now.getUTCDate() - dow);
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  return { start: histFmt(mon), end: histFmt(sun) };
}
function histGetMonth() {
  const now = histSaNow();
  const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const e = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { start: histFmt(s), end: histFmt(e) };
}

function buildHistParams(offset) {
  const p = new URLSearchParams({ limit: TRIP_PAGE, offset: offset || 0 });
  if (histTab === 'today') {
    p.set('date', histGetToday());
  } else if (histTab === 'week') {
    const { start, end } = histGetWeek();
    p.set('start_date', start); p.set('end_date', end);
  } else if (histTab === 'month') {
    const { start, end } = histGetMonth();
    p.set('start_date', start); p.set('end_date', end);
  }
  return p;
}

function setHistTab(tab) {
  histTab = tab;
  ['All','Today','Week','Month'].forEach((t) => {
    const btn = document.getElementById(`histTab${t}`);
    if (btn) btn.classList.toggle('active', tab === t.toLowerCase());
  });
  histReload();
}

function histReload() {
  histTripOffset = 0;
  loadHistSummary();
  loadTripHistory();
}

async function loadHistSummary() {
  const bar = document.getElementById('histSummaryBar');
  if (histTab === 'all') { bar.classList.add('hidden'); return; }

  try {
    const p = buildHistParams(0);
    // Remove limit/offset for summary endpoint
    const sp = new URLSearchParams();
    if (p.get('date'))       sp.set('date', p.get('date'));
    if (p.get('start_date')) sp.set('start_date', p.get('start_date'));
    if (p.get('end_date'))   sp.set('end_date', p.get('end_date'));

    const res = await fetch(`/api/driver/${driver.id}/trips/summary?${sp}`, { credentials: 'include' });
    if (!res.ok) return;
    const s = await res.json();

    document.getElementById('histSumTrips').textContent = s.total_trips;
    document.getElementById('histSumTotal').textContent = Number(s.total_fare).toFixed(0);
    document.getElementById('histSumCash').textContent  = Number(s.cash_total).toFixed(0);
    document.getElementById('histSumEft').textContent   = Number(s.eft_total).toFixed(0);
    document.getElementById('histSumOther').textContent = Number(s.other_total).toFixed(0);
    bar.classList.remove('hidden');
  } catch (_) { /* silent */ }
}

async function loadTripHistory() {
  histTripOffset = 0;
  tripHistoryLoaded = TRIP_PAGE;
  const list = document.getElementById('tripHistoryList');
  const more = document.getElementById('loadMoreTripsBtn');
  list.innerHTML = '<p class="muted">Loading…</p>';
  more.classList.add('hidden');

  try {
    const res = await fetch(`/api/driver/${driver.id}/trips?${buildHistParams(0)}`, { credentials: 'include' });
    if (!res.ok) return;
    const trips = await res.json();
    renderTripHistory(trips, false);
  } catch (_) { /* silent */ }
}

async function loadMoreTrips() {
  histTripOffset += TRIP_PAGE;
  tripHistoryLoaded += TRIP_PAGE;
  try {
    const res = await fetch(`/api/driver/${driver.id}/trips?${buildHistParams(histTripOffset)}`, { credentials: 'include' });
    if (!res.ok) return;
    const trips = await res.json();
    renderTripHistory(trips, true);
  } catch (_) { /* silent */ }
}

function renderTripHistory(trips, append) {
  const list = document.getElementById('tripHistoryList');
  const more = document.getElementById('loadMoreTripsBtn');

  if (!append && (!trips || !trips.length)) {
    list.innerHTML = '<p class="muted">No trips recorded yet.</p>';
    more.classList.add('hidden');
    return;
  }

  const html = (trips || []).map((t) => {
    const { dateShort, time } = formatSADateTime(t.created_at);
    const pm = (t.payment_method || 'CASH').toLowerCase();
    return `
      <div class="trip-item">
        <div class="trip-item-hdr">
          <span class="trip-datetime">${escapeHtml(dateShort)} &middot; ${escapeHtml(time)}</span>
          <span class="trip-fare">R${Number(t.fare).toFixed(0)}</span>
        </div>
        <div class="trip-route">
          📍 <strong>${escapeHtml(t.from_location || '—')}</strong>
          <span class="trip-arrow">→</span>
          <strong>${escapeHtml(t.to_location || '—')}</strong>
        </div>
        <div class="trip-meta">
          🚐 ${escapeHtml(t.taxi_plate || '—')}
          &nbsp;&middot;&nbsp;
          <span class="badge-pay badge-pay-${pm}">${escapeHtml(t.payment_method || 'CASH')}</span>
        </div>
      </div>`;
  }).join('');

  if (append) {
    list.insertAdjacentHTML('beforeend', html);
  } else {
    list.innerHTML = html;
  }

  // Show "Load more" only if a full page was returned (meaning there may be more)
  more.classList.toggle('hidden', (trips || []).length < TRIP_PAGE);
}

// ─── Notifications ────────────────────────────────────────────────────────────

let driverNotifUnread = 0;
let driverNotifOffset = 0;
const DRIVER_NOTIF_PAGE = 20;

async function loadDriverNotifications(append = false) {
  try {
    const res  = await fetch(`/api/driver/${driver.id}/notifications?limit=${DRIVER_NOTIF_PAGE}&offset=${driverNotifOffset}`, { credentials: 'include' });
    const rows = await res.json();
    if (!Array.isArray(rows)) return;

    driverNotifOffset += rows.length;
    document.getElementById('driverNotifMoreBtn').classList.toggle('hidden', rows.length < DRIVER_NOTIF_PAGE);

    const list = document.getElementById('driverNotifList');
    if (!append) {
      list.innerHTML = '';
      // Count unread from fetched rows (first page)
      driverNotifUnread = rows.filter((n) => !n.is_read).length;
      updateDriverNotifBadge();
    }
    if (rows.length === 0 && !append) {
      list.innerHTML = '<p class="muted">No notifications yet.</p>';
      return;
    }
    rows.forEach((n) => appendDriverNotifRow(n, list));
  } catch (_) { /* silent */ }
}

async function loadMoreDriverNotifs() {
  await loadDriverNotifications(true);
}

function appendDriverNotifRow(n, listEl) {
  const list = listEl || document.getElementById('driverNotifList');
  const row  = document.createElement('div');
  row.className = 'notif-item' + (n.is_read ? '' : ' notif-unread');
  row.id = `dnotif-${n.id}`;
  const { dateShort, time } = formatSADateTime(n.created_at);
  let msgText = n.message;
  try {
    const parsed = JSON.parse(n.message);
    if (parsed && typeof parsed === 'object') msgText = parsed.details || n.message;
  } catch (_) { /* plain text */ }
  row.innerHTML = `
    <div class="notif-item-body">
      <div class="notif-title">${escapeHtml(n.title)}</div>
      <div class="notif-msg">${escapeHtml(msgText)}</div>
      <div class="notif-time">${escapeHtml(dateShort)} · ${escapeHtml(time)}</div>
    </div>
    ${n.is_read ? '' : `<button class="notif-read-btn" onclick="markDriverNotifRead(${n.id}, this)">✓</button>`}
  `;
  list.appendChild(row);
}

function prependDriverNotif(n) {
  const list = document.getElementById('driverNotifList');
  const empty = list.querySelector('p.muted');
  if (empty) empty.remove();

  const row  = document.createElement('div');
  row.className = 'notif-item notif-unread';
  row.id = `dnotif-${n.id}`;
  const { dateShort, time } = formatSADateTime(n.created_at);
  let msgText = n.message;
  try {
    const parsed = JSON.parse(n.message);
    if (parsed && typeof parsed === 'object') msgText = parsed.details || n.message;
  } catch (_) { /* plain text */ }
  row.innerHTML = `
    <div class="notif-item-body">
      <div class="notif-title">${escapeHtml(n.title)}</div>
      <div class="notif-msg">${escapeHtml(msgText)}</div>
      <div class="notif-time">${escapeHtml(dateShort)} · ${escapeHtml(time)}</div>
    </div>
    <button class="notif-read-btn" onclick="markDriverNotifRead(${n.id}, this)">✓</button>
  `;
  list.prepend(row);
}

async function markDriverNotifRead(notifId, btn) {
  try {
    const res = await fetch(`/api/driver/${driver.id}/notifications/${notifId}/read`, {
      method: 'POST', credentials: 'include',
    });
    if (!res.ok) return;
    const row = document.getElementById(`dnotif-${notifId}`);
    if (row) {
      row.classList.remove('notif-unread');
      if (btn) btn.remove();
    }
    if (driverNotifUnread > 0) driverNotifUnread--;
    updateDriverNotifBadge();
  } catch (_) { /* silent */ }
}

async function markAllDriverNotifsRead() {
  try {
    await fetch(`/api/driver/${driver.id}/notifications/read-all`, {
      method: 'POST', credentials: 'include',
    });
    driverNotifUnread = 0;
    updateDriverNotifBadge();
    document.getElementById('driverNotifList').querySelectorAll('.notif-item').forEach((r) => {
      r.classList.remove('notif-unread');
      const b = r.querySelector('.notif-read-btn');
      if (b) b.remove();
    });
  } catch (_) { /* silent */ }
}

function updateDriverNotifBadge() {
  const badge = document.getElementById('driverNotifBadge');
  if (badge) {
    badge.textContent = driverNotifUnread;
    badge.classList.toggle('hidden', driverNotifUnread <= 0);
  }
  const markBtn = document.getElementById('driverMarkAllBtn');
  if (markBtn) markBtn.style.display = driverNotifUnread > 0 ? '' : 'none';
}

// ─── Messages ─────────────────────────────────────────────────────────────────

async function loadMessages() {
  try {
    const res  = await fetch(`/api/driver/${driver.id}/messages`, { credentials: 'include' });
    const rows = await res.json();
    const list = document.getElementById('messages');
    list.innerHTML = rows.map((m) => {
      const { dateShort, time } = formatSADateTime(m.created_at);
      return `<div class="list-item">${escapeHtml(m.text)}<div class="muted">${escapeHtml(dateShort)} · ${escapeHtml(time)}</div></div>`;
    }).join('') || '<p class="muted">No messages yet.</p>';
  } catch (_) { /* silent */ }
}

function prependMessage(msg) {
  const list = document.getElementById('messages');
  const div  = document.createElement('div');
  div.className = 'list-item';
  const { dateShort, time } = formatSADateTime(new Date().toISOString());
  div.innerHTML = `${escapeHtml(msg.text)}<div class="muted">${escapeHtml(dateShort)} · ${escapeHtml(time)}</div>`;
  list.prepend(div);
}

// ─── SOS ──────────────────────────────────────────────────────────────────────

function sendSos() {
  const doSend = (lat, lng) => {
    fetch(`/api/driver/${driver.id}/sos`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng }),
    });
  };
  if (!navigator.geolocation) {
    doSend(null, null);
    alert('SOS sent (no GPS available).');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => { doSend(pos.coords.latitude, pos.coords.longitude); alert('SOS sent to your owner.'); },
    ()    => { doSend(null, null); alert('SOS sent (location unavailable).'); }
  );
}

// ─── Init ─────────────────────────────────────────────────────────────────────

restoreSession();

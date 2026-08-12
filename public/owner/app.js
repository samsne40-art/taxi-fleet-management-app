// ═══════════════════════════════════════════════════════════════ STATE ══
let owner = null;
let socket = null;

// Cached data shared across sections
let dashboardData = null;
let driversData   = null;

// Earnings section state
let earnTab         = 'today';
let earnData        = null;
let earnCustomStart = null;
let earnCustomEnd   = null;

// ════════════════════════════════════════════════════ SECTION NAVIGATION ══

let activeSection = null;

const SECTION_LOADERS = {
  overview:      enterOverview,
  taxis:         enterTaxis,
  drivers:       enterDrivers,
  fleet:         enterFleet,
  earnings:      enterEarnings,
  feedback:      enterFeedback,
  reports:       enterReports,
  notifications: enterNotifications,
  settings:      enterSettings,
};

function showSection(id) {
  document.getElementById('controlCentre').classList.add('hidden');
  document.querySelectorAll('.section-panel').forEach((p) => p.classList.add('hidden'));
  const panel = document.getElementById(`section-${id}`);
  if (panel) panel.classList.remove('hidden');
  activeSection = id;
  document.querySelectorAll('.snav-btn').forEach((b) => b.classList.remove('snav-active'));
  const sidebarBtn = document.querySelector(`.snav-btn[onclick="showSection('${id}')"]`);
  if (sidebarBtn) sidebarBtn.classList.add('snav-active');
  SECTION_LOADERS[id]?.();
}

function showHome() {
  document.querySelectorAll('.section-panel').forEach((p) => p.classList.add('hidden'));
  document.querySelectorAll('.snav-btn').forEach((b) => b.classList.remove('snav-active'));
  const cc = document.getElementById('controlCentre');
  cc.classList.remove('hidden');
  activeSection = null;
  refreshCCStats();
}

// ════════════════════════════════════════════════════════ AUTH / BOOT ══

function switchTab(which) {
  document.getElementById('tabLogin').classList.toggle('active', which === 'login');
  document.getElementById('tabRegister').classList.toggle('active', which === 'register');
  document.getElementById('loginForm').classList.toggle('hidden', which !== 'login');
  document.getElementById('registerForm').classList.toggle('hidden', which !== 'register');
  document.getElementById('authError').classList.add('hidden');
}

function showAuthError(msg) {
  const e = document.getElementById('authError');
  e.textContent = msg;
  e.classList.remove('hidden');
}

async function register() {
  const name     = document.getElementById('regName').value.trim();
  const phone    = document.getElementById('regPhone').value.trim();
  const password = document.getElementById('regPassword').value;
  if (!name || !phone || !password) return showAuthError('All fields are required.');
  const res  = await fetch('/api/owner/register', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, phone, password }),
  });
  const data = await res.json();
  if (!res.ok) return showAuthError(data.error);
  owner = data;
  boot();
}

async function login() {
  const phone    = document.getElementById('loginPhone').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!phone || !password) return showAuthError('Phone and password are required.');
  const res  = await fetch('/api/owner/login', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  });
  const data = await res.json();
  if (!res.ok) return showAuthError(data.error);
  owner = data;
  boot();
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.reload();
}

async function restoreSession() {
  try {
    const res  = await fetch('/api/auth/session', { credentials: 'include' });
    const data = await res.json();
    if (data.loggedIn && data.role === 'owner') {
      owner = { id: data.userId, name: data.name };
      boot();
    }
  } catch (_) { /* network error — show auth screen */ }
}

function boot() {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('ownerApp').classList.remove('hidden');

  document.getElementById('sidebarName').textContent  = owner.name;
  document.getElementById('ccName').textContent       = owner.name;
  document.getElementById('ccGreeting').textContent   = greeting();

  socket = io({ withCredentials: true });
  socket.emit('join_owner_room', owner.id);

  socket.on('location_update', (data) => { updateFleetRow(data); });
  socket.on('taxi_status', () => {
    loadFleet();
    if (activeSection === 'taxis')    loadTaxis();
    if (activeSection === 'overview') loadDashboard().then(renderOverview);
    if (activeSection === 'earnings') loadEarnings();
    refreshCCStats();
  });
  socket.on('new_feedback', (fb) => {
    if (activeSection === 'feedback') prependFeedback(fb);
  });
  socket.on('new_complaint', () => {
    if (activeSection === 'overview') loadDashboard().then(renderOverview);
    if (activeSection === 'feedback') loadFeedback();
  });
  socket.on('sos_alert', (alert) => {
    showSosBanner(alert);
    if (activeSection === 'notifications') renderNotifSos();
    setBadge('notifications', getActiveSosCount() + 1);
  });

  loadDashboard().then(() => { refreshCCStats(); });

  setInterval(() => { if (!owner) return; loadDashboard().then(() => refreshCCStats()); }, 15000);
  setInterval(() => { if (owner && activeSection === 'fleet') loadFleet(); }, 20000);

  const isDesktop = window.matchMedia('(min-width: 768px)').matches;
  if (isDesktop) { showSection('overview'); } else { showHome(); }
  window.matchMedia('(min-width: 768px)').addEventListener('change', (e) => {
    if (e.matches && !activeSection) showSection('overview');
  });
}

// ══════════════════════════════════════════════════ SECTION ENTRYPOINTS ══

async function enterOverview() {
  await loadDashboard();
  if (!driversData) await loadDrivers();
  renderOverview();
}

function renderOverview() {
  if (!dashboardData) return;
  const d = dashboardData;
  el('ovOnline').textContent   = d.taxisOnline;
  el('ovOffline').textContent  = d.taxisOffline;
  el('ovTotal').textContent    = d.totalTaxis;
  el('ovRating').textContent   = d.avgRating ? d.avgRating.toFixed(1) + '★' : '—';
  el('ovEarnToday').textContent  = 'R' + d.earnings.today.toFixed(0);
  el('ovEarnWeek').textContent   = 'R' + d.earnings.week.toFixed(0);
  el('ovEarnMonth').textContent  = 'R' + d.earnings.month.toFixed(0);
  // Today's trip count
  if (el('ovTripsToday')) {
    const n = d.earnings.tripsToday || 0;
    el('ovTripsToday').textContent = n + (n === 1 ? ' trip' : ' trips');
  }

  if (driversData) {
    const approved = driversData.filter((x) => x.verification_status === 'approved').length;
    const pending  = driversData.filter((x) => x.verification_status === 'pending').length;
    el('ovApproved').textContent  = approved;
    el('ovPendingNum').textContent = pending;
    el('ovPendingCard').classList.toggle('ov-card--amber', pending > 0);
    setBadge('drivers', pending);
  }

  if (d.expiringDocs && d.expiringDocs.length > 0) {
    el('ovExpiringWrap').classList.remove('hidden');
    el('ovExpiringList').innerHTML = d.expiringDocs.map((x) =>
      `<div class="list-item"><strong>${escapeHtml(x.name)}</strong>
       ${x.license_expiry ? `<span class="muted"> · Lic: ${x.license_expiry}</span>` : ''}
       ${x.pdp_expiry ? `<span class="muted"> · PDP: ${x.pdp_expiry}</span>` : ''}
      </div>`
    ).join('');
  } else {
    el('ovExpiringWrap').classList.add('hidden');
  }

  if (d.activeSos && d.activeSos.length > 0) {
    el('ovSosList').classList.remove('hidden');
    el('ovSosList').innerHTML = d.activeSos.map((a) =>
      `<div class="alert">🚨 SOS from <strong>${escapeHtml(a.driver_name)}</strong>
       ${a.lat ? ` — (${Number(a.lat).toFixed(4)}, ${Number(a.lng).toFixed(4)})` : ''}
       <button style="width:auto;display:inline-block;margin-left:8px;padding:4px 8px;" onclick="resolveSos(${a.id})">Mark resolved</button>
      </div>`
    ).join('');
  } else {
    el('ovSosList').classList.add('hidden');
  }
}

async function enterTaxis()  { await loadTaxis(); }

async function enterDrivers() {
  await loadTaxis();
  await loadDrivers();
}

function enterFleet() {
  setTimeout(() => {
    initMap();
    if (map) map.invalidateSize();
    loadFleet();
  }, 80);
}

// ── EARNINGS SECTION ─────────────────────────────────────────────────────────

async function enterEarnings() {
  // Populate filter dropdowns from cached data
  if (!driversData) await loadDrivers();
  if (!(window.__taxis || []).length) await loadTaxis();

  const drvSel  = el('earnFilterDriver');
  const taxiSel = el('earnFilterTaxi');

  drvSel.innerHTML = '<option value="">All drivers</option>' +
    (driversData || []).map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');

  taxiSel.innerHTML = '<option value="">All taxis</option>' +
    (window.__taxis || []).map((t) => `<option value="${t.id}">${escapeHtml(t.plate)}</option>`).join('');

  await loadEarnings();
}

function setEarnTab(tab) {
  earnTab = tab;
  ['Today','Week','Month','Custom'].forEach((t) => {
    const btn = el(`et${t}`);
    if (btn) btn.classList.toggle('active', tab === t.toLowerCase());
  });
  el('earnCustomPanel').classList.toggle('hidden', tab !== 'custom');
  if (tab !== 'custom') loadEarnings();
}

function applyEarnFilters() { loadEarnings(); }

function applyEarnCustom() {
  earnCustomStart = el('earnFromDate').value;
  earnCustomEnd   = el('earnToDate').value;
  if (!earnCustomStart || !earnCustomEnd) return;
  if (earnCustomStart > earnCustomEnd) { alert('Start date must be on or before end date.'); return; }
  loadEarnings();
}

async function loadEarnings() {
  const drvFilter  = el('earnFilterDriver')?.value || '';
  const taxiFilter = el('earnFilterTaxi')?.value   || '';

  const params = new URLSearchParams();
  if (drvFilter)  params.set('driver_id', drvFilter);
  if (taxiFilter) params.set('taxi_id',   taxiFilter);

  // For custom range, send the dates so the API computes breakdowns for that range
  if (earnTab === 'custom' && earnCustomStart && earnCustomEnd) {
    params.set('start_date', earnCustomStart);
    params.set('end_date',   earnCustomEnd);
  }
  // For today/week/month the API always returns those; breakdowns default to current month
  // which is fine — we show the correct summary from the returned period data.

  try {
    const res = await fetch(`/api/owner/${owner.id}/earnings?${params}`, { credentials: 'include' });
    if (!res.ok) return;
    earnData = await res.json();
    renderEarningsData();
    await loadEarnTrips();
  } catch (_) { /* silent — network error */ }
}

function renderEarningsData() {
  if (!earnData) return;

  // Determine which period to show in the summary card
  let period, label;
  if (earnTab === 'today') {
    period = earnData.today;
    label  = formatSADate(period.date).long;
  } else if (earnTab === 'week') {
    period = earnData.week;
    label  = `${formatSADate(period.start).short} – ${formatSADate(period.end).short}`;
  } else if (earnTab === 'month') {
    period = earnData.month;
    label  = `${period.name} · ${formatSADate(period.start).short} – ${formatSADate(period.end).short}`;
  } else {
    // custom — use period (which has the custom range if sent, else current month)
    period = earnData.period;
    label  = `${formatSADate(period.start).short} – ${formatSADate(period.end).short}`;
  }

  el('earnPeriodLbl').textContent = label;
  el('earnBigTotal').textContent  = 'R' + Number(period?.total || 0).toFixed(0);
  el('earnTripCount').textContent = period?.trips || 0;
  el('earnAvgFare').textContent   = 'R' + Number(period?.avg_fare || 0).toFixed(2);

  // Per-driver breakdown
  const bdEl = el('earnByDriver');
  if (earnData.byDriver?.length) {
    bdEl.innerHTML = `<table class="earn-table">
      <thead><tr><th>Driver</th><th>Trips</th><th>Total</th><th>Avg</th></tr></thead>
      <tbody>${earnData.byDriver.map((d) => `
        <tr>
          <td title="${escapeHtml(d.driver_name)}">${escapeHtml(d.driver_name)}</td>
          <td>${d.trips}</td>
          <td>R${Number(d.total).toFixed(0)}</td>
          <td>R${Number(d.avg_fare).toFixed(2)}</td>
        </tr>`).join('')}
      </tbody></table>`;
  } else {
    bdEl.innerHTML = '<p class="muted">No trips recorded for this period.</p>';
  }

  // Per-taxi breakdown
  const btEl = el('earnByTaxi');
  if (earnData.byTaxi?.length) {
    btEl.innerHTML = `<table class="earn-table">
      <thead><tr><th>Taxi</th><th>Trips</th><th>Total</th><th>Avg</th></tr></thead>
      <tbody>${earnData.byTaxi.map((t) => `
        <tr>
          <td title="${escapeHtml(t.taxi_plate)}">${escapeHtml(t.taxi_plate)}</td>
          <td>${t.trips}</td>
          <td>R${Number(t.total).toFixed(0)}</td>
          <td>R${Number(t.avg_fare).toFixed(2)}</td>
        </tr>`).join('')}
      </tbody></table>`;
  } else {
    btEl.innerHTML = '<p class="muted">No trips recorded for this period.</p>';
  }

  // Daily totals
  const dtEl = el('earnDailyTotals');
  if (earnData.dailyTotals?.length) {
    dtEl.innerHTML = `<table class="earn-table">
      <thead><tr><th>Date</th><th>Trips</th><th>Total</th></tr></thead>
      <tbody>${earnData.dailyTotals.map((d) => `
        <tr>
          <td>${formatSADate(d.sa_date).long}</td>
          <td>${d.trips}</td>
          <td>R${Number(d.total).toFixed(0)}</td>
        </tr>`).join('')}
      </tbody></table>`;
  } else {
    dtEl.innerHTML = '<p class="muted">No daily data for this period.</p>';
  }
}

async function loadEarnTrips() {
  const drvFilter  = el('earnFilterDriver')?.value || '';
  const taxiFilter = el('earnFilterTaxi')?.value   || '';

  const params = new URLSearchParams({ limit: '100' });
  if (drvFilter)  params.set('driver_id', drvFilter);
  if (taxiFilter) params.set('taxi_id',   taxiFilter);

  // Match trip list date range to active tab
  if (earnData) {
    if (earnTab === 'today') {
      params.set('date', earnData.today.date);
    } else if (earnTab === 'week') {
      params.set('start_date', earnData.week.start);
      params.set('end_date',   earnData.week.end);
    } else if (earnTab === 'month') {
      params.set('start_date', earnData.month.start);
      params.set('end_date',   earnData.month.end);
    } else if (earnTab === 'custom' && earnCustomStart && earnCustomEnd) {
      params.set('start_date', earnCustomStart);
      params.set('end_date',   earnCustomEnd);
    }
  }

  try {
    const res   = await fetch(`/api/owner/${owner.id}/trips?${params}`, { credentials: 'include' });
    if (!res.ok) return;
    const trips = await res.json();
    renderEarnTripList(trips);
  } catch (_) { /* silent */ }
}

function renderEarnTripList(trips) {
  const container = el('earnTripList');
  if (!trips?.length) {
    container.innerHTML = '<p class="muted">No trips recorded for this period.</p>';
    return;
  }
  container.innerHTML = trips.map((t) => {
    const { dateShort, time } = formatSADateTime(t.created_at);
    const pm = (t.payment_method || 'CASH').toLowerCase();
    return `
      <div class="trip-card">
        <div class="trip-card-hdr">
          <span class="trip-card-dt">${escapeHtml(dateShort)} · ${escapeHtml(time)}</span>
          <span class="trip-card-fare">R${Number(t.fare).toFixed(0)}</span>
        </div>
        <div class="trip-card-meta">
          <span>👤 ${escapeHtml(t.driver_name || '—')}</span>
          <span>🚐 ${escapeHtml(t.taxi_plate  || '—')}</span>
          <span class="badge-pay badge-pay-${pm}">${escapeHtml(t.payment_method || 'CASH')}</span>
        </div>
        <div class="trip-card-route">
          📍 <strong>${escapeHtml(t.from_location || '—')}</strong>
          <span style="color:var(--muted);margin:0 4px;">→</span>
          <strong>${escapeHtml(t.to_location || '—')}</strong>
        </div>
      </div>`;
  }).join('');
}

// ── Other sections ────────────────────────────────────────────────────────────

async function enterFeedback() { await loadFeedback(); }

async function enterReports() {
  if (!dashboardData) await loadDashboard();
  if (!driversData)   await loadDrivers();
  const d = dashboardData;
  el('repTotalTaxis').textContent  = d.totalTaxis;
  el('repComplaints').textContent  = d.complaints ? d.complaints.length : 0;
  if (driversData) {
    el('repApproved').textContent = driversData.filter((x) => x.verification_status === 'approved').length;
  }
  if (d.expiringDocs && d.expiringDocs.length > 0) {
    el('repExpiringWrap').classList.remove('hidden');
    el('repExpiringList').innerHTML = d.expiringDocs.map((x) =>
      `<div class="list-item"><strong>${escapeHtml(x.name)}</strong>
       ${x.license_expiry ? `<span class="muted"> · Lic exp: ${x.license_expiry}</span>` : ''}
       ${x.pdp_expiry     ? `<span class="muted"> · PDP exp: ${x.pdp_expiry}</span>` : ''}
      </div>`
    ).join('');
  } else {
    el('repExpiringWrap').classList.add('hidden');
  }
}

async function enterNotifications() {
  if (!dashboardData) await loadDashboard();
  renderNotifSos();
  if (!driversData) await loadDrivers();
}

function renderNotifSos() {
  if (!dashboardData) return;
  const list = el('notifSosList');
  if (!dashboardData.activeSos || dashboardData.activeSos.length === 0) {
    list.innerHTML = '<p class="muted">No active SOS alerts. ✅</p>';
    return;
  }
  list.innerHTML = dashboardData.activeSos.map((a) =>
    `<div class="alert">🚨 <strong>${escapeHtml(a.driver_name)}</strong>
     ${a.lat ? ` — GPS: ${Number(a.lat).toFixed(4)}, ${Number(a.lng).toFixed(4)}` : ''}
     <div class="muted" style="font-size:12px;margin-top:4px;">${formatSADateTime(a.created_at).dateShort + ' · ' + formatSADateTime(a.created_at).time}</div>
     <button style="width:auto;margin-top:6px;padding:4px 10px;" onclick="resolveSos(${a.id})">Mark resolved</button>
    </div>`
  ).join('');
}

function enterSettings() {
  el('settingsName').textContent  = owner.name;
  el('settingsPhone').textContent = owner.phone || '—';
}

// ═══════════════════════════════════════════════════ CONTROL CENTRE ══

function refreshCCStats() {
  if (!dashboardData) return;
  const d = dashboardData;
  el('ccOnline').textContent    = d.taxisOnline + ' / ' + d.totalTaxis;
  el('ccEarnToday').textContent = 'R' + d.earnings.today.toFixed(0);
  if (driversData) {
    const pending = driversData.filter((x) => x.verification_status === 'pending').length;
    el('ccPending').textContent = pending;
    setBadge('drivers', pending);
  } else {
    el('ccPending').textContent = '–';
  }
  const sosCount = (d.activeSos || []).length;
  setBadge('notifications', sosCount);
}

function setBadge(sectionId, count) {
  const ccBadge = document.getElementById(`cc-badge-${sectionId}`);
  if (ccBadge) {
    ccBadge.textContent = count;
    ccBadge.classList.toggle('hidden', count <= 0);
  }
  const snavBadge = document.getElementById(`snav-badge-${sectionId}`);
  if (snavBadge) {
    snavBadge.textContent = count;
    snavBadge.classList.toggle('hidden', count <= 0);
  }
}

function getActiveSosCount() {
  return (dashboardData?.activeSos || []).length;
}

// ═══════════════════════════════════════════════════════ LEAFLET MAP ══

let map = null;
let mapMarkers = {};

function initMap() {
  if (map) return;
  map = L.map('fleetMap').setView([-29.0, 25.0], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);
}

function updateMapMarker(row) {
  if (!map) return;
  if (!row.lat || !row.lng) {
    if (mapMarkers[row.driver_id]) {
      map.removeLayer(mapMarkers[row.driver_id]);
      delete mapMarkers[row.driver_id];
    }
    return;
  }
  const isOnline = row.taxi_status === 'online';
  const icon = L.divIcon({
    className: '',
    html: `<div style="background:${isOnline ? '#0a7d3c' : '#6b7280'};color:#fff;font-size:10px;font-weight:700;padding:3px 6px;border-radius:4px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.4);">🚐 ${escapeHtml(row.taxi_plate || '?')}</div>`,
    iconAnchor: [0, 0],
  });
  if (mapMarkers[row.driver_id]) {
    mapMarkers[row.driver_id].setLatLng([row.lat, row.lng]).setIcon(icon);
    mapMarkers[row.driver_id].getPopup().setContent(popupContent(row));
  } else {
    mapMarkers[row.driver_id] = L.marker([row.lat, row.lng], { icon })
      .bindPopup(popupContent(row)).addTo(map);
  }
}

function popupContent(row) {
  const { dateShort, time } = formatSADateTime(row.location_updated_at);
  const upd = row.location_updated_at ? `${dateShort} ${time}` : '—';
  return `<strong>${escapeHtml(row.driver_name)}</strong><br>Plate: ${escapeHtml(row.taxi_plate || '—')}<br>${row.lat ? `${parseFloat(row.lat).toFixed(5)}, ${parseFloat(row.lng).toFixed(5)}<br>` : ''}Last update: ${upd}`;
}

function fitMapToMarkers() {
  if (!map) return;
  const pts = Object.values(mapMarkers).map((m) => m.getLatLng()).filter((p) => p.lat && p.lng);
  if (pts.length > 0) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 14 });
}

// ═════════════════════════════════════════════════════════ LIVE FLEET ══

let fleetData = [];

async function loadFleet() {
  try {
    const res = await fetch(`/api/owner/${owner.id}/fleet`, { credentials: 'include' });
    if (!res.ok) return;
    fleetData = await res.json();
    renderFleet(fleetData);
    el('fleetUpdatedAt').textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;
  } catch (_) { /* network error — keep stale data */ }
}

function renderFleet(rows) {
  const list = el('fleetList');
  if (!rows.length) {
    list.innerHTML = '<p class="muted">No drivers registered yet.</p>';
    return;
  }
  list.innerHTML = `
    <table class="fleet-table">
      <thead><tr>
        <th>Status</th><th>Driver</th><th>Plate</th>
        <th>Latitude</th><th>Longitude</th><th>Updated</th><th>Shift started</th>
      </tr></thead>
      <tbody id="fleetTbody">${rows.map(renderFleetRow).join('')}</tbody>
    </table>`;
  rows.forEach(updateMapMarker);
  fitMapToMarkers();
}

function renderFleetRow(row) {
  const online = row.taxi_status === 'online';
  const badge  = online ? '<span class="badge online">🟢 ONLINE</span>' : '<span class="badge offline">🔴 OFFLINE</span>';
  const lat    = row.lat  != null ? Number(row.lat).toFixed(5)  : '—';
  const lng    = row.lng  != null ? Number(row.lng).toFixed(5)  : '—';
  const { time: updTime } = formatSADateTime(row.location_updated_at);
  const { time: shiftTime } = formatSADateTime(row.shift_start);
  const upd   = row.location_updated_at ? updTime  : '—';
  const shift = row.shift_start         ? shiftTime : '—';
  return `<tr id="fleet-row-${row.driver_id}" class="${online ? 'fleet-row-online' : ''}">
    <td>${badge}</td><td>${escapeHtml(row.driver_name)}</td><td>${escapeHtml(row.taxi_plate || '—')}</td>
    <td class="fleet-coord">${lat}</td><td class="fleet-coord">${lng}</td>
    <td class="muted">${upd}</td><td class="muted">${shift}</td>
  </tr>`;
}

function updateFleetRow(data) {
  const idx = fleetData.findIndex((r) => r.driver_id === data.driver_id);
  if (idx !== -1) {
    fleetData[idx].lat = data.lat;
    fleetData[idx].lng = data.lng;
    fleetData[idx].location_updated_at = data.updated_at;
  }
  const row = document.getElementById(`fleet-row-${data.driver_id}`);
  if (row) {
    const cells = row.querySelectorAll('td');
    if (cells[3]) cells[3].textContent = Number(data.lat).toFixed(5);
    if (cells[4]) cells[4].textContent = Number(data.lng).toFixed(5);
    if (cells[5]) cells[5].textContent = formatSADateTime(data.updated_at || new Date().toISOString()).time;
    row.classList.add('fleet-row-flash');
    setTimeout(() => row.classList.remove('fleet-row-flash'), 1200);
  }
  if (idx !== -1) updateMapMarker(fleetData[idx]);
  if (el('fleetUpdatedAt')) el('fleetUpdatedAt').textContent = `Last update: ${new Date().toLocaleTimeString()}`;
}

// ═══════════════════════════════════════════════════════ DASHBOARD ══

async function loadDashboard() {
  const res = await fetch(`/api/owner/${owner.id}/dashboard`, { credentials: 'include' });
  if (res.status === 401) { logout(); return; }
  dashboardData = await res.json();
  renderSosBanner();
  return dashboardData;
}

function renderSosBanner() {
  if (!dashboardData) return;
  const banner = el('sosBanner');
  banner.innerHTML = '';
  dashboardData.activeSos.forEach((a) => {
    const div = document.createElement('div');
    div.className = 'alert sos-banner-item';
    div.innerHTML = `🚨 SOS from <strong>${escapeHtml(a.driver_name)}</strong> — taxi #${a.taxi_id}${a.lat ? ` · GPS: ${Number(a.lat).toFixed(4)}, ${Number(a.lng).toFixed(4)}` : ''}
      <button onclick="resolveSos(${a.id})" style="width:auto;margin-left:8px;padding:4px 8px;">Mark resolved</button>`;
    banner.appendChild(div);
  });
}

function showSosBanner(alertData) {
  const banner = el('sosBanner');
  const div = document.createElement('div');
  div.className = 'alert sos-banner-item';
  div.textContent = `🚨 SOS from ${alertData.driver_name} — taxi #${alertData.taxi_id}${alertData.lat ? ` (${Number(alertData.lat).toFixed(4)}, ${Number(alertData.lng).toFixed(4)})` : ''}`;
  banner.prepend(div);
}

async function resolveSos(id) {
  await fetch(`/api/owner/${owner.id}/sos/${id}/resolve`, { method: 'POST', credentials: 'include' });
  await loadDashboard();
  if (activeSection === 'overview')      renderOverview();
  if (activeSection === 'notifications') renderNotifSos();
  refreshCCStats();
}

// ═══════════════════════════════════════════════════════════ TAXIS ══

async function addTaxi() {
  const plate = el('newPlate').value.trim();
  if (!plate) return;
  const res  = await fetch(`/api/owner/${owner.id}/taxis`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plate }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error);
  el('newPlate').value = '';
  const msg = el('addTaxiMsg');
  msg.textContent = `✅ Taxi ${data.plate} registered successfully.`;
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 4000);
  await loadTaxis();
  loadFleet();
}

async function loadTaxis() {
  const res   = await fetch(`/api/owner/${owner.id}/taxis`, { credentials: 'include' });
  const taxis = await res.json();
  el('taxiCount').textContent = taxis.length;
  const list = el('taxiList');
  list.innerHTML = taxis.map((t) => `
    <div class="list-item">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <strong>${escapeHtml(t.plate)}</strong>
        <span class="badge ${t.status}">${t.status}</span>
      </div>
      <div class="muted" style="margin-top:4px;">
        Driver: ${t.driver ? escapeHtml(t.driver.name) : 'Unassigned'}
      </div>
    </div>
  `).join('') || '<p class="muted">No taxis registered yet.</p>';

  window.__taxis = taxis;
  populateTaxiDropdowns();
}

function populateTaxiDropdowns() {
  const taxis = window.__taxis || [];
  const drvAssign = el('drvTaxiAssign');
  if (drvAssign) {
    const cv = drvAssign.value;
    drvAssign.innerHTML = '<option value="">— Unassigned —</option>' +
      taxis.map((t) => `<option value="${t.id}">${escapeHtml(t.plate)}</option>`).join('');
    drvAssign.value = cv;
  }
  document.querySelectorAll('.assign-select').forEach((sel) => {
    const cv = sel.value;
    sel.innerHTML = '<option value="">— Unassigned —</option>' +
      taxis.map((t) => `<option value="${t.id}">${escapeHtml(t.plate)}</option>`).join('');
    sel.value = cv;
  });
}

// ══════════════════════════════════════════════════════════ DRIVERS ══

async function addDriver() {
  const name     = el('drvName').value.trim();
  const phone    = el('drvPhone').value.trim();
  const password = el('drvPassword').value;
  const errEl    = el('drvError');
  errEl.classList.add('hidden');

  if (!name || !phone) { errEl.textContent = 'Name and phone are required.'; errEl.classList.remove('hidden'); return; }
  if (!password || password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.classList.remove('hidden'); return; }

  const fd = new FormData();
  fd.append('name', name); fd.append('phone', phone); fd.append('password', password);

  const idNumber      = el('drvIdNumber').value.trim();
  const licenseNo     = el('drvLicense').value.trim();
  const licenseExpiry = el('drvLicenseExpiry').value;
  const pdpNo         = el('drvPdp').value.trim();
  const pdpExpiry     = el('drvPdpExpiry').value;
  const taxiId        = el('drvTaxiAssign').value;

  if (idNumber)      fd.append('id_number', idNumber);
  if (licenseNo)     fd.append('license_no', licenseNo);
  if (licenseExpiry) fd.append('license_expiry', licenseExpiry);
  if (pdpNo)         fd.append('pdp_no', pdpNo);
  if (pdpExpiry)     fd.append('pdp_expiry', pdpExpiry);
  if (taxiId)        fd.append('current_taxi_id', taxiId);

  const licenseDoc = el('drvLicenseDoc').files[0];
  const pdpDoc     = el('drvPdpDoc').files[0];
  const selfie     = el('drvSelfie').files[0];
  if (licenseDoc) fd.append('license_doc', licenseDoc);
  if (pdpDoc)     fd.append('pdp_doc', pdpDoc);
  if (selfie)     fd.append('selfie', selfie);

  const res  = await fetch(`/api/owner/${owner.id}/drivers`, { method: 'POST', credentials: 'include', body: fd });
  const data = await res.json();
  if (!res.ok) { errEl.textContent = data.error; errEl.classList.remove('hidden'); return; }

  ['drvName','drvPhone','drvIdNumber','drvLicense','drvPdp'].forEach((id) => el(id).value = '');
  ['drvPassword','drvLicenseExpiry','drvPdpExpiry'].forEach((id) => el(id).value = '');
  ['drvLicenseDoc','drvPdpDoc','drvSelfie'].forEach((id) => el(id).value = '');
  el('drvTaxiAssign').value = '';

  el('drvFormBody').classList.add('hidden');
  el('drvFormToggle').textContent = '＋ Register a new driver';

  alert(`✅ Driver "${data.name}" registered. Status: PENDING — approve them from the list above.`);
  driversData = null;
  await loadDrivers();
  loadFleet();
  refreshCCStats();
}

async function loadDrivers() {
  const res = await fetch(`/api/owner/${owner.id}/drivers`, { credentials: 'include' });
  driversData = await res.json();
  el('driverCount').textContent = driversData.length;

  const list = el('driverList');
  list.innerHTML = driversData.map(renderDriverCard).join('') ||
    '<p class="muted">No drivers registered yet.</p>';

  driversData.forEach((d) => {
    const sel = document.querySelector(`.assign-select[data-driver-id="${d.id}"]`);
    if (sel) sel.value = d.current_taxi_id || '';
  });
  populateTaxiDropdowns();
  driversData.forEach((d) => {
    const sel = document.querySelector(`.assign-select[data-driver-id="${d.id}"]`);
    if (sel) sel.value = d.current_taxi_id || '';
  });

  const msgSel   = el('msgDriver');
  const approved = driversData.filter((d) => d.verification_status === 'approved');
  msgSel.innerHTML = approved.length
    ? approved.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('')
    : '<option value="">No approved drivers</option>';

  return driversData;
}

function renderDriverCard(d) {
  const vs      = d.verification_status || 'pending';
  const taxi    = d.taxi_plate || 'Unassigned';
  const now     = new Date();
  const licWarn = d.license_expiry && new Date(d.license_expiry) < new Date(now.getTime() + 60 * 864e5);
  const pdpWarn = d.pdp_expiry    && new Date(d.pdp_expiry)    < new Date(now.getTime() + 60 * 864e5);

  let btns = '';
  if (vs !== 'approved')  btns += `<button onclick="verifyDriver(${d.id},'approved')" style="background:var(--green)">✓ Approve</button>`;
  if (vs === 'approved')  btns += `<button class="warn" onclick="verifyDriver(${d.id},'suspended')">Suspend</button>`;
  if (vs !== 'rejected')  btns += `<button class="danger" onclick="verifyDriver(${d.id},'rejected')">✗ Reject</button>`;
  if (vs === 'rejected' || vs === 'suspended')
    btns += `<button class="secondary" onclick="verifyDriver(${d.id},'pending')">Reset to Pending</button>`;

  return `
    <div class="list-item">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <strong>${escapeHtml(d.name)}</strong>
        <span class="badge ${vs}">${vs}</span>
      </div>
      <div class="muted" style="margin-top:4px;">
        📞 ${escapeHtml(d.phone)} &nbsp;·&nbsp; 🚐 ${escapeHtml(taxi)}
      </div>
      <div class="muted" style="margin-top:2px;">
        Lic exp: <span style="${licWarn ? 'color:var(--red);font-weight:700' : ''}">${d.license_expiry || '—'}</span>
        &nbsp;·&nbsp;
        PDP exp: <span style="${pdpWarn ? 'color:var(--red);font-weight:700' : ''}">${d.pdp_expiry || '—'}</span>
      </div>
      <div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <label class="muted" style="flex-shrink:0;">Assign taxi:</label>
        <select class="assign-select" data-driver-id="${d.id}"
          onchange="assignTaxi(${d.id}, this.value)"
          style="width:auto;margin:0;flex:1;min-width:120px;font-size:13px;padding:6px 8px;"></select>
      </div>
      <div class="driver-actions">
        ${btns}
        <button class="secondary" onclick="toggleDriverDetail(${d.id})">View details</button>
      </div>
      <div id="driver-detail-${d.id}" class="hidden"></div>
    </div>`;
}

async function verifyDriver(driverId, status) {
  const labels = { approved: 'Approve', rejected: 'Reject', suspended: 'Suspend', pending: 'Reset to Pending' };
  if (!confirm(`${labels[status]} this driver?`)) return;
  const res = await fetch(`/api/owner/${owner.id}/drivers/${driverId}/verify`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (res.ok) {
    driversData = null;
    await loadDrivers();
    loadFleet();
    refreshCCStats();
  } else {
    const d = await res.json(); alert(d.error);
  }
}

async function toggleDriverDetail(driverId) {
  const detailEl = el(`driver-detail-${driverId}`);
  if (!detailEl.classList.contains('hidden')) { detailEl.classList.add('hidden'); return; }
  const res = await fetch(`/api/owner/${owner.id}/drivers/${driverId}`, { credentials: 'include' });
  if (!res.ok) { alert('Could not load driver details.'); return; }
  const d = await res.json();
  const base = `/api/owner/${owner.id}/drivers/${driverId}/document`;
  const selfieHtml = d.has_selfie
    ? `<img src="${base}/selfie_path" class="doc-img" alt="Selfie" onerror="this.style.display='none'">`
    : '<span class="muted">No selfie uploaded</span>';
  const docLinks = [
    d.has_license_doc && `<a class="doc-link" href="${base}/license_doc_path" target="_blank">📄 Licence Doc</a>`,
    d.has_pdp_doc     && `<a class="doc-link" href="${base}/pdp_doc_path" target="_blank">📄 PDP Doc</a>`,
  ].filter(Boolean).join('');

  detailEl.innerHTML = `
    <div class="driver-detail">
      <p><strong>ID Number:</strong> ${d.id_number ? escapeHtml(d.id_number) : '—'}</p>
      <p><strong>Phone:</strong> ${escapeHtml(d.phone)}</p>
      <p><strong>Licence:</strong> ${d.license_no || '—'} · Exp: ${d.license_expiry || '—'}</p>
      <p><strong>PDP:</strong> ${d.pdp_no || '—'} · Exp: ${d.pdp_expiry || '—'}</p>
      <p><strong>Taxi:</strong> ${d.taxi_plate || 'Unassigned'}</p>
      <p><strong>Registered:</strong> ${formatSADate(d.created_at?.slice(0,10))?.long || d.created_at}</p>
      <div style="margin-top:10px;">${selfieHtml}</div>
      ${docLinks ? `<div class="doc-links">${docLinks}</div>` : '<p class="muted" style="margin-top:8px;">No documents uploaded.</p>'}
    </div>`;
  detailEl.classList.remove('hidden');
}

async function assignTaxi(driverId, taxiId) {
  await fetch(`/api/owner/${owner.id}/drivers/${driverId}/assign`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taxi_id: taxiId || null }),
  });
  driversData = null;
  loadTaxis();
  loadDrivers();
  loadFleet();
}

// ════════════════════════════════════════════════════════ FEEDBACK ══

async function loadFeedback() {
  const res  = await fetch(`/api/owner/${owner.id}/feedback`, { credentials: 'include' });
  const rows = await res.json();
  const list = el('feedbackList');
  list.innerHTML = rows.map(renderFeedbackItem).join('') || '<p class="muted">No passenger feedback yet.</p>';
}

function renderFeedbackItem(fb) {
  const n = parseInt(fb.rating, 10);
  const hasRating = n >= 1 && n <= 5;
  const starsHtml = hasRating
    ? `<span class="fb-stars">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>` +
      `<span class="fb-rating-num">${n}/5</span>`
    : '<span class="muted" style="font-size:12px;">No rating</span>';

  const reports = (fb.report_types || [])
    .map((r) => `<span class="badge rejected">${escapeHtml(r)}</span>`)
    .join(' ');
  const { dateShort, time } = formatSADateTime(fb.created_at);

  return `
    <div class="list-item">
      <div class="fb-header">
        <div class="fb-star-row">${starsHtml}</div>
        <div class="fb-meta">
          <span>🚐 <strong>${escapeHtml(fb.plate)}</strong></span>
          ${fb.driver_name ? `<span>👤 ${escapeHtml(fb.driver_name)}</span>` : ''}
          <span>🕐 ${escapeHtml(dateShort)} · ${escapeHtml(time)}</span>
        </div>
      </div>
      ${fb.comment ? `<div class="feedback-comment">"${escapeHtml(fb.comment)}"</div>` : ''}
      ${reports    ? `<div style="margin-top:6px;">${reports}</div>` : ''}
    </div>`;
}

function prependFeedback(fb) {
  const list    = el('feedbackList');
  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderFeedbackItem({ ...fb, created_at: new Date().toISOString() });
  list.prepend(wrapper.firstElementChild);
}

// ═══════════════════════════════════════════════════════ MESSAGING ══

async function sendMessage() {
  const driver_id = el('msgDriver').value;
  const text      = el('msgText').value.trim();
  if (!driver_id || !text) return;
  await fetch(`/api/owner/${owner.id}/message`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driver_id, text }),
  });
  el('msgText').value = '';
  alert('Message sent.');
}

// ══════════════════════════════════════════════════════════ HELPERS ══

function el(id) { return document.getElementById(id); }

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning,';
  if (h < 17) return 'Good afternoon,';
  return 'Good evening,';
}

function toggleCollapsible(bodyId) {
  const body   = el(bodyId);
  const toggle = el('drvFormToggle');
  const open   = body.classList.toggle('hidden');
  toggle.textContent = open ? '＋ Register a new driver' : '－ Close registration form';
}

// ─── SAST date/time helpers ────────────────────────────────────────────────────

const MONTHS_LONG  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const SA_OFFSET_MS = 2 * 60 * 60 * 1000; // UTC+2

/**
 * Format a YYYY-MM-DD SAST date string (as returned by the earnings API).
 * Returns { long: '11 August 2026', short: '11 Aug 2026' }
 */
function formatSADate(ymd) {
  if (!ymd) return { long: '—', short: '—' };
  const [y, m, d] = ymd.split('-').map(Number);
  return {
    long:  `${d} ${MONTHS_LONG[m - 1]} ${y}`,
    short: `${d} ${MONTHS_SHORT[m - 1]} ${y}`,
  };
}

/**
 * Convert a UTC ISO string (as stored in the DB) to SAST display strings.
 * Returns { date: '11 August 2026', dateShort: '11 Aug 2026', time: '07:35' }
 */
function formatSADateTime(utcStr) {
  if (!utcStr) return { date: '—', dateShort: '—', time: '—' };
  const ms = new Date(utcStr).getTime() + SA_OFFSET_MS;
  const sa = new Date(ms);
  return {
    date:      `${sa.getUTCDate()} ${MONTHS_LONG[sa.getUTCMonth()]} ${sa.getUTCFullYear()}`,
    dateShort: `${sa.getUTCDate()} ${MONTHS_SHORT[sa.getUTCMonth()]} ${sa.getUTCFullYear()}`,
    time:      `${String(sa.getUTCHours()).padStart(2, '0')}:${String(sa.getUTCMinutes()).padStart(2, '0')}`,
  };
}

// ══════════════════════════════════════════════════════════════ INIT ══
restoreSession();

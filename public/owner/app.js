let owner = null;
let socket = null;

// ── Leaflet map ───────────────────────────────────────────────────────────────
let map = null;
let mapMarkers = {}; // keyed by driver_id

function initMap() {
  if (map) return;
  map = L.map('fleetMap').setView([-29.0, 25.0], 6); // centred on South Africa
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);
}

function updateMapMarker(row) {
  if (!map) return;
  if (!row.lat || !row.lng) {
    // No location — remove marker if it exists
    if (mapMarkers[row.driver_id]) {
      map.removeLayer(mapMarkers[row.driver_id]);
      delete mapMarkers[row.driver_id];
    }
    return;
  }

  const isOnline = row.taxi_status === 'online';
  const colour   = isOnline ? 'green' : 'grey';
  const icon = L.divIcon({
    className: '',
    html: `<div style="
      background:${isOnline ? '#0a7d3c' : '#6b7280'};
      color:#fff;font-size:10px;font-weight:700;
      padding:3px 6px;border-radius:4px;white-space:nowrap;
      box-shadow:0 1px 4px rgba(0,0,0,.4);">
      🚐 ${escapeHtml(row.taxi_plate || '?')}
    </div>`,
    iconAnchor: [0, 0],
  });

  if (mapMarkers[row.driver_id]) {
    mapMarkers[row.driver_id].setLatLng([row.lat, row.lng]).setIcon(icon);
    mapMarkers[row.driver_id].getPopup().setContent(popupContent(row));
  } else {
    const marker = L.marker([row.lat, row.lng], { icon })
      .bindPopup(popupContent(row))
      .addTo(map);
    mapMarkers[row.driver_id] = marker;
  }
}

function popupContent(row) {
  const updated = row.location_updated_at ? new Date(row.location_updated_at).toLocaleTimeString() : '—';
  return `
    <strong>${escapeHtml(row.driver_name)}</strong><br>
    Plate: ${escapeHtml(row.taxi_plate || '—')}<br>
    ${row.lat ? `${parseFloat(row.lat).toFixed(5)}, ${parseFloat(row.lng).toFixed(5)}<br>` : ''}
    Last update: ${updated}
  `;
}

function fitMapToMarkers() {
  if (!map) return;
  const pts = Object.values(mapMarkers).map((m) => m.getLatLng()).filter((p) => p.lat && p.lng);
  if (pts.length > 0) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 14 });
}

// ── Tab switching ─────────────────────────────────────────────────────────────

document.getElementById('tabLogin').onclick    = () => switchTab('login');
document.getElementById('tabRegister').onclick = () => switchTab('register');

function switchTab(which) {
  document.getElementById('tabLogin').classList.toggle('active', which === 'login');
  document.getElementById('tabRegister').classList.toggle('active', which === 'register');
  document.getElementById('loginForm').classList.toggle('hidden', which !== 'login');
  document.getElementById('registerForm').classList.toggle('hidden', which !== 'register');
  document.getElementById('authError').classList.add('hidden');
}

function showError(msg) {
  const el = document.getElementById('authError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function register() {
  const name     = document.getElementById('regName').value.trim();
  const phone    = document.getElementById('regPhone').value.trim();
  const password = document.getElementById('regPassword').value;
  if (!name || !phone || !password) return showError('All fields are required.');
  const res  = await fetch('/api/owner/register', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, phone, password }),
  });
  const data = await res.json();
  if (!res.ok) return showError(data.error);
  owner = data;
  boot();
}

async function login() {
  const phone    = document.getElementById('loginPhone').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!phone || !password) return showError('Phone and password are required.');
  const res  = await fetch('/api/owner/login', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  });
  const data = await res.json();
  if (!res.ok) return showError(data.error);
  owner = data;
  boot();
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.reload();
}

// ── Session restore ───────────────────────────────────────────────────────────

async function restoreSession() {
  try {
    const res  = await fetch('/api/auth/session', { credentials: 'include' });
    const data = await res.json();
    if (data.loggedIn && data.role === 'owner') {
      owner = { id: data.userId, name: data.name };
      boot();
    }
  } catch (_) { /* show auth form */ }
}

// ── App boot ──────────────────────────────────────────────────────────────────

function boot() {
  document.getElementById('authSection').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('ownerName').textContent = `— ${escapeHtml(owner.name)}`;
  const backBtn = document.getElementById('backBtn');
  if (backBtn) backBtn.classList.add('hidden');

  // Init map after the element is visible
  setTimeout(() => { initMap(); loadFleet(); }, 100);

  socket = io({ withCredentials: true });
  socket.emit('join_owner_room', owner.id);

  socket.on('location_update', (data) => {
    // Refresh the fleet row for this driver in-place
    updateFleetRow(data);
  });

  socket.on('taxi_status', () => {
    loadFleet();
    loadTaxis();
    loadDashboard();
  });

  socket.on('new_feedback', (fb) => { prependFeedback(fb); loadDashboard(); });
  socket.on('new_complaint', ()   => loadDashboard());
  socket.on('sos_alert', (alert)  => { showSos(alert); loadDashboard(); });

  loadDashboard();
  loadTaxis();
  loadDrivers();
  loadFeedback();

  // Poll fleet every 20 s for drivers that may not emit socket events
  setInterval(() => { if (owner) loadFleet(); }, 20000);
}

function showSos(alert) {
  const banner = document.getElementById('sosBanner');
  const div    = document.createElement('div');
  div.className = 'alert';
  div.textContent = `🚨 SOS from ${escapeHtml(alert.driver_name)} — taxi #${alert.taxi_id}${alert.lat ? ` (${Number(alert.lat).toFixed(4)}, ${Number(alert.lng).toFixed(4)})` : ''}`;
  banner.prepend(div);
}

// ── Live Fleet ────────────────────────────────────────────────────────────────

let fleetData = []; // in-memory, updated by socket events or poll

async function loadFleet() {
  try {
    const res = await fetch(`/api/owner/${owner.id}/fleet`, { credentials: 'include' });
    if (!res.ok) return;
    fleetData = await res.json();
    renderFleet(fleetData);
    document.getElementById('fleetUpdatedAt').textContent =
      `Last refreshed: ${new Date().toLocaleTimeString()}`;
  } catch (_) { /* network error — keep stale data */ }
}

function renderFleet(rows) {
  const list = document.getElementById('fleetList');

  if (!rows.length) {
    list.innerHTML = '<p class="muted">No drivers registered yet.</p>';
    return;
  }

  list.innerHTML = `
    <table class="fleet-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Driver</th>
          <th>Plate</th>
          <th>Last latitude</th>
          <th>Last longitude</th>
          <th>Location updated</th>
          <th>Shift started</th>
        </tr>
      </thead>
      <tbody id="fleetTbody">
        ${rows.map(renderFleetRow).join('')}
      </tbody>
    </table>`;

  // Update map markers
  rows.forEach(updateMapMarker);
  fitMapToMarkers();
}

function renderFleetRow(row) {
  const online   = row.taxi_status === 'online';
  const badge    = online
    ? '<span class="badge online">🟢 ONLINE</span>'
    : '<span class="badge offline">🔴 OFFLINE</span>';
  const lat      = row.lat  != null ? Number(row.lat).toFixed(5)  : '—';
  const lng      = row.lng  != null ? Number(row.lng).toFixed(5)  : '—';
  const updated  = row.location_updated_at ? new Date(row.location_updated_at).toLocaleTimeString() : '—';
  const shiftStart = row.shift_start ? new Date(row.shift_start).toLocaleTimeString() : '—';

  return `<tr id="fleet-row-${row.driver_id}" class="${online ? 'fleet-row-online' : ''}">
    <td>${badge}</td>
    <td>${escapeHtml(row.driver_name)}</td>
    <td>${escapeHtml(row.taxi_plate || '—')}</td>
    <td class="fleet-coord">${lat}</td>
    <td class="fleet-coord">${lng}</td>
    <td class="muted">${updated}</td>
    <td class="muted">${shiftStart}</td>
  </tr>`;
}

// Called by Socket.io location_update — update one row without full refresh
function updateFleetRow(data) {
  // Update our in-memory cache
  const idx = fleetData.findIndex((r) => r.driver_id === data.driver_id);
  if (idx !== -1) {
    fleetData[idx].lat = data.lat;
    fleetData[idx].lng = data.lng;
    fleetData[idx].location_updated_at = data.updated_at;
  }

  // Update the DOM row if it exists
  const row = document.getElementById(`fleet-row-${data.driver_id}`);
  if (row) {
    const cells = row.querySelectorAll('td');
    if (cells[3]) cells[3].textContent = Number(data.lat).toFixed(5);
    if (cells[4]) cells[4].textContent = Number(data.lng).toFixed(5);
    if (cells[5]) cells[5].textContent = new Date(data.updated_at || Date.now()).toLocaleTimeString();

    // Flash animation
    row.classList.add('fleet-row-flash');
    setTimeout(() => row.classList.remove('fleet-row-flash'), 1200);
  }

  // Update map marker
  if (idx !== -1) updateMapMarker(fleetData[idx]);

  document.getElementById('fleetUpdatedAt').textContent =
    `Last update: ${new Date().toLocaleTimeString()}`;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

async function loadDashboard() {
  const res = await fetch(`/api/owner/${owner.id}/dashboard`, { credentials: 'include' });
  if (res.status === 401) { logout(); return; }
  const d = await res.json();
  document.getElementById('statOnline').textContent    = d.taxisOnline;
  document.getElementById('statOffline').textContent   = d.taxisOffline;
  document.getElementById('statRating').textContent    = d.avgRating ? d.avgRating.toFixed(1) + '★' : '–';
  document.getElementById('statComplaints').textContent = d.complaints.length;
  document.getElementById('earnToday').textContent     = 'R' + d.earnings.today.toFixed(0);
  document.getElementById('earnWeek').textContent      = 'R' + d.earnings.week.toFixed(0);
  document.getElementById('earnMonth').textContent     = 'R' + d.earnings.month.toFixed(0);

  const banner = document.getElementById('sosBanner');
  banner.innerHTML = '';
  d.activeSos.forEach((a) => {
    const div = document.createElement('div');
    div.className = 'alert';
    div.innerHTML = `🚨 SOS from ${escapeHtml(a.driver_name)} — taxi #${a.taxi_id}
      <button style="width:auto;display:inline-block;margin-left:8px;padding:4px 8px;" onclick="resolveSos(${a.id})">Mark resolved</button>`;
    banner.appendChild(div);
  });
}

async function resolveSos(id) {
  await fetch(`/api/owner/${owner.id}/sos/${id}/resolve`, { method: 'POST', credentials: 'include' });
  loadDashboard();
}

// ── Taxis ─────────────────────────────────────────────────────────────────────

async function addTaxi() {
  const plate = document.getElementById('newPlate').value.trim();
  if (!plate) return;
  const res  = await fetch(`/api/owner/${owner.id}/taxis`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plate }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error);
  document.getElementById('newPlate').value = '';
  const msg = document.getElementById('addTaxiMsg');
  msg.textContent = `✅ Taxi ${data.plate} registered.`;
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 4000);
  loadTaxis();
  loadFleet();
}

async function loadTaxis() {
  const res   = await fetch(`/api/owner/${owner.id}/taxis`, { credentials: 'include' });
  const taxis = await res.json();
  document.getElementById('taxiCount').textContent = taxis.length;
  const list = document.getElementById('taxiList');
  list.innerHTML = taxis.map((t) => `
    <div class="list-item">
      <strong>${escapeHtml(t.plate)}</strong>
      <span class="badge ${t.status}">${t.status}</span>
      <span class="muted" style="margin-left:8px;">Driver: ${t.driver ? escapeHtml(t.driver.name) : 'Unassigned'}</span>
    </div>
  `).join('') || '<p class="muted">No taxis registered yet.</p>';

  window.__taxis = taxis;
  populateTaxiDropdowns();
}

function populateTaxiDropdowns() {
  const taxis = window.__taxis || [];
  const assignSelect = document.getElementById('drvTaxiAssign');
  if (assignSelect) {
    const currentVal = assignSelect.value;
    assignSelect.innerHTML = '<option value="">— Unassigned —</option>' +
      taxis.map((t) => `<option value="${t.id}">${escapeHtml(t.plate)}</option>`).join('');
    assignSelect.value = currentVal;
  }
  document.querySelectorAll('.assign-select').forEach((sel) => {
    const current = sel.value;
    sel.innerHTML = '<option value="">— Unassigned —</option>' +
      taxis.map((t) => `<option value="${t.id}">${escapeHtml(t.plate)}</option>`).join('');
    sel.value = current;
  });
}

// ── Drivers ───────────────────────────────────────────────────────────────────

async function addDriver() {
  const name     = document.getElementById('drvName').value.trim();
  const phone    = document.getElementById('drvPhone').value.trim();
  const password = document.getElementById('drvPassword').value;
  const errEl    = document.getElementById('drvError');
  errEl.classList.add('hidden');

  if (!name || !phone) { errEl.textContent = 'Name and phone are required.'; errEl.classList.remove('hidden'); return; }
  if (!password || password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.classList.remove('hidden'); return; }

  const formData = new FormData();
  formData.append('name', name);
  formData.append('phone', phone);
  formData.append('password', password);

  const idNumber      = document.getElementById('drvIdNumber').value.trim();
  const licenseNo     = document.getElementById('drvLicense').value.trim();
  const licenseExpiry = document.getElementById('drvLicenseExpiry').value;
  const pdpNo         = document.getElementById('drvPdp').value.trim();
  const pdpExpiry     = document.getElementById('drvPdpExpiry').value;
  const taxiId        = document.getElementById('drvTaxiAssign').value;

  if (idNumber)      formData.append('id_number', idNumber);
  if (licenseNo)     formData.append('license_no', licenseNo);
  if (licenseExpiry) formData.append('license_expiry', licenseExpiry);
  if (pdpNo)         formData.append('pdp_no', pdpNo);
  if (pdpExpiry)     formData.append('pdp_expiry', pdpExpiry);
  if (taxiId)        formData.append('current_taxi_id', taxiId);

  const licenseDoc = document.getElementById('drvLicenseDoc').files[0];
  const pdpDoc     = document.getElementById('drvPdpDoc').files[0];
  const selfie     = document.getElementById('drvSelfie').files[0];
  if (licenseDoc) formData.append('license_doc', licenseDoc);
  if (pdpDoc)     formData.append('pdp_doc', pdpDoc);
  if (selfie)     formData.append('selfie', selfie);

  const res  = await fetch(`/api/owner/${owner.id}/drivers`, {
    method: 'POST', credentials: 'include', body: formData,
  });
  const data = await res.json();
  if (!res.ok) { errEl.textContent = data.error; errEl.classList.remove('hidden'); return; }

  ['drvName','drvPhone','drvIdNumber','drvLicense','drvPdp'].forEach((id) => document.getElementById(id).value = '');
  ['drvPassword','drvLicenseExpiry','drvPdpExpiry'].forEach((id) => document.getElementById(id).value = '');
  ['drvLicenseDoc','drvPdpDoc','drvSelfie'].forEach((id) => document.getElementById(id).value = '');
  document.getElementById('drvTaxiAssign').value = '';

  alert(`✅ Driver "${data.name}" registered. Status: PENDING — approve them in the Driver Management section.`);
  loadDrivers();
  loadFleet();
}

async function loadDrivers() {
  const res     = await fetch(`/api/owner/${owner.id}/drivers`, { credentials: 'include' });
  const drivers = await res.json();
  document.getElementById('driverCount').textContent = drivers.length;

  const list = document.getElementById('driverList');
  list.innerHTML = drivers.map((d) => renderDriverCard(d)).join('') ||
    '<p class="muted">No drivers registered yet.</p>';

  drivers.forEach((d) => {
    const sel = document.querySelector(`.assign-select[data-driver-id="${d.id}"]`);
    if (sel) sel.value = d.current_taxi_id || '';
  });
  populateTaxiDropdowns();
  drivers.forEach((d) => {
    const sel = document.querySelector(`.assign-select[data-driver-id="${d.id}"]`);
    if (sel) sel.value = d.current_taxi_id || '';
  });

  const msgSelect  = document.getElementById('msgDriver');
  const approved   = drivers.filter((d) => d.verification_status === 'approved');
  msgSelect.innerHTML = approved.length
    ? approved.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('')
    : '<option value="">No approved drivers</option>';
}

function renderDriverCard(d) {
  const vs = d.verification_status || 'pending';
  const taxiInfo = d.taxi_plate || 'Unassigned';
  const now      = new Date();
  const licWarn  = d.license_expiry && new Date(d.license_expiry) < new Date(now.getTime() + 60 * 864e5);
  const pdpWarn  = d.pdp_expiry    && new Date(d.pdp_expiry)    < new Date(now.getTime() + 60 * 864e5);

  let actionBtns = '';
  if (vs !== 'approved')  actionBtns += `<button onclick="verifyDriver(${d.id},'approved')" style="background:var(--green)">✓ Approve</button>`;
  if (vs === 'approved')  actionBtns += `<button class="warn" onclick="verifyDriver(${d.id},'suspended')">Suspend</button>`;
  if (vs !== 'rejected')  actionBtns += `<button class="danger" onclick="verifyDriver(${d.id},'rejected')">✗ Reject</button>`;
  if (vs === 'rejected' || vs === 'suspended')
    actionBtns += `<button onclick="verifyDriver(${d.id},'pending')" class="secondary">Reset to Pending</button>`;

  return `
    <div class="list-item">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <strong>${escapeHtml(d.name)}</strong>
        <span class="badge ${vs}">${vs}</span>
      </div>
      <div class="muted" style="margin-top:4px;">
        📞 ${escapeHtml(d.phone)} &nbsp;·&nbsp; 🚐 ${escapeHtml(taxiInfo)}
      </div>
      <div class="muted" style="margin-top:2px;">
        Licence exp: <span style="${licWarn ? 'color:var(--red);font-weight:700' : ''}">${d.license_expiry || '—'}</span>
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
        ${actionBtns}
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
  if (res.ok) { loadDrivers(); loadFleet(); }
  else { const d = await res.json(); alert(d.error); }
}

async function toggleDriverDetail(driverId) {
  const detailEl = document.getElementById(`driver-detail-${driverId}`);
  if (!detailEl.classList.contains('hidden')) { detailEl.classList.add('hidden'); return; }

  const res = await fetch(`/api/owner/${owner.id}/drivers/${driverId}`, { credentials: 'include' });
  if (!res.ok) { alert('Could not load driver details.'); return; }
  const d = await res.json();
  const baseDocUrl = `/api/owner/${owner.id}/drivers/${driverId}/document`;

  const selfieHtml = d.has_selfie
    ? `<img src="${baseDocUrl}/selfie_path" class="doc-img" alt="Selfie" onerror="this.style.display='none'">`
    : '<span class="muted">No selfie uploaded</span>';

  const docLinks = [
    d.has_license_doc && `<a class="doc-link" href="${baseDocUrl}/license_doc_path" target="_blank">📄 Licence Doc</a>`,
    d.has_pdp_doc     && `<a class="doc-link" href="${baseDocUrl}/pdp_doc_path" target="_blank">📄 PDP Doc</a>`,
  ].filter(Boolean).join('');

  detailEl.innerHTML = `
    <div class="driver-detail">
      <p><strong>ID Number:</strong> ${d.id_number ? escapeHtml(d.id_number) : '—'}</p>
      <p><strong>Phone:</strong> ${escapeHtml(d.phone)}</p>
      <p><strong>Licence No:</strong> ${d.license_no || '—'} &nbsp;·&nbsp; <strong>Expiry:</strong> ${d.license_expiry || '—'}</p>
      <p><strong>PDP No:</strong> ${d.pdp_no || '—'} &nbsp;·&nbsp; <strong>Expiry:</strong> ${d.pdp_expiry || '—'}</p>
      <p><strong>Assigned taxi:</strong> ${d.taxi_plate || 'Unassigned'}</p>
      <p><strong>Registered:</strong> ${new Date(d.created_at).toLocaleDateString()}</p>
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
  loadTaxis();
  loadDrivers();
  loadFleet();
}

// ── Feedback ──────────────────────────────────────────────────────────────────

async function loadFeedback() {
  const res  = await fetch(`/api/owner/${owner.id}/feedback`, { credentials: 'include' });
  const rows = await res.json();
  const list = document.getElementById('feedbackList');
  list.innerHTML = rows.map(renderFeedbackItem).join('') || '<p class="muted">No feedback yet.</p>';
}

function renderFeedbackItem(fb) {
  const stars   = fb.rating ? '★'.repeat(fb.rating) + '☆'.repeat(5 - fb.rating) : '';
  const reports = (fb.report_types || []).map((r) => `<span class="badge rejected">${escapeHtml(r)}</span>`).join(' ');
  return `
    <div class="list-item">
      <strong>${escapeHtml(fb.plate)}</strong> ${fb.driver_name ? '· ' + escapeHtml(fb.driver_name) : ''}
      ${stars ? `<div style="color:#e2a400;">${stars}</div>` : ''}
      ${fb.comment ? `<div>"${escapeHtml(fb.comment)}"</div>` : ''}
      ${reports ? `<div style="margin-top:4px;">${reports}</div>` : ''}
      <div class="muted">${new Date(fb.created_at).toLocaleString()}</div>
    </div>`;
}

function prependFeedback(fb) {
  const list = document.getElementById('feedbackList');
  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderFeedbackItem({ ...fb, created_at: new Date().toISOString() });
  list.prepend(wrapper.firstElementChild);
}

// ── Messaging ─────────────────────────────────────────────────────────────────

async function sendMessage() {
  const driver_id = document.getElementById('msgDriver').value;
  const text      = document.getElementById('msgText').value.trim();
  if (!driver_id || !text) return;
  await fetch(`/api/owner/${owner.id}/message`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driver_id, text }),
  });
  document.getElementById('msgText').value = '';
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

setInterval(() => { if (owner) loadDashboard(); }, 15000);
restoreSession();

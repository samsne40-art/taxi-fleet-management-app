// Owner state — populated from server session on page load
let owner = null;
let socket = null;

// ─── Tab switching ────────────────────────────────────────────────────────────

document.getElementById('tabLogin').onclick = () => switchTab('login');
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

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function register() {
  const name = document.getElementById('regName').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const password = document.getElementById('regPassword').value;
  if (!name || !phone || !password) return showError('All fields are required.');
  const res = await fetch('/api/owner/register', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, phone, password }),
  });
  const data = await res.json();
  if (!res.ok) return showError(data.error);
  owner = data;
  boot();
}

async function login() {
  const phone = document.getElementById('loginPhone').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!phone || !password) return showError('Phone and password are required.');
  const res = await fetch('/api/owner/login', {
    method: 'POST',
    credentials: 'include',
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

// ─── Session restore on page load ─────────────────────────────────────────────

async function restoreSession() {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'include' });
    const data = await res.json();
    if (data.loggedIn && data.role === 'owner') {
      owner = { id: data.userId, name: data.name };
      boot();
    }
    // If not logged in, the auth section is already visible — nothing to do
  } catch (_) {
    // Network error — show auth form
  }
}

// ─── App boot ─────────────────────────────────────────────────────────────────

function boot() {
  document.getElementById('authSection').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('ownerName').textContent = `— ${owner.name}`;

  socket = io({ withCredentials: true });
  socket.emit('join_owner_room', owner.id);
  socket.on('location_update', () => loadDashboard());
  socket.on('taxi_status', () => { loadDashboard(); loadTaxis(); });
  socket.on('new_feedback', (fb) => { prependFeedback(fb); loadDashboard(); });
  socket.on('new_complaint', () => loadDashboard());
  socket.on('sos_alert', (alert) => { showSos(alert); loadDashboard(); });

  loadDashboard();
  loadTaxis();
  loadDrivers();
  loadFeedback();
}

function showSos(alert) {
  const banner = document.getElementById('sosBanner');
  const div = document.createElement('div');
  div.className = 'alert';
  div.textContent = `🚨 SOS from ${alert.driver_name} — taxi #${alert.taxi_id}${alert.lat ? ` (${alert.lat.toFixed(4)}, ${alert.lng.toFixed(4)})` : ''}`;
  banner.prepend(div);
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

async function loadDashboard() {
  const res = await fetch(`/api/owner/${owner.id}/dashboard`, { credentials: 'include' });
  if (res.status === 401) { logout(); return; }
  const d = await res.json();
  document.getElementById('statOnline').textContent = d.taxisOnline;
  document.getElementById('statOffline').textContent = d.taxisOffline;
  document.getElementById('statRating').textContent = d.avgRating ? d.avgRating.toFixed(1) + '★' : '–';
  document.getElementById('statComplaints').textContent = d.complaints.length;
  document.getElementById('earnToday').textContent = 'R' + d.earnings.today.toFixed(0);
  document.getElementById('earnWeek').textContent = 'R' + d.earnings.week.toFixed(0);
  document.getElementById('earnMonth').textContent = 'R' + d.earnings.month.toFixed(0);

  const banner = document.getElementById('sosBanner');
  banner.innerHTML = '';
  d.activeSos.forEach((a) => {
    const div = document.createElement('div');
    div.className = 'alert';
    div.innerHTML = `🚨 SOS from ${a.driver_name} — taxi #${a.taxi_id}
      <button style="width:auto;display:inline-block;margin-left:8px;padding:4px 8px;" onclick="resolveSos(${a.id})">Mark resolved</button>`;
    banner.appendChild(div);
  });
}

async function resolveSos(id) {
  await fetch(`/api/owner/${owner.id}/sos/${id}/resolve`, { method: 'POST', credentials: 'include' });
  loadDashboard();
}

// ─── Taxis ────────────────────────────────────────────────────────────────────

async function addTaxi() {
  const plate = document.getElementById('newPlate').value.trim();
  if (!plate) return;
  const res = await fetch(`/api/owner/${owner.id}/taxis`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plate }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error);
  document.getElementById('newTaxiQr').innerHTML = `
    <div class="qr-box">
      <p>Print this QR code and stick it inside the taxi:</p>
      <img src="${data.qrDataUrl}">
      <p class="muted">${data.passengerUrl}</p>
    </div>`;
  document.getElementById('newPlate').value = '';
  loadTaxis();
}

async function loadTaxis() {
  const res = await fetch(`/api/owner/${owner.id}/taxis`, { credentials: 'include' });
  const taxis = await res.json();
  document.getElementById('taxiCount').textContent = taxis.length;
  const list = document.getElementById('taxiList');
  list.innerHTML = taxis.map((t) => `
    <div class="list-item">
      <strong>${t.plate}</strong>
      <span class="badge ${t.status}">${t.status}</span><br>
      <span class="muted">Driver: ${t.driver ? t.driver.name : 'unassigned'}</span>
      <div class="qr-box" style="margin-top:8px;"><img src="${t.qrDataUrl}"></div>
    </div>
  `).join('') || '<p class="muted">No taxis registered yet.</p>';

  window.__taxis = taxis;
  renderDriverAssignOptions();
}

function renderDriverAssignOptions() {
  document.querySelectorAll('.assign-select').forEach((sel) => {
    const current = sel.value;
    sel.innerHTML = '<option value="">Unassigned</option>' + (window.__taxis || []).map((t) => `<option value="${t.id}">${t.plate}</option>`).join('');
    sel.value = current;
  });
}

// ─── Drivers ──────────────────────────────────────────────────────────────────

async function loadDrivers() {
  const res = await fetch(`/api/owner/${owner.id}/drivers`, { credentials: 'include' });
  const drivers = await res.json();
  document.getElementById('driverCount').textContent = drivers.length;

  const list = document.getElementById('driverList');
  list.innerHTML = drivers.map((d) => `
    <div class="list-item">
      <strong>${d.name}</strong> <span class="badge ${d.status}">${d.status}</span><br>
      <span class="muted">${d.phone} · Licence: ${d.license_no || '—'} · PDP: ${d.pdp_no || '—'}</span><br>
      <label class="muted">Assigned taxi:</label>
      <select class="assign-select" data-driver-id="${d.id}" onchange="assignTaxi(${d.id}, this.value)"></select>
      <button class="${d.status === 'active' ? 'danger' : ''}" style="width:auto;padding:6px 10px;"
        onclick="toggleStatus(${d.id}, '${d.status === 'active' ? 'suspended' : 'active'}')">
        ${d.status === 'active' ? 'Suspend' : 'Activate'}
      </button>
    </div>
  `).join('') || '<p class="muted">No drivers registered yet.</p>';

  drivers.forEach((d) => {
    const sel = document.querySelector(`.assign-select[data-driver-id="${d.id}"]`);
    if (sel) sel.value = d.current_taxi_id || '';
  });
  renderDriverAssignOptions();
  drivers.forEach((d) => {
    const sel = document.querySelector(`.assign-select[data-driver-id="${d.id}"]`);
    if (sel) sel.value = d.current_taxi_id || '';
  });

  const msgSelect = document.getElementById('msgDriver');
  msgSelect.innerHTML = drivers.map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
}

async function assignTaxi(driverId, taxiId) {
  await fetch(`/api/owner/${owner.id}/drivers/${driverId}/assign`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taxi_id: taxiId || null }),
  });
  loadTaxis();
}

async function toggleStatus(driverId, status) {
  await fetch(`/api/owner/${owner.id}/drivers/${driverId}/status`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  loadDrivers();
}

async function addDriver() {
  const name = document.getElementById('drvName').value.trim();
  const phone = document.getElementById('drvPhone').value.trim();
  const password = document.getElementById('drvPassword').value;
  const license_no = document.getElementById('drvLicense').value.trim();
  const pdp_no = document.getElementById('drvPdp').value.trim();
  if (!name || !phone) return alert('Name and phone are required.');
  if (!password) return alert('A login password is required for the driver.');
  const res = await fetch(`/api/owner/${owner.id}/drivers`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, phone, password, license_no, pdp_no }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error);
  document.getElementById('drvName').value = '';
  document.getElementById('drvPhone').value = '';
  document.getElementById('drvPassword').value = '';
  document.getElementById('drvLicense').value = '';
  document.getElementById('drvPdp').value = '';
  loadDrivers();
}

// ─── Feedback ─────────────────────────────────────────────────────────────────

async function loadFeedback() {
  const res = await fetch(`/api/owner/${owner.id}/feedback`, { credentials: 'include' });
  const rows = await res.json();
  const list = document.getElementById('feedbackList');
  list.innerHTML = rows.map(renderFeedbackItem).join('') || '<p class="muted">No feedback yet.</p>';
}

function renderFeedbackItem(fb) {
  const stars = fb.rating ? '★'.repeat(fb.rating) + '☆'.repeat(5 - fb.rating) : '';
  const reports = (fb.report_types || []).map((r) => `<span class="badge suspended">${r}</span>`).join(' ');
  return `
    <div class="list-item">
      <strong>${fb.plate}</strong> ${fb.driver_name ? '· ' + fb.driver_name : ''}
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

// ─── Messaging ────────────────────────────────────────────────────────────────

async function sendMessage() {
  const driver_id = document.getElementById('msgDriver').value;
  const text = document.getElementById('msgText').value.trim();
  if (!driver_id || !text) return;
  await fetch(`/api/owner/${owner.id}/message`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driver_id, text }),
  });
  document.getElementById('msgText').value = '';
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Auto-refresh dashboard periodically as a fallback to sockets
setInterval(() => { if (owner) loadDashboard(); }, 15000);

// Restore session on page load
restoreSession();

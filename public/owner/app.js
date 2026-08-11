let owner = null;
let socket = null;

// ── Tab switching ─────────────────────────────────────────────────────────────

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

// ── Auth ──────────────────────────────────────────────────────────────────────

async function register() {
  const name = document.getElementById('regName').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const password = document.getElementById('regPassword').value;
  if (!name || !phone || !password) return showError('All fields are required.');
  const res = await fetch('/api/owner/register', {
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
  const phone = document.getElementById('loginPhone').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!phone || !password) return showError('Phone and password are required.');
  const res = await fetch('/api/owner/login', {
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
    const res = await fetch('/api/auth/session', { credentials: 'include' });
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
  document.getElementById('ownerName').textContent = `— ${owner.name}`;
  const backBtn = document.getElementById('backBtn');
  if (backBtn) backBtn.classList.add('hidden');

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

// ── Dashboard ─────────────────────────────────────────────────────────────────

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

// ── Taxis ─────────────────────────────────────────────────────────────────────

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
  document.getElementById('newPlate').value = '';
  const msg = document.getElementById('addTaxiMsg');
  msg.textContent = `✅ Taxi ${data.plate} registered successfully.`;
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 4000);
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
      <span class="badge ${t.status}">${t.status}</span>
      <span class="muted" style="margin-left:8px;">Driver: ${t.driver ? t.driver.name : 'Unassigned'}</span>
    </div>
  `).join('') || '<p class="muted">No taxis registered yet.</p>';

  window.__taxis = taxis;
  populateTaxiDropdowns();
}

function populateTaxiDropdowns() {
  const taxis = window.__taxis || [];

  // Populate the taxi assignment dropdown in the Add Driver form
  const assignSelect = document.getElementById('drvTaxiAssign');
  if (assignSelect) {
    const currentVal = assignSelect.value;
    assignSelect.innerHTML = '<option value="">— Unassigned —</option>' +
      taxis.map((t) => `<option value="${t.id}">${t.plate}</option>`).join('');
    assignSelect.value = currentVal;
  }

  // Update all per-driver assign selects in the driver list
  document.querySelectorAll('.assign-select').forEach((sel) => {
    const current = sel.value;
    sel.innerHTML = '<option value="">— Unassigned —</option>' +
      taxis.map((t) => `<option value="${t.id}">${t.plate}</option>`).join('');
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

  // Note: do NOT set Content-Type header — browser sets multipart boundary automatically
  const res = await fetch(`/api/owner/${owner.id}/drivers`, {
    method: 'POST', credentials: 'include', body: formData,
  });
  const data = await res.json();
  if (!res.ok) { errEl.textContent = data.error; errEl.classList.remove('hidden'); return; }

  // Clear form
  ['drvName','drvPhone','drvIdNumber','drvLicense','drvPdp'].forEach(id => document.getElementById(id).value = '');
  ['drvPassword','drvLicenseExpiry','drvPdpExpiry'].forEach(id => document.getElementById(id).value = '');
  ['drvLicenseDoc','drvPdpDoc','drvSelfie'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('drvTaxiAssign').value = '';

  alert(`✅ Driver "${data.name}" registered. Status: PENDING — approve them from the Driver Management section.`);
  loadDrivers();
}

async function loadDrivers() {
  const res = await fetch(`/api/owner/${owner.id}/drivers`, { credentials: 'include' });
  const drivers = await res.json();
  document.getElementById('driverCount').textContent = drivers.length;

  const list = document.getElementById('driverList');
  list.innerHTML = drivers.map((d) => renderDriverCard(d)).join('') || '<p class="muted">No drivers registered yet.</p>';

  // Populate assign dropdowns with current values
  drivers.forEach((d) => {
    const sel = document.querySelector(`.assign-select[data-driver-id="${d.id}"]`);
    if (sel) sel.value = d.current_taxi_id || '';
  });
  populateTaxiDropdowns();
  drivers.forEach((d) => {
    const sel = document.querySelector(`.assign-select[data-driver-id="${d.id}"]`);
    if (sel) sel.value = d.current_taxi_id || '';
  });

  // Populate messaging dropdown (approved drivers only)
  const msgSelect = document.getElementById('msgDriver');
  const approved = drivers.filter(d => d.verification_status === 'approved');
  msgSelect.innerHTML = approved.length
    ? approved.map((d) => `<option value="${d.id}">${d.name}</option>`).join('')
    : '<option value="">No approved drivers</option>';
}

function renderDriverCard(d) {
  const vs = d.verification_status || 'pending';
  const taxiInfo = d.taxi_plate || 'Unassigned';

  // Expiry warnings
  const now = new Date();
  const licExpiry = d.license_expiry ? new Date(d.license_expiry) : null;
  const pdpExpiry = d.pdp_expiry ? new Date(d.pdp_expiry) : null;
  const licWarn = licExpiry && licExpiry < new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
  const pdpWarn = pdpExpiry && pdpExpiry < new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

  // Action buttons based on current status
  let actionBtns = '';
  if (vs !== 'approved')
    actionBtns += `<button onclick="verifyDriver(${d.id},'approved')" style="background:var(--green)">✓ Approve</button>`;
  if (vs === 'approved')
    actionBtns += `<button class="warn" onclick="verifyDriver(${d.id},'suspended')">Suspend</button>`;
  if (vs !== 'rejected')
    actionBtns += `<button class="danger" onclick="verifyDriver(${d.id},'rejected')">✗ Reject</button>`;
  if (vs === 'rejected' || vs === 'suspended')
    actionBtns += `<button onclick="verifyDriver(${d.id},'pending')" class="secondary">Reset to Pending</button>`;

  return `
    <div class="list-item">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <strong>${escapeHtml(d.name)}</strong>
        <span class="badge ${vs}">${vs}</span>
      </div>
      <div class="muted" style="margin-top:4px;">
        📞 ${escapeHtml(d.phone)}
        &nbsp;·&nbsp;
        🚐 ${escapeHtml(taxiInfo)}
      </div>
      <div class="muted" style="margin-top:2px;">
        Licence exp: <span style="${licWarn?'color:var(--red);font-weight:700':''}">${d.license_expiry || '—'}</span>
        &nbsp;·&nbsp;
        PDP exp: <span style="${pdpWarn?'color:var(--red);font-weight:700':''}">${d.pdp_expiry || '—'}</span>
      </div>

      <div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <label class="muted" style="flex-shrink:0;">Assign taxi:</label>
        <select class="assign-select" data-driver-id="${d.id}"
          onchange="assignTaxi(${d.id}, this.value)"
          style="width:auto;margin:0;flex:1;min-width:120px;font-size:13px;padding:6px 8px;">
        </select>
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
  if (res.ok) loadDrivers();
  else { const d = await res.json(); alert(d.error); }
}

async function toggleDriverDetail(driverId) {
  const detailEl = document.getElementById(`driver-detail-${driverId}`);
  if (!detailEl.classList.contains('hidden')) {
    detailEl.classList.add('hidden');
    return;
  }
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
}

// ── Feedback ──────────────────────────────────────────────────────────────────

async function loadFeedback() {
  const res = await fetch(`/api/owner/${owner.id}/feedback`, { credentials: 'include' });
  const rows = await res.json();
  const list = document.getElementById('feedbackList');
  list.innerHTML = rows.map(renderFeedbackItem).join('') || '<p class="muted">No feedback yet.</p>';
}

function renderFeedbackItem(fb) {
  const stars = fb.rating ? '★'.repeat(fb.rating) + '☆'.repeat(5 - fb.rating) : '';
  const reports = (fb.report_types || []).map((r) => `<span class="badge rejected">${r}</span>`).join(' ');
  return `
    <div class="list-item">
      <strong>${fb.plate}</strong> ${fb.driver_name ? '· ' + escapeHtml(fb.driver_name) : ''}
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
  const text = document.getElementById('msgText').value.trim();
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
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

setInterval(() => { if (owner) loadDashboard(); }, 15000);
restoreSession();

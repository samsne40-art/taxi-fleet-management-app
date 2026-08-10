// Driver state — populated from server session on page load
let driver = null;
let socket = null;
let watchId = null;
let onShift = false;

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function login() {
  const phone = document.getElementById('loginPhone').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('authError');
  errEl.classList.add('hidden');

  if (!phone || !password) {
    errEl.textContent = 'Phone and password are required.';
    errEl.classList.remove('hidden');
    return;
  }

  const res = await fetch('/api/driver/login', {
    method: 'POST',
    credentials: 'include',
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
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  location.reload();
}

// ─── Session restore on page load ─────────────────────────────────────────────

async function restoreSession() {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'include' });
    const data = await res.json();
    if (data.loggedIn && data.role === 'driver') {
      // Fetch full driver profile to restore state
      const r2 = await fetch(`/api/driver/${data.userId}/earnings`, { credentials: 'include' });
      if (r2.ok) {
        driver = { id: data.userId, name: data.name };
        boot();
      }
    }
  } catch (_) {
    // Network error — show login form
  }
}

// ─── App boot ─────────────────────────────────────────────────────────────────

function boot() {
  document.getElementById('authSection').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('driverName').textContent = `— ${driver.name}`;

  socket = io({ withCredentials: true });
  socket.emit('join_driver_room', driver.id);
  socket.on('new_message', (msg) => prependMessage(msg));

  loadEarnings();
  loadMessages();
}

// ─── Shift ────────────────────────────────────────────────────────────────────

async function startShift() {
  const res = await fetch(`/api/driver/${driver.id}/shift/start`, {
    method: 'POST', credentials: 'include',
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error);
  onShift = true;
  document.getElementById('shiftStatus').textContent = 'on duty';
  document.getElementById('shiftStatus').className = 'badge online';
  document.getElementById('startBtn').classList.add('hidden');
  document.getElementById('endBtn').classList.remove('hidden');
  startWatching();
}

async function endShift() {
  await fetch(`/api/driver/${driver.id}/shift/end`, {
    method: 'POST', credentials: 'include',
  });
  onShift = false;
  document.getElementById('shiftStatus').textContent = 'off duty';
  document.getElementById('shiftStatus').className = 'badge offline';
  document.getElementById('startBtn').classList.remove('hidden');
  document.getElementById('endBtn').classList.add('hidden');
  stopWatching();
}

// ─── Location ─────────────────────────────────────────────────────────────────

function startWatching() {
  if (!navigator.geolocation) {
    document.getElementById('locStatus').textContent = 'Geolocation not supported on this device/browser.';
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      document.getElementById('locStatus').textContent = `Sharing location: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
      fetch(`/api/driver/${driver.id}/location`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: latitude, lng: longitude }),
      });
    },
    (err) => { document.getElementById('locStatus').textContent = 'Location error: ' + err.message; },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  );
}

function stopWatching() {
  if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  document.getElementById('locStatus').textContent = '';
}

// ─── Trips & Earnings ─────────────────────────────────────────────────────────

async function logTrip() {
  const fare = parseFloat(document.getElementById('fareInput').value);
  if (isNaN(fare) || fare < 0) return alert('Enter a valid fare');
  const res = await fetch(`/api/driver/${driver.id}/trip`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fare }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error);
  document.getElementById('fareInput').value = '';
  loadEarnings();
}

async function loadEarnings() {
  const res = await fetch(`/api/driver/${driver.id}/earnings`, { credentials: 'include' });
  const e = await res.json();
  document.getElementById('earnToday').textContent = 'R' + e.today.total.toFixed(0);
  document.getElementById('earnWeek').textContent = 'R' + e.week.total.toFixed(0);
  document.getElementById('earnMonth').textContent = 'R' + e.month.total.toFixed(0);
}

// ─── Messages ─────────────────────────────────────────────────────────────────

async function loadMessages() {
  const res = await fetch(`/api/driver/${driver.id}/messages`, { credentials: 'include' });
  const rows = await res.json();
  const list = document.getElementById('messages');
  list.innerHTML = rows.map((m) => `<div class="list-item">${escapeHtml(m.text)}<div class="muted">${new Date(m.created_at).toLocaleString()}</div></div>`).join('') || '<p class="muted">No messages yet.</p>';
}

function prependMessage(msg) {
  const list = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'list-item';
  div.innerHTML = `${escapeHtml(msg.text)}<div class="muted">${new Date().toLocaleString()}</div>`;
  list.prepend(div);
}

// ─── SOS ──────────────────────────────────────────────────────────────────────

function sendSos() {
  if (!navigator.geolocation) {
    fetch(`/api/driver/${driver.id}/sos`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    alert('SOS sent (no location available).');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      fetch(`/api/driver/${driver.id}/sos`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      });
      alert('SOS sent to your owner.');
    },
    () => {
      fetch(`/api/driver/${driver.id}/sos`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      alert('SOS sent (location unavailable).');
    }
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Restore session on page load
restoreSession();

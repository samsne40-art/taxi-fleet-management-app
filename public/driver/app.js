// ─── Driver state ─────────────────────────────────────────────────────────────
let driver = null;
let socket = null;

// GPS tracking state
let watchId = null;
let onShift = false;
let lastSentLat = null;
let lastSentLng = null;
let lastSentTime = 0;
let pendingLocation = null; // buffered when offline
let sendRetryTimer = null;

const MIN_INTERVAL_MS = 30_000;  // at least 30 s between sends
const MIN_DISTANCE_M  = 30;       // or at least 30 m moved

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Haversine distance in metres between two lat/lng points
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

    // Check if the driver was mid-shift before the page refreshed
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

  loadEarnings();
  loadMessages();
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

  // Update live display
  document.getElementById('gpsStatus').textContent = 'ACTIVE';
  document.getElementById('gpsStatus').className   = 'badge online';
  document.getElementById('locDetail').classList.remove('hidden');
  document.getElementById('locCoords').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  document.getElementById('locAccuracy').textContent = ` ±${Math.round(accuracy)}m`;

  // Throttle: skip if not enough time has passed AND we haven't moved enough
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
      setLocMsg('');  // clear any connectivity warning
    } else {
      const d = await res.json().catch(() => ({}));
      // 409 means no active shift — shift was ended elsewhere
      if (res.status === 409) {
        setLocMsg('⚠️ Shift no longer active. Please reload.');
      } else {
        setLocMsg(`⚠️ Server error: ${d.error || res.status}`);
      }
    }
  } catch (_) {
    // Network failure — buffer and retry
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

// ─── Earnings ─────────────────────────────────────────────────────────────────

async function loadEarnings() {
  const res = await fetch(`/api/driver/${driver.id}/earnings`, { credentials: 'include' });
  if (!res.ok) return;
  const e = await res.json();
  document.getElementById('earnToday').textContent = 'R' + e.today.total.toFixed(0);
  document.getElementById('earnWeek').textContent  = 'R' + e.week.total.toFixed(0);
  document.getElementById('earnMonth').textContent = 'R' + e.month.total.toFixed(0);
}

// ─── Trips ────────────────────────────────────────────────────────────────────

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

// ─── Messages ─────────────────────────────────────────────────────────────────

async function loadMessages() {
  const res  = await fetch(`/api/driver/${driver.id}/messages`, { credentials: 'include' });
  const rows = await res.json();
  const list = document.getElementById('messages');
  list.innerHTML = rows.map((m) =>
    `<div class="list-item">${escapeHtml(m.text)}<div class="muted">${new Date(m.created_at).toLocaleString()}</div></div>`
  ).join('') || '<p class="muted">No messages yet.</p>';
}

function prependMessage(msg) {
  const list = document.getElementById('messages');
  const div  = document.createElement('div');
  div.className = 'list-item';
  div.innerHTML = `${escapeHtml(msg.text)}<div class="muted">${new Date().toLocaleString()}</div>`;
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

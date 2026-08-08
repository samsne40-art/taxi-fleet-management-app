let driver = JSON.parse(localStorage.getItem('driver') || 'null');
let socket = null;
let watchId = null;
let onShift = false;

async function login() {
  const phone = document.getElementById('loginPhone').value.trim();
  const res = await fetch('/api/driver/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
  const data = await res.json();
  const errEl = document.getElementById('authError');
  if (!res.ok) {
    errEl.textContent = data.error;
    errEl.classList.remove('hidden');
    return;
  }
  driver = data;
  localStorage.setItem('driver', JSON.stringify(driver));
  boot();
}

function logout() {
  stopWatching();
  localStorage.removeItem('driver');
  location.reload();
}

function boot() {
  document.getElementById('authSection').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('driverName').textContent = `— ${driver.name}`;

  socket = io();
  socket.emit('join_driver_room', driver.id);
  socket.on('new_message', (msg) => prependMessage(msg));

  loadEarnings();
  loadMessages();
}

async function startShift() {
  const res = await fetch(`/api/driver/${driver.id}/shift/start`, { method: 'POST' });
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
  await fetch(`/api/driver/${driver.id}/shift/end`, { method: 'POST' });
  onShift = false;
  document.getElementById('shiftStatus').textContent = 'off duty';
  document.getElementById('shiftStatus').className = 'badge offline';
  document.getElementById('startBtn').classList.remove('hidden');
  document.getElementById('endBtn').classList.add('hidden');
  stopWatching();
}

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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
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

async function logTrip() {
  const fare = parseFloat(document.getElementById('fareInput').value);
  if (isNaN(fare) || fare < 0) return alert('Enter a valid fare');
  const res = await fetch(`/api/driver/${driver.id}/trip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fare }) });
  const data = await res.json();
  if (!res.ok) return alert(data.error);
  document.getElementById('fareInput').value = '';
  loadEarnings();
}

async function loadEarnings() {
  const res = await fetch(`/api/driver/${driver.id}/earnings`);
  const e = await res.json();
  document.getElementById('earnToday').textContent = 'R' + e.today.total.toFixed(0);
  document.getElementById('earnWeek').textContent = 'R' + e.week.total.toFixed(0);
  document.getElementById('earnMonth').textContent = 'R' + e.month.total.toFixed(0);
}

async function loadMessages() {
  const res = await fetch(`/api/driver/${driver.id}/messages`);
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

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sendSos() {
  if (!navigator.geolocation) {
    fetch(`/api/driver/${driver.id}/sos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    alert('SOS sent (no location available).');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      fetch(`/api/driver/${driver.id}/sos`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      });
      alert('SOS sent to your owner.');
    },
    () => {
      fetch(`/api/driver/${driver.id}/sos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      alert('SOS sent (location unavailable).');
    }
  );
}

if (driver) boot();

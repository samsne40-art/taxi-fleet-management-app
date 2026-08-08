let currentTaxi = null;
let selectedRating = 0;

// If opened via a QR code (?t=<token>), auto-lookup that taxi.
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const token = params.get('t');
  if (token) lookupByToken(token);

  document.querySelectorAll('#starPicker .star').forEach((star) => {
    star.addEventListener('click', () => {
      selectedRating = parseInt(star.dataset.v, 10);
      renderStars();
    });
  });

  if (!('BarcodeDetector' in window)) {
    document.getElementById('scanBtn').title = 'Live camera scanning needs a browser with BarcodeDetector support (e.g. Chrome on Android). Falling back to manual entry.';
  }
});

function renderStars() {
  document.querySelectorAll('#starPicker .star').forEach((star) => {
    star.classList.toggle('filled', parseInt(star.dataset.v, 10) <= selectedRating);
  });
}

async function lookupByPlate() {
  const plate = document.getElementById('plateInput').value.trim();
  if (!plate) return;
  const res = await fetch(`/api/passenger/taxi/plate/${encodeURIComponent(plate)}`);
  const data = await res.json();
  handleLookupResult(res.ok, data);
}

async function lookupByToken(token) {
  const res = await fetch(`/api/passenger/taxi/token/${encodeURIComponent(token)}`);
  const data = await res.json();
  handleLookupResult(res.ok, data);
}

function handleLookupResult(ok, data) {
  const errEl = document.getElementById('lookupError');
  if (!ok) {
    errEl.textContent = data.error;
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');
  currentTaxi = data;
  document.getElementById('taxiPlate').textContent = data.plate;
  document.getElementById('driverName').textContent = data.driver ? data.driver.name : 'Not yet assigned';
  document.getElementById('ratingSummary').textContent = data.ratingCount
    ? `Average rating: ${data.avgRating.toFixed(1)}★ from ${data.ratingCount} passenger${data.ratingCount === 1 ? '' : 's'}`
    : 'No ratings yet — be the first!';
  document.getElementById('lookupSection').classList.add('hidden');
  document.getElementById('taxiSection').classList.remove('hidden');
  document.getElementById('submitted').classList.add('hidden');
}

// Scan a QR code using the camera via the native BarcodeDetector API where
// available. This is a lightweight prototype implementation — for wider
// browser support, swap in a JS library such as jsQR or html5-qrcode.
async function scanQr() {
  if (!('BarcodeDetector' in window)) {
    alert('Live camera scanning is not supported in this browser. Please enter the plate manually, or open this page from the QR code link directly.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = document.createElement('video');
    video.srcObject = stream;
    video.setAttribute('playsinline', true);
    await video.play();

    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const interval = setInterval(async () => {
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          clearInterval(interval);
          stream.getTracks().forEach((t) => t.stop());
          const url = new URL(codes[0].rawValue);
          const token = url.searchParams.get('t');
          if (token) lookupByToken(token);
        }
      } catch (e) { /* keep trying */ }
    }, 400);

    setTimeout(() => { clearInterval(interval); stream.getTracks().forEach((t) => t.stop()); }, 15000);
  } catch (e) {
    alert('Could not access camera: ' + e.message);
  }
}

async function submitFeedback() {
  if (!currentTaxi) return;
  const comment = document.getElementById('comment').value.trim();
  const report_types = ['r1', 'r2', 'r3', 'r4', 'r5']
    .filter((id) => document.getElementById(id).checked)
    .map((id) => document.getElementById(id).value);

  if (!selectedRating && !comment && !report_types.length) {
    alert('Please give a rating, comment, or select a report before submitting.');
    return;
  }

  await fetch('/api/passenger/feedback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taxi_id: currentTaxi.id, rating: selectedRating || null, comment, report_types }),
  });

  document.getElementById('submitted').classList.remove('hidden');
}

function resetForm() {
  currentTaxi = null;
  selectedRating = 0;
  renderStars();
  document.getElementById('comment').value = '';
  ['r1', 'r2', 'r3', 'r4', 'r5'].forEach((id) => (document.getElementById(id).checked = false));
  document.getElementById('plateInput').value = '';
  document.getElementById('taxiSection').classList.add('hidden');
  document.getElementById('lookupSection').classList.remove('hidden');
  history.replaceState(null, '', location.pathname);
}

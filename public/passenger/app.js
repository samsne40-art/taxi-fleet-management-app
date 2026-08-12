let currentTaxi   = null;
let selectedRating = 0;
let submitting     = false;

// ── Initialise stars on page load ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderStars();   // paint all ☆ (empty) on load

  // Allow Enter key in the plate field to trigger lookup
  document.getElementById('plateInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') lookupByPlate();
  });
});

// ── Star interaction ──────────────────────────────────────────────────────────

/**
 * Called by onclick on each star button.
 * Supports keyboard activation automatically because they are <button> elements.
 */
function selectStar(value) {
  selectedRating = value;
  renderStars();
  updateRatingLabel();
}

/** Repaint all five stars based on selectedRating (filled ★ vs empty ☆). */
function renderStars() {
  document.querySelectorAll('#starPicker .star-btn').forEach((btn) => {
    const v = parseInt(btn.dataset.v, 10);
    const filled = v <= selectedRating;
    btn.classList.toggle('filled', filled);
    btn.textContent = filled ? '★' : '☆';
    btn.setAttribute('aria-pressed', String(filled));
  });
}

/** Update "Your rating: X/5" label. */
function updateRatingLabel() {
  document.getElementById('ratingValue').textContent = selectedRating;
}

// ── Taxi lookup ───────────────────────────────────────────────────────────────

async function lookupByPlate() {
  const plate  = document.getElementById('plateInput').value.trim();
  const errEl  = document.getElementById('lookupError');
  const btn    = document.getElementById('lookupBtn');
  if (!plate) return;

  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Searching…';

  try {
    const res  = await fetch(`/api/passenger/taxi/plate/${encodeURIComponent(plate)}`);
    const data = await res.json();
    handleLookupResult(res.ok, data);
  } catch (_) {
    errEl.textContent = 'Network error — please check your connection.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find taxi';
  }
}

function handleLookupResult(ok, data) {
  const errEl = document.getElementById('lookupError');
  if (!ok) {
    errEl.textContent = data.error;
    errEl.classList.remove('hidden');
    return;
  }

  errEl.classList.add('hidden');
  currentTaxi    = data;
  selectedRating = 0;
  submitting     = false;

  document.getElementById('taxiPlate').textContent    = data.plate;
  document.getElementById('driverName').textContent   = data.driver ? data.driver.name : 'Not yet assigned';
  document.getElementById('ratingSummary').textContent = data.ratingCount
    ? `Average rating: ${Number(data.avgRating).toFixed(1)}★ from ${data.ratingCount} passenger${data.ratingCount === 1 ? '' : 's'}`
    : 'No ratings yet — be the first!';

  // Reset the form for a fresh submission
  renderStars();
  updateRatingLabel();
  document.getElementById('comment').value = '';
  document.getElementById('comment').classList.remove('hidden');
  document.getElementById('reportOptions').classList.remove('hidden');
  document.getElementById('starPicker').removeAttribute('aria-disabled');
  ['r1', 'r2', 'r3', 'r4', 'r5'].forEach((id) => { document.getElementById(id).checked = false; });

  const btn = document.getElementById('submitBtn');
  btn.disabled    = false;
  btn.textContent = 'Submit feedback';
  btn.classList.remove('hidden');

  document.getElementById('submitted').classList.add('hidden');
  document.getElementById('lookupSection').classList.add('hidden');
  document.getElementById('taxiSection').classList.remove('hidden');
}

// ── Submit ────────────────────────────────────────────────────────────────────

async function submitFeedback() {
  if (!currentTaxi) return;
  if (submitting) return;   // guard against double-tap

  // Require a star rating
  if (!selectedRating || selectedRating < 1 || selectedRating > 5) {
    // Visually shake the star picker to draw attention
    const picker = document.getElementById('starPicker');
    picker.classList.add('star-picker-shake');
    setTimeout(() => picker.classList.remove('star-picker-shake'), 500);
    document.getElementById('ratingRequired').classList.remove('hidden');
    picker.querySelector('.star-btn').focus();
    return;
  }
  document.getElementById('ratingRequired').classList.add('hidden');

  const comment      = document.getElementById('comment').value.trim();
  const report_types = ['r1', 'r2', 'r3', 'r4', 'r5']
    .filter((id) => document.getElementById(id).checked)
    .map((id) => document.getElementById(id).value);

  submitting = true;
  const btn  = document.getElementById('submitBtn');
  btn.disabled    = true;
  btn.textContent = 'Submitting…';

  try {
    const res  = await fetch('/api/passenger/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taxi_id:      currentTaxi.id,
        rating:       selectedRating,
        comment,
        report_types,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      alert(data.error || 'Submission failed. Please try again.');
      btn.disabled    = false;
      btn.textContent = 'Submit feedback';
      submitting      = false;
      return;
    }

    // ── Success ───────────────────────────────────────────────────────────────
    const filled = '★'.repeat(selectedRating);
    const empty  = '☆'.repeat(5 - selectedRating);
    document.getElementById('confirmedRating').innerHTML =
      `<span class="confirm-stars">${filled}${empty}</span>` +
      `<span class="confirm-fraction">${selectedRating}/5</span>`;

    // Hide input areas, show confirmation
    document.getElementById('starPicker').setAttribute('aria-disabled', 'true');
    document.getElementById('comment').classList.add('hidden');
    document.getElementById('reportOptions').classList.add('hidden');
    btn.classList.add('hidden');
    document.getElementById('submitted').classList.remove('hidden');

  } catch (_) {
    alert('Network error — please check your connection and try again.');
    btn.disabled    = false;
    btn.textContent = 'Submit feedback';
    submitting      = false;
  }
}

// ── Reset (Rate another taxi) ─────────────────────────────────────────────────

function resetForm() {
  currentTaxi    = null;
  selectedRating = 0;
  submitting     = false;

  renderStars();
  updateRatingLabel();
  document.getElementById('comment').value = '';
  document.getElementById('comment').classList.remove('hidden');
  document.getElementById('reportOptions').classList.remove('hidden');
  document.getElementById('starPicker').removeAttribute('aria-disabled');
  document.getElementById('ratingRequired').classList.add('hidden');
  ['r1', 'r2', 'r3', 'r4', 'r5'].forEach((id) => { document.getElementById(id).checked = false; });
  document.getElementById('plateInput').value = '';

  const btn = document.getElementById('submitBtn');
  btn.disabled    = false;
  btn.textContent = 'Submit feedback';
  btn.classList.remove('hidden');

  document.getElementById('submitted').classList.add('hidden');
  document.getElementById('taxiSection').classList.add('hidden');
  document.getElementById('lookupSection').classList.remove('hidden');
}

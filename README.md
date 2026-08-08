# Minibus Taxi Fleet & Passenger Feedback — Prototype

A working prototype covering all three modes: **Owner**, **Driver**, and **Passenger**,
built as one Node/Express server with three lightweight front-ends and live updates
over Socket.io.

## Stack (and why)

- **Node.js + Express** — simple, one server handles all three apps and the API.
- **SQLite (better-sqlite3)** — zero setup, a single file (`data/taxi.db`), plenty for
  a prototype or a single taxi association. Swap for Postgres later without changing
  much of the API shape.
- **Socket.io** — pushes live driver locations, new ratings/complaints, and SOS alerts
  to the owner dashboard the instant they happen, and owner messages to the driver.
- **Plain HTML/CSS/JS front-ends** (no framework, no build step) — each mode is a
  single static page under `public/`, so you can literally open it and go. This keeps
  the prototype easy to run and easy to hand to someone else, at the cost of not
  scaling to a large team codebase — see "What to extend" below.
- **`qrcode`** — generates the per-taxi QR code server-side as a data URL.

## Run it

Requires Node.js 18+ (for built-in `fetch` compatibility isn't required here, but
recent Node is assumed).

```bash
cd taxi-app
npm install
npm start
```

Then open:

- **Owner:** http://localhost:3000/owner/
- **Driver:** http://localhost:3000/driver/
- **Passenger:** http://localhost:3000/passenger/

The database file is created automatically at `data/taxi.db` on first run.

### Try the full loop in ~2 minutes

1. Open **Owner**, register an owner account, log in.
2. Add a taxi (e.g. `ND 456-123`) — a QR code appears immediately.
3. Add a driver, then use the "Assigned taxi" dropdown next to their name to assign
   them to the taxi you just created.
4. Open **Driver** in another tab/window, log in with the driver's phone number,
   click **Start shift** (allow location access when prompted — works best over
   `localhost` or HTTPS; some browsers block geolocation on plain HTTP for other
   hosts).
5. Log a trip with a fare amount — watch the owner dashboard earnings update live.
6. Open **Passenger** in a third tab. Either type the plate manually, or copy the
   QR image's underlying URL (shown under the QR code on the owner page) into the
   address bar to simulate a scan. Submit a rating/complaint.
7. Watch it land on the Owner dashboard instantly, with no page refresh.
8. Try the **SOS** button on the Driver page and watch the alert banner appear on
   the Owner dashboard.

Two people can drive this end-to-end on two different laptops on the same network:
replace `localhost` with your machine's LAN IP (e.g. `http://192.168.1.20:3000/driver/`).

## What's real vs. stubbed in this prototype

Working: registration/login (owner + phone-based driver login), taxi + QR generation,
driver-taxi assignment, suspend/activate, shift start/end, live location while on
shift, trip/fare logging, earnings roll-ups (today/week/month), passenger lookup by
plate or QR, star ratings + comments + structured complaint types, live feedback and
complaint feed, owner→driver messaging, SOS alerts — all pushed live via Socket.io.

Stubbed / simplified on purpose, to keep this runnable in one sitting:

- **Auth is intentionally weak** — plaintext passwords, no sessions/JWT, no OTP for
  driver phone login. Fine for a demo, not for anyone's real data.
- **Document uploads** (licence, PDP, ID, selfie) — the owner form has a note where
  this goes, but no upload endpoint is wired up yet.
- **QR camera scanning** uses the browser's native `BarcodeDetector` API, which only
  works in Chromium-based browsers on Android/desktop today. Safari/iOS falls back to
  manual plate entry. A JS library (`jsQR`, `html5-qrcode`) would give universal support.
- **Map view** — the dashboard shows raw lat/lng, not a pin on a map.
- **Document expiry tracking** — no expiry dates captured yet, so "drivers with
  expired PDPs" isn't populated (there's a placeholder in the dashboard API for it).

## What I'd extend first

In rough priority order, matched to what would break or matter most first in real use:

1. **Real auth** — bcrypt/argon2 password hashing for owners, and OTP-via-SMS for
   driver login (a South African SMS gateway like Clickatell or Twilio would work).
   Add JWT or signed session cookies instead of trusting a phone number/localStorage.
2. **Document uploads** — wire up the `multer` dependency already in `package.json`
   to accept licence/PDP/ID/selfie images, store them (S3-compatible bucket, not
   local disk, once this leaves your laptop), and show them in the owner dashboard
   next to each driver.
3. **A real map** — Leaflet + OpenStreetMap (free) or Google Maps for the live
   fleet view, since "22 taxis, here's their lat/lng as text" doesn't scale visually
   past a handful of vehicles.
4. **Rate limiting on the passenger feedback endpoint** — right now nothing stops
   someone from spamming a taxi with fake 1-star ratings or fake compliments. A
   simple approach: rate-limit by IP + short cookie, tied to a real ride actually
   happening (e.g. only accept feedback once during/after a shift the taxi is on).
5. **Push notifications** — Socket.io only reaches an owner with the dashboard tab
   open. A real deployment needs actual push (web push, or a native app with FCM)
   so owners get complaints/SOS alerts even when the browser's closed.
6. **PostgreSQL + a proper migrations tool** once more than one process needs to
   write to the database, or you deploy beyond a single machine.
7. From the "Future Features" list — driver scorecards and the "AI flags
   consistently poor ratings" feature are natural next steps once there's enough
   feedback volume to make a scorecard meaningful, and become a scheduled job that
   reads the `feedback` table rather than anything real-time.

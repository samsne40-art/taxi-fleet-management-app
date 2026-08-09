# Minibus Taxi Fleet & Passenger Feedback — Prototype

A working prototype for minibus taxi fleet management covering three roles: **Owner**, **Driver**, and **Passenger**, built on a single Node/Express server with live updates via Socket.io.

## Stack

- **Node.js + Express** — single server, all three apps + API
- **SQLite (better-sqlite3)** — zero-setup local database at `data/taxi.db`
- **Socket.io** — live location, ratings, complaints, and SOS alerts
- **Plain HTML/CSS/JS** — no framework, no build step

## How to run

The app starts automatically via the "Start application" workflow (`npm start`) on port 5000.

Three front-ends are served at:
- **Owner:** `/owner/`
- **Driver:** `/driver/`
- **Passenger:** `/passenger/`

The SQLite database (`data/taxi.db`) is created automatically on first run.

## Quick demo flow

1. Open `/owner/`, register an owner account, log in.
2. Add a taxi (e.g. `ND 456-123`) — a QR code appears immediately.
3. Add a driver, assign them to the taxi.
4. Open `/driver/` in another tab, log in with the driver's phone number, click **Start shift**.
5. Log a trip — watch owner dashboard earnings update live.
6. Open `/passenger/` in a third tab, look up the taxi by plate, submit a rating.
7. Watch feedback land on the owner dashboard in real time.
8. Try the **SOS** button on the driver page.

## Notes

- Auth is intentionally weak (plaintext passwords, no sessions/JWT) — prototype only.
- Document uploads (licence, PDP, ID) are stubbed — `multer` is installed but no upload endpoint is wired yet.
- QR camera scanning uses `BarcodeDetector` (Chromium only); other browsers fall back to manual plate entry.

## User preferences

_(none recorded yet)_

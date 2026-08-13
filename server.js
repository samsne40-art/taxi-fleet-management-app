const express = require('express');
const http = require('http');
const cors = require('cors');
const session = require('express-session');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');

const app = express();
const server = http.createServer(app);

// ── Allowed origins ──────────────────────────────────────────────────────────
// Set ALLOWED_ORIGINS as a comma-separated list in the environment for
// deployments that need cross-origin access (e.g. "https://myapp.com").
// When not set (typical dev / same-origin), cross-origin requests are blocked.
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : [];

// ── Socket.io (CORS restricted to same allowed origins) ──────────────────────
const io = new Server(server, {
  cors: ALLOWED_ORIGINS.length
    ? { origin: ALLOWED_ORIGINS, credentials: true }
    : { origin: false },
});

// ── Security headers (Helmet) ────────────────────────────────────────────────
// CSP is disabled because the frontends use inline scripts and styles;
// all other Helmet headers are enabled.
app.use(helmet({
  contentSecurityPolicy:    false,
  crossOriginEmbedderPolicy: false,
}));

// ── CORS — never reflect arbitrary origins with credentials ──────────────────
app.use(cors({
  origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false,
  credentials: true,
}));

app.use(express.json());

// ── Session ──────────────────────────────────────────────────────────────────
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-fallback-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    // Only transmit over HTTPS in production to prevent cookie interception
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
});
app.use(sessionMiddleware);

// ── Socket.io session & authentication ───────────────────────────────────────
// Run authentication at the Engine.IO level so that unauthenticated
// handshake requests receive a 401 HTTP response *before* Socket.io ever
// creates a socket — this is the only way to reject at the HTTP layer for
// polling transport (io.use() fires after the 200 handshake response).
io.engine.use((req, res, next) => {
  const isHandshake = req._query.sid === undefined;
  if (!isHandshake) return next(); // already connected; let it through
  // Run express-session so req.session is populated from the cookie
  sessionMiddleware(req, res, () => {
    if (req.session?.userId) return next();
    // No valid session — reject at HTTP level
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
  });
});

// Defense-in-depth: also check at Socket.io namespace level
io.use((socket, next) => {
  if (socket.request.session?.userId) return next();
  next(new Error('Unauthorized'));
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// Root is served by express.static (public/index.html — mode-selection landing page).

// ---------- Session helper routes ----------

// Returns the current session info (role + user) so the frontend
// can restore itself on page reload without re-authenticating.
app.get('/api/auth/session', (req, res) => {
  if (!req.session?.userId) return res.json({ loggedIn: false });
  res.json({
    loggedIn: true,
    role: req.session.role,
    userId: req.session.userId,
    name: req.session.name,
  });
});

// Destroys the session (works for both owners and drivers).
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- Socket.io — authenticated rooms ----------
// Each user may only join the room that matches their own session identity.
// Owners join owner_<id>; drivers join driver_<id>.
io.on('connection', (socket) => {
  const { userId, role } = socket.request.session;

  socket.on('join_owner_room', (ownerId) => {
    if (role === 'owner' && parseInt(ownerId) === userId) {
      socket.join(`owner_${ownerId}`);
    }
    // Silently ignore requests to join rooms the user does not own
  });

  socket.on('join_driver_room', (driverId) => {
    if (role === 'driver' && parseInt(driverId) === userId) {
      socket.join(`driver_${driverId}`);
    }
  });
});

// ---------- Rate limiting ----------
// Custom post-response failure counter.
//
// Why not express-rate-limit with skipSuccessfulRequests?
//   express-rate-limit increments the counter BEFORE the route handler runs.
//   Once the counter >= max, the 429 fires before credentials are checked —
//   so even a correct password gets blocked.  skipSuccessfulRequests can
//   prevent successes from adding to the count but cannot rescue a request
//   that is already over the limit.
//
// This implementation wraps res.json and counts only AFTER the handler
// responds:
//   - status >= 400  → record a failure timestamp for the IP
//   - status < 400   → clear all failure timestamps for the IP (login OK)
//
// Each call to makeLoginLimiter() returns an independent middleware with its
// own in-memory store, so owner and driver endpoints never share state.
//
// Configurable via environment variables (useful in development):
//   LOGIN_RATE_WINDOW_MS  — window length in ms   (default: 900000 = 15 min)
//   LOGIN_RATE_MAX        — max failures in window (default: 10)

function makeLoginLimiter() {
  const windowMs = parseInt(process.env.LOGIN_RATE_WINDOW_MS, 10) || 15 * 60 * 1000;
  const max      = parseInt(process.env.LOGIN_RATE_MAX,        10) || 10;

  // ip → [timestamp, …]  (only failure timestamps are stored)
  const store = new Map();

  function failureCount(ip) {
    const cutoff = Date.now() - windowMs;
    const times  = (store.get(ip) || []).filter(t => t > cutoff);
    if (times.length === 0) store.delete(ip);
    else store.set(ip, times);
    return times.length;
  }

  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    // Pre-check: block if already at/over the limit
    if (failureCount(ip) >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({
        error: `Too many failed login attempts. Please try again in ${Math.ceil(windowMs / 60000)} minute(s).`,
      });
    }

    // Count only AFTER the response is sent, based on status code.
    // Using res.on('finish') is more robust than wrapping res.json — it fires
    // regardless of which send method the route uses.
    res.on('finish', () => {
      if (res.statusCode >= 400) {
        // Failed login — record the timestamp
        const times = store.get(ip) || [];
        times.push(Date.now());
        store.set(ip, times);
      } else {
        // Successful login — wipe this IP's failure history
        store.delete(ip);
      }
    });

    next();
  };
}

app.use('/api/owner/login',  makeLoginLimiter());
app.use('/api/driver/login', makeLoginLimiter());

// Make io available to route handlers via app.locals
app.locals.io = io;

app.use('/api/owner', require('./routes/owner'));
app.use('/api/driver', require('./routes/driver'));
app.use('/api/passenger', require('./routes/passenger'));

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Taxi fleet app running at http://localhost:${PORT}`);
  console.log(`  Owner:     http://localhost:${PORT}/owner/`);
  console.log(`  Driver:    http://localhost:${PORT}/driver/`);
  console.log(`  Passenger: http://localhost:${PORT}/passenger/`);
});

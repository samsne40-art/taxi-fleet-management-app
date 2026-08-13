const express = require('express');
const http = require('http');
const cors = require('cors');
const session = require('express-session');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

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
// 10 failed attempts per 15-minute window per IP, tracked separately per endpoint.
// skipSuccessfulRequests: true — only failed logins count toward the limit so
// that legitimate users are never locked out by their own correct credentials.
function makeLoginLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  });
}
app.use('/api/owner/login', makeLoginLimiter());
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

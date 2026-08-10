const express = require('express');
const http = require('http');
const cors = require('cors');
const session = require('express-session');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Session middleware — SESSION_SECRET must be set in the environment
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-fallback-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

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

// ---------- Socket.io ----------

// Sockets: owners join a room keyed to their id so we can push
// live location updates, feedback, complaints and SOS alerts to them.
io.on('connection', (socket) => {
  socket.on('join_owner_room', (ownerId) => {
    socket.join(`owner_${ownerId}`);
  });
  socket.on('join_driver_room', (driverId) => {
    socket.join(`driver_${driverId}`);
  });
});

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

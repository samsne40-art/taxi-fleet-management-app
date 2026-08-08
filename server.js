const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Taxi fleet app running at http://localhost:${PORT}`);
  console.log(`  Owner:     http://localhost:${PORT}/owner/`);
  console.log(`  Driver:    http://localhost:${PORT}/driver/`);
  console.log(`  Passenger: http://localhost:${PORT}/passenger/`);
});

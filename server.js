require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const { initDB } = require('./database/db');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const volunteerRoutes = require('./routes/volunteer');
const publicRoutes = require('./routes/public');
const gameRoutes = require('./routes/game');
const { setupGameSocket } = require('./socket/gameSocket');
const { setupMeetingSocket } = require('./socket/meetingSocket');
const { setupTaskSocket } = require('./socket/taskSocket');

// Ensure required directories exist
['uploads', 'data'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 30000,
  pingInterval: 10000
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'taskforce-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,          // set true if using HTTPS
    httpOnly: true,
    maxAge: 12 * 60 * 60 * 1000  // 12h
  }
});
app.use(sessionMiddleware);

// Share session with socket.io
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// Attach io to every request so routes can emit
app.use((req, res, next) => { req.io = io; next(); });

// ─── Static files ─────────────────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/login',     express.static(path.join(__dirname, 'public/login')));
app.use('/admin',     express.static(path.join(__dirname, 'public/admin')));
app.use('/volunteer', express.static(path.join(__dirname, 'public/volunteer')));
app.use('/projector', express.static(path.join(__dirname, 'public/projector')));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth',      authRoutes);
app.use('/api/admin',     adminRoutes);
app.use('/api/volunteer', volunteerRoutes);
app.use('/api/public',    publicRoutes);
app.use('/api/game',      gameRoutes);

// Root → login
app.get('/', (req, res) => res.redirect('/login'));

// ─── Socket.io ───────────────────────────────────────────────────────────────
setupGameSocket(io);
setupMeetingSocket(io);
setupTaskSocket(io);

// ─── Global error handler ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  await initDB();

  server.listen(PORT, '0.0.0.0', () => {
    const ifaces = require('os').networkInterfaces();
    let localIP = 'localhost';
    Object.values(ifaces).flat().forEach(i => {
      if (i.family === 'IPv4' && !i.internal) localIP = i.address;
    });

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║          TASKFORCE TRAITORS — ONLINE              ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  🔐 Admin:     http://${localIP}:${PORT}/admin`);
    console.log(`║  📱 Volunteer: http://${localIP}:${PORT}/volunteer`);
    console.log(`║  📺 Projector: http://${localIP}:${PORT}/projector`);
    console.log(`║  🔑 Login:     http://${localIP}:${PORT}/login`);
    console.log('╚══════════════════════════════════════════════════╝\n');
    console.log(`  Default admin: ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD || 'taskforce2024'}\n`);
  });
})();

module.exports = { io };

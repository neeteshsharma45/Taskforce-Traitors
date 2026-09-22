const db = require('../database/db');

function setupGameSocket(io) {
  io.on('connection', socket => {
    const session = socket.request.session;

    // Join appropriate rooms
    if (session?.role === 'admin') {
      socket.join('admin');
    }
    if (session?.role === 'volunteer' && session?.teamId) {
      socket.join(`team:${session.teamId}`);
    }
    // Projector joins 'public' room (no session)
    socket.join('public');

    // Client requests full game state refresh
    socket.on('game:request_state', () => {
      socket.emit('game:state', db.getGameStats());
    });

    // Client ping for liveness
    socket.on('ping', () => socket.emit('pong'));

    socket.on('disconnect', () => {
      // No special cleanup needed for SQLite
    });
  });

  // Broadcast game state every 30s as heartbeat
  setInterval(() => {
    io.emit('game:state', db.getGameStats());
  }, 30000);
}

module.exports = { setupGameSocket };

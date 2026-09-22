const db = require('../database/db');

function setupTaskSocket(io) {
  // Check for expired timed tasks every 10s
  setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    // Find in-progress tasks that exceeded their time limit
    const expired = db.db.prepare(`
      SELECT tt.id, tt.team_id, t.time_limit, tt.started_at
      FROM team_tasks tt
      JOIN tasks t ON tt.task_id = t.id
      WHERE tt.status = 'in_progress'
        AND t.time_limit IS NOT NULL
        AND tt.started_at IS NOT NULL
        AND (tt.started_at + t.time_limit) < ?
    `).all(now);

    for (const tt of expired) {
      db.updateTeamTask(tt.id, { status: 'failed', verification_status: 'not_required' });
      io.to(`team:${tt.team_id}`).emit('task:expired', { teamTaskId: tt.id });
    }
  }, 10000);
}

module.exports = { setupTaskSocket };

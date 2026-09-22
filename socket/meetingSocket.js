const db = require('../database/db');

function setupMeetingSocket(io) {
  // Check for expired discussion → auto-open voting
  setInterval(() => {
    const m = db.getActiveMeeting();
    if (!m) return;

    const now = Math.floor(Date.now() / 1000);

    if (m.phase === 'discussion' && m.discussion_ends_at && now >= m.discussion_ends_at) {
      const settings = db.getSettings();
      const voteSecs = parseInt(settings.voting_timer_secs || 120);
      const voteEnd  = now + voteSecs;
      db.updateMeeting(m.id, { phase: 'voting', voting_starts_at: now, voting_ends_at: voteEnd });
      io.emit('meeting:voting_open', { meetingId: m.id, voteEnd });
    }

    if (m.phase === 'voting' && m.voting_ends_at && now >= m.voting_ends_at) {
      // Auto-close: admin must manually reveal — just emit warning
      io.to('admin').emit('meeting:voting_ended', { meetingId: m.id, message: 'Voting closed — click Reveal Result' });
    }
  }, 5000);
}

module.exports = { setupMeetingSocket };

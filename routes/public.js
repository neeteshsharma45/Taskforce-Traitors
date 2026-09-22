const express = require('express');
const router  = express.Router();
const db      = require('../database/db');

// GET /api/public/state  — safe game state (no role/imposter data leaked)
router.get('/state', (req, res) => {
  const stats   = db.getGameStats();
  const alive   = db.getAliveTeams();
  const session = db.getActiveSession();

  // Public team list — NEVER expose role
  const teams = db.getTeams().map(t => {
    const tasks     = db.getTeamTasks(t.id);
    const completed = tasks.filter(x => x.status === 'completed' && (x.verification_status === 'approved' || x.verification_status === 'not_required')).length;
    return {
      id:       t.id,
      name:     t.name,
      status:   t.status,
      tasks:    tasks.length,
      completed,
      points:   t.total_points
      // role is deliberately omitted
    };
  });

  res.json({
    phase:           session?.phase || 'LOBBY',
    crewAlive:       stats.crewAlive,
    imposterAlive:   stats.imposterAlive,
    crewTotal:       stats.crewTotal,
    imposterTotal:   stats.imposterTotal,
    totalTeams:      stats.totalTeams,
    completedTasks:  stats.completedTasks,
    totalTasks:      stats.totalTasks,
    winner:          session?.winner || null,
    teams,
    rolesAssigned:   db.getSetting('roles_assigned') === '1'
  });
});

// GET /api/public/feed — activity log for the projector
router.get('/feed', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || 50), 100);
  res.json(db.getActivity(limit, true));
});

// GET /api/public/meeting — active meeting state (no vote identities)
router.get('/meeting', (req, res) => {
  const m = db.getActiveMeeting();
  if (!m) return res.json(null);
  const votes = db.getVoteTally(m.id);
  const total = db.getAliveTeams().length;
  res.json({
    id:       m.id,
    phase:    m.phase,
    calledBy: db.getTeam(m.called_by_team_id)?.name || 'Unknown',
    reason:   m.reason || '',
    discEnd:  m.discussion_ends_at,
    voteEnd:  m.voting_ends_at,
    // During voting: show count but hide names until reveal
    voteCount: votes.reduce((s, v) => s + v.count, 0),
    totalEligible: total
  });
});

module.exports = router;

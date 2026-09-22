const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const Jimp     = require('jimp');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const router   = express.Router();

const { requireAdmin } = require('../middleware/auth');
const db = require('../database/db');
const { selectImposters, DEFAULT_SECRET_MISSIONS } = require('../services/roleEngine');
const { generateTaskSet }  = require('../services/taskEngine');
const { buildLeaderboard, buildExportData } = require('../services/scoringEngine');
const { checkWinConditions, endGame } = require('../services/gameEngine');

// ─── Multer (proof photos) ────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.memoryStorage();
const upload  = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|jpg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

// ─── All admin routes require admin session ───────────────────────────────────
router.use(requireAdmin);

// ═══════════════════════════════════════════════════════════════════════════════
// OVERVIEW
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/overview', (req, res) => {
  res.json(db.getGameStats());
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEAMS
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/teams', (req, res) => {
  const teams = db.getTeams();
  // Admin sees roles — attach volunteer info
  const volunteers = db.getVolunteers();
  const volByTeam  = Object.fromEntries(volunteers.map(v => [v.team_id, v]));
  res.json(teams.map(t => ({ ...t, volunteer: volByTeam[t.id] || null })));
});

router.post('/teams', (req, res) => {
  const { name, member1, member2, member3, volunteerName } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const teamId = db.createTeam(name, member1, member2, member3);
  let volunteer = null;
  if (volunteerName) {
    volunteer = db.createVolunteer(volunteerName, teamId);
  }
  db.addActivity('TEAM_CREATED', `Team "${name}" created`, { teamId }, 0);
  res.json({ ok: true, teamId, volunteer });
});

router.put('/teams/:id', (req, res) => {
  const team = db.getTeam(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  db.updateTeam(req.params.id, req.body);
  db.auditLog(req.session.userId, 'TEAM_UPDATED', req.params.id, JSON.stringify(req.body));
  res.json({ ok: true });
});

router.delete('/teams/:id', (req, res) => {
  db.deleteTeam(req.params.id);
  res.json({ ok: true });
});

// Bulk CSV import
router.post('/teams/bulk', (req, res) => {
  const { teams } = req.body; // [{ name, member1, member2, member3, volunteerName }]
  if (!Array.isArray(teams)) return res.status(400).json({ error: 'teams array required' });

  const results = [];
  for (const t of teams) {
    try {
      const teamId = db.createTeam(t.name, t.member1, t.member2, t.member3);
      let volunteer = null;
      if (t.volunteerName) volunteer = db.createVolunteer(t.volunteerName, teamId);
      results.push({ name: t.name, teamId, volunteer });
    } catch (err) {
      results.push({ name: t.name, error: err.message });
    }
  }
  res.json({ ok: true, results });
});

// Volunteer management
router.post('/teams/:id/volunteer', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const existing = db.getVolunteerByTeam(req.params.id);
  if (existing) return res.status(409).json({ error: 'Team already has a volunteer' });
  const result = db.createVolunteer(name, req.params.id);
  res.json({ ok: true, ...result });
});

// Regenerate volunteer PIN
router.post('/teams/:id/volunteer/reset-pin', (req, res) => {
  const vol = db.getVolunteerByTeam(req.params.id);
  if (!vol) return res.status(404).json({ error: 'No volunteer for this team' });
  const pin = Math.floor(100000 + Math.random() * 900000).toString();
  const bcrypt = require('bcryptjs');
  db.db.prepare('UPDATE volunteers SET pin_hash=?, pin_display=? WHERE team_id=?')
    .run(bcrypt.hashSync(pin, 10), pin, req.params.id);
  db.auditLog(req.session.userId, 'PIN_RESET', req.params.id, null);
  res.json({ ok: true, pin });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROLE ASSIGNMENT
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/assign-roles', (req, res) => {
  const teams    = db.getTeams();
  const settings = db.getSettings();
  const count    = parseInt(req.body.imposterCount || settings.total_imposter_teams || 5);

  if (teams.length < count) return res.status(400).json({ error: 'Not enough teams' });

  const { imposterIds, crewIds } = selectImposters(teams, count);
  db.assignRoles(imposterIds);

  // Create secret missions for each imposter team
  for (const id of imposterIds) {
    DEFAULT_SECRET_MISSIONS.forEach(m => db.createSecretMission(id, m));
  }

  db.setSetting('roles_assigned', '1');
  db.auditLog(req.session.userId, 'ROLES_ASSIGNED', null, JSON.stringify({ imposterIds }));
  db.addActivity('ROLES_ASSIGNED', '🎭 Roles have been secretly assigned. Let the game begin!', {}, 1);

  req.io.emit('game:roles_assigned', { rolesAssigned: true });
  res.json({ ok: true, imposterCount: imposterIds.length, crewCount: crewIds.length });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATIONS
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/stations',       (req, res) => res.json(db.getStations()));
router.post('/stations',      (req, res) => res.json({ ok: true, id: db.createStation(req.body) }));
router.put('/stations/:id',   (req, res) => { db.updateStation(req.params.id, req.body); res.json({ ok: true }); });
router.delete('/stations/:id',(req, res) => { db.deleteStation(req.params.id); res.json({ ok: true }); });

// ═══════════════════════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/tasks',       (req, res) => res.json(db.getTasks()));
router.post('/tasks',      (req, res) => res.json({ ok: true, id: db.createTask(req.body) }));
router.put('/tasks/:id',   (req, res) => { db.updateTask(req.params.id, req.body); res.json({ ok: true }); });
router.delete('/tasks/:id',(req, res) => { db.deleteTask(req.params.id); res.json({ ok: true }); });

// Auto-assign tasks to teams
router.post('/tasks/auto-assign', (req, res) => {
  const teams    = db.getTeams();
  const allTasks = db.getTasks();
  const settings = db.getSettings();
  const { quotas } = req.body; // { quiz: 2, photo_proof: 1, ... }

  const min = parseInt(settings.tasks_per_team_min || 8);
  const max = parseInt(settings.tasks_per_team_max || 12);

  let assigned = 0;
  for (const team of teams) {
    const taskIds = generateTaskSet(allTasks, quotas || {}, min, max);
    for (const taskId of taskIds) {
      db.assignTaskToTeam(team.id, taskId);
      assigned++;
    }
  }
  db.addActivity('TASKS_ASSIGNED', `Tasks auto-assigned to ${teams.length} teams`, {}, 0);
  res.json({ ok: true, assigned });
});

// Manual assign single task to team
router.post('/tasks/assign', (req, res) => {
  const { teamId, taskId } = req.body;
  if (!teamId || !taskId) return res.status(400).json({ error: 'teamId and taskId required' });
  db.assignTaskToTeam(teamId, taskId);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION QUEUE
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/verify-queue', (req, res) => {
  res.json(db.getPendingVerifications());
});

router.post('/verify/:teamTaskId', async (req, res) => {
  const { action, note } = req.body; // action: 'approve' | 'reject'
  const tt = db.getTeamTask(req.params.teamTaskId);
  if (!tt) return res.status(404).json({ error: 'Submission not found' });

  const now = Math.floor(Date.now() / 1000);

  if (action === 'approve') {
    db.updateTeamTask(tt.id, {
      verification_status: 'approved',
      verified_by:         req.session.userId,
      verified_at:         now,
      status:              'completed',
      points_awarded:      tt.points
    });
    db.addPoints(tt.team_id, tt.points);
    db.auditLog(req.session.userId, 'TASK_APPROVED', tt.id, null);
    db.addActivity('TASK_VERIFIED', `✅ Task "${tt.title}" approved for team`, { teamId: tt.team_id, taskId: tt.task_id }, 0);

    req.io.to(`team:${tt.team_id}`).emit('task:verified', { teamTaskId: tt.id, status: 'approved', points: tt.points });
    req.io.emit('game:state', db.getGameStats());
  } else if (action === 'reject') {
    db.updateTeamTask(tt.id, {
      verification_status: 'rejected',
      verified_by:         req.session.userId,
      verified_at:         now,
      status:              'rejected',
      rejection_note:      note || ''
    });
    db.auditLog(req.session.userId, 'TASK_REJECTED', tt.id, note);
    req.io.to(`team:${tt.team_id}`).emit('task:verified', { teamTaskId: tt.id, status: 'rejected', note });
  } else {
    return res.status(400).json({ error: 'action must be approve or reject' });
  }

  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// KILL MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/kills', (req, res) => res.json(db.getKillEvents()));
router.get('/kills/pending', (req, res) => res.json(db.getPendingKills()));

router.post('/kills/:id/approve', (req, res) => {
  const kill = db.getKillEvent(req.params.id);
  if (!kill) return res.status(404).json({ error: 'Kill not found' });
  if (kill.status === 'approved') return res.status(400).json({ error: 'Already approved' });

  const now = Math.floor(Date.now() / 1000);
  db.updateKillEvent(kill.id, { status: 'approved', approved_by: req.session.userId, approved_at: now });
  db.eliminateTeam(kill.victim_team_id);
  db.incrementKills(kill.imposter_team_id);
  db.auditLog(req.session.userId, 'KILL_APPROVED', kill.id, null);

  const victimTeam = db.getTeam(kill.victim_team_id);
  db.addActivity('ELIMINATION', `☠️ Team "${victimTeam?.name}" has been eliminated!`, { victimTeamId: kill.victim_team_id }, 1);

  req.io.to(`team:${kill.victim_team_id}`).emit('kill:approved', { eliminated: true });
  req.io.emit('kill:approved', { victimTeamId: kill.victim_team_id, victimName: victimTeam?.name });
  req.io.emit('game:state', db.getGameStats());

  // Check win conditions
  const winner = checkWinConditions(req.io);
  if (winner) endGame(winner, req.io);

  res.json({ ok: true });
});

router.post('/kills/:id/reject', (req, res) => {
  const { reason } = req.body;
  db.updateKillEvent(req.params.id, { status: 'rejected', rejection_reason: reason || '' });
  db.auditLog(req.session.userId, 'KILL_REJECTED', req.params.id, reason);
  req.io.to(`kill:${req.params.id}`).emit('kill:rejected', { reason });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MEETING MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/meetings', (req, res) => res.json(db.getMeetings()));
router.get('/meetings/active', (req, res) => {
  const m = db.getActiveMeeting();
  if (!m) return res.json(null);
  const votes = db.getVoteTally(m.id);
  res.json({ ...m, tally: votes });
});

// Force-start a meeting (admin only)
router.post('/meetings/start', (req, res) => {
  const active = db.getActiveMeeting();
  if (active) return res.status(400).json({ error: 'Meeting already active' });

  const settings = db.getSettings();
  const session  = db.getActiveSession();
  const discSecs = parseInt(settings.discussion_timer_secs || 180);

  const { id, now, discEnd } = db.createMeeting(
    req.body.calledByTeamId || 'admin',
    req.body.reason || 'Admin-called meeting',
    discSecs,
    session?.id
  );
  db.updateSessionPhase('MEETING');
  db.addActivity('MEETING_CALLED', '🔔 Emergency meeting called!', { meetingId: id }, 1);
  req.io.emit('meeting:called', { meetingId: id, discEnd, reason: req.body.reason || '' });
  res.json({ ok: true, meetingId: id });
});

// Open voting
router.post('/meetings/:id/open-voting', (req, res) => {
  const m = db.getMeeting(req.params.id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  const settings = db.getSettings();
  const voteSecs = parseInt(settings.voting_timer_secs || 120);
  const now      = Math.floor(Date.now() / 1000);
  const voteEnd  = now + voteSecs;
  db.updateMeeting(m.id, { phase: 'voting', voting_starts_at: now, voting_ends_at: voteEnd });
  req.io.emit('meeting:voting_open', { meetingId: m.id, voteEnd });
  res.json({ ok: true, voteEnd });
});

// Reveal result
router.post('/meetings/:id/reveal', (req, res) => {
  const m = db.getMeeting(req.params.id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });

  const tally    = db.getVoteTally(m.id);
  const settings = db.getSettings();
  let ejectedTeamId = null;
  let wasImposter   = null;

  if (tally.length > 0) {
    const top    = tally[0];
    const second = tally[1];
    const tied   = second && second.count === top.count;

    if (!tied) {
      ejectedTeamId = top.target_team_id;
    } else if (settings.tie_vote_action === 'skip') {
      ejectedTeamId = null; // tie → no ejection
    }
  }

  if (ejectedTeamId) {
    const ejected = db.getTeam(ejectedTeamId);
    wasImposter   = ejected?.role === 'imposter' ? 1 : 0;
    db.eliminateTeam(ejectedTeamId);
    db.addActivity('EJECTION', `${wasImposter ? '🎭' : '😇'} "${ejected?.name}" was voted out — they were ${wasImposter ? 'an IMPOSTER' : 'NOT an imposter'}!`, { ejectedTeamId, wasImposter }, 1);
    if (wasImposter) db.awardAchievement(null, 'detective'); // awarded per voter below
  } else {
    db.addActivity('VOTE_SKIPPED', '⚖️ Vote tied — no ejection.', {}, 1);
  }

  db.updateMeeting(m.id, {
    phase:             'closed',
    closed_at:         Math.floor(Date.now() / 1000),
    voted_out_team_id: ejectedTeamId,
    was_imposter:      wasImposter
  });
  db.updateSessionPhase('MISSION');

  req.io.emit('meeting:result', {
    meetingId: m.id,
    ejectedTeamId,
    ejectedName:  ejectedTeamId ? db.getTeam(ejectedTeamId)?.name : null,
    wasImposter,
    tally
  });

  const winner = checkWinConditions(req.io);
  if (winner) endGame(winner, req.io);

  res.json({ ok: true, ejectedTeamId, wasImposter });
});

// Close meeting without reveal (admin override)
router.post('/meetings/:id/close', (req, res) => {
  db.updateMeeting(req.params.id, { phase: 'closed', closed_at: Math.floor(Date.now() / 1000) });
  db.updateSessionPhase('MISSION');
  req.io.emit('meeting:closed', { meetingId: req.params.id });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GAME PHASE
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/game/start', (req, res) => {
  db.startSession();
  db.addActivity('GAME_STARTED', '🚀 Game has started! Crew and Imposters — begin your missions.', {}, 1);
  req.io.emit('game:phase', { phase: 'MISSION' });
  res.json({ ok: true });
});

router.post('/game/end', (req, res) => {
  const { winner } = req.body;
  const stats = endGame(winner || 'crew', req.io);
  res.json({ ok: true, stats });
});

router.post('/game/reset', (req, res) => {
  // Hard reset — start fresh session
  db.db.prepare("UPDATE teams SET role='crew', status='alive', kill_count=0, meetings_called=0, total_points=0").run();
  db.db.prepare('DELETE FROM team_tasks').run();
  db.db.prepare('DELETE FROM kill_events').run();
  db.db.prepare('DELETE FROM meetings').run();
  db.db.prepare('DELETE FROM votes').run();
  db.db.prepare('DELETE FROM secret_missions').run();
  db.db.prepare('DELETE FROM achievements').run();
  db.db.prepare('DELETE FROM activity_log').run();
  db.setSetting('roles_assigned', '0');
  db.resetSession();
  db.addActivity('GAME_RESET', '🔄 Game has been reset. Ready for a new round!', {}, 1);
  req.io.emit('game:phase', { phase: 'LOBBY' });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/settings',     (req, res) => res.json(db.getSettings()));
router.put('/settings',     (req, res) => {
  for (const [k, v] of Object.entries(req.body)) db.setSetting(k, v);
  db.auditLog(req.session.userId, 'SETTINGS_UPDATED', null, JSON.stringify(req.body));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYTICS & EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/leaderboard', (req, res) => res.json(buildLeaderboard()));

router.get('/activity',    (req, res) => res.json(db.getActivity(200)));

router.get('/export', async (req, res) => {
  const { stringify } = require('csv-stringify/sync');
  const rows = buildExportData();
  const csv  = stringify(rows, { header: true });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="taskforce-traitors-export-${Date.now()}.csv"`);
  res.send(csv);
});

// Audit log
router.get('/audit', (req, res) => {
  const rows = db.db.prepare('SELECT * FROM admin_audit_log ORDER BY timestamp DESC LIMIT 500').all();
  res.json(rows);
});

module.exports = router;

const express   = require('express');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const Jimp      = require('jimp');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const router    = express.Router();

const { requireVolunteer, requireAliveTeam, requireImposter } = require('../middleware/auth');
const db = require('../database/db');
const { validateSubmission } = require('../services/taskEngine');
const { checkWinConditions, endGame } = require('../services/gameEngine');

// ─── Multer (proof photos, EXIF-stripped via sharp) ──────────────────────────
const uploadDir = path.join(__dirname, '..', 'uploads');
const upload    = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// ─── Rate limiters ────────────────────────────────────────────────────────────
const meetingRateLimit = rateLimit({
  windowMs:    60 * 60 * 1000, // 1 hour
  max:         10,
  keyGenerator: req => req.session?.teamId || req.ip,
  message:     { error: 'Too many meeting calls — try later' }
});

const killRateLimit = rateLimit({
  windowMs:    10 * 60 * 1000, // 10 minutes
  max:         3,
  keyGenerator: req => req.session?.teamId || req.ip,
  message:     { error: 'Too many kill reports — slow down' }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MY TEAM INFO
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/me', requireVolunteer, (req, res) => {
  const { team, volunteer } = req;
  // Return team role only to this team's own volunteer
  res.json({
    volunteerId:   volunteer.id,
    volunteerName: volunteer.name,
    team: {
      id:      team.id,
      name:    team.name,
      status:  team.status,
      role:    team.role,     // ← safe: only sent to THIS team's session
      member1: team.member1,
      member2: team.member2,
      member3: team.member3,
      kills:   team.kill_count,
      points:  team.total_points
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATIONS
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/stations', requireVolunteer, (req, res) => {
  const stations = db.getStations().filter(s => s.is_active !== 0);
  res.json(stations);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/tasks', requireVolunteer, (req, res) => {
  let tasks = db.getTeamTasks(req.team.id);
  if (req.query.station_id) {
    tasks = tasks.filter(t => t.station_id === req.query.station_id);
  }
  const safeTasks = tasks.map(t => {
    // Never send correct_answer to client
    const { correct_answer, ...safe } = t;
    return safe;
  });
  res.json(safeTasks);
});

// Start a task (set started_at server-side)
const handleTaskStart = (req, res) => {
  const teamTaskId = req.params.teamTaskId || req.body.task_id || req.body.team_task_id;
  let tt = teamTaskId ? db.getTeamTask(teamTaskId) : null;
  if (!tt && req.body.task_id) {
    tt = db.getTeamTaskByIds(req.team.id, req.body.task_id);
  }
  if (!tt) return res.status(404).json({ error: 'Task not found for your team' });
  if (tt.team_id !== req.team.id) return res.status(403).json({ error: 'Not your task' });

  if (tt.status === 'assigned') {
    db.updateTeamTask(tt.id, { status: 'in_progress', started_at: Math.floor(Date.now() / 1000) });
    req.io.emit('task:started', { teamId: req.team.id, teamTaskId: tt.id });
  }

  const { correct_answer, ...safeTask } = tt;
  res.json({ ok: true, startedAt: Math.floor(Date.now() / 1000), ...safeTask });
};

router.post('/tasks/start', requireAliveTeam, handleTaskStart);
router.post('/tasks/:teamTaskId/start', requireAliveTeam, handleTaskStart);

// Submit answer / proof
const handleTaskSubmit = async (req, res) => {
  const teamTaskId = req.params.teamTaskId || req.body.team_task_id || req.body.task_id;
  let tt = teamTaskId ? db.getTeamTask(teamTaskId) : null;
  if (!tt && req.body.task_id) {
    tt = db.getTeamTaskByIds(req.team.id, req.body.task_id);
  }
  if (!tt) return res.status(404).json({ error: 'Task not found' });
  if (tt.team_id !== req.team.id) return res.status(403).json({ error: 'Not your task' });
  if (tt.status === 'completed') return res.status(400).json({ error: 'Already completed' });

  const now      = Math.floor(Date.now() / 1000);
  const timeTaken = tt.started_at ? now - tt.started_at : null;
  let proofUrl    = null;

  const file = req.file || req.files?.proof?.[0] || req.files?.proof_image?.[0];

  // Handle image upload — strip EXIF with Jimp
  if (file) {
    const filename = `${uuidv4()}.jpg`;
    const destPath = path.join(uploadDir, filename);
    try {
      const img = await Jimp.read(file.buffer);
      await img.quality(80).writeAsync(destPath);
      proofUrl = `/uploads/${filename}`;
    } catch (e) {
      return res.status(500).json({ error: 'Image processing failed' });
    }
  }

  const answer = req.body.answer || '';
  const { valid, autoApproved, reason } = validateSubmission(tt, answer);
  if (!valid) return res.status(400).json({ error: reason });

  const verStatus = autoApproved ? 'not_required' :
                    tt.verification_type === 'auto' ? 'not_required' : 'pending';

  db.updateTeamTask(tt.id, {
    status:              autoApproved ? 'completed' : 'submitted',
    completed_at:        autoApproved ? now : null,
    time_taken_secs:     timeTaken,
    attempts:            (tt.attempts || 0) + 1,
    proof_url:           proofUrl,
    answer_submitted:    answer || null,
    verification_status: verStatus,
    points_awarded:      autoApproved ? tt.points : 0
  });

  if (autoApproved) {
    db.addPoints(req.team.id, tt.points);
    db.addActivity('TASK_COMPLETED', `✅ A team completed a task!`, { teamId: req.team.id }, 0);
    req.io.to(`team:${req.team.id}`).emit('task:verified', { teamTaskId: tt.id, status: 'approved', points: tt.points });
    req.io.emit('game:state', db.getGameStats());
    const winner = checkWinConditions(req.io);
    if (winner) endGame(winner, req.io);
  } else {
    req.io.emit('task:submitted', { teamId: req.team.id, teamTaskId: tt.id });
  }

  res.json({ ok: true, autoApproved, message: reason });
};

const uploadMiddleware = upload.fields([
  { name: 'proof', maxCount: 1 },
  { name: 'proof_image', maxCount: 1 }
]);

router.post('/tasks/submit', requireAliveTeam, uploadMiddleware, handleTaskSubmit);
router.post('/tasks/:teamTaskId/submit', requireAliveTeam, uploadMiddleware, handleTaskSubmit);

// ═══════════════════════════════════════════════════════════════════════════════
// KILL REPORTS (imposter only)
// ═══════════════════════════════════════════════════════════════════════════════
const handleKill = (req, res) => {
  const victimTeamId = req.body.victimTeamId || req.body.victim_team_id;
  const evidenceNote = req.body.evidenceNote || req.body.kill_method || '';
  if (!victimTeamId) return res.status(400).json({ error: 'victimTeamId required' });

  const victim = db.getTeam(victimTeamId);
  if (!victim)                         return res.status(404).json({ error: 'Victim team not found' });
  if (victim.status !== 'alive')       return res.status(400).json({ error: 'Victim already eliminated' });
  if (victim.role === 'imposter')      return res.status(400).json({ error: 'Cannot kill another imposter' });
  if (db.hasPendingKillAgainst(victimTeamId)) {
    return res.status(400).json({ error: 'There is already a pending kill against this team' });
  }

  const settings = db.getSettings();
  const killId   = db.createKillEvent(req.team.id, victimTeamId, req.volunteer.id, evidenceNote, parseInt(settings.kill_ack_window_secs || 90));

  db.addActivity('KILL_REPORTED', `⚠️ Kill reported — awaiting acknowledgment`, { killId }, 0);

  // Notify victim team to acknowledge
  req.io.to(`team:${victimTeamId}`).emit('kill:reported', {
    killId,
    ackDeadline: Math.floor(Date.now() / 1000) + parseInt(settings.kill_ack_window_secs || 90),
    message:     'You have been targeted! Acknowledge within the time window.'
  });

  // Notify admin
  req.io.to('admin').emit('kill:reported', {
    killId,
    imposterTeamId: req.team.id,
    imposterName:   req.team.name,
    victimTeamId,
    victimName:     victim.name,
    evidenceNote
  });

  res.json({ ok: true, killId });
};

router.post('/kill', killRateLimit, requireAliveTeam, requireImposter, handleKill);
router.post('/imposter/kill', killRateLimit, requireAliveTeam, requireImposter, handleKill);

// Victim acknowledges the kill
router.post('/kill/:killId/acknowledge', requireAliveTeam, (req, res) => {
  const kill = db.getKillEvent(req.params.killId);
  if (!kill)                                   return res.status(404).json({ error: 'Kill event not found' });
  if (kill.victim_team_id !== req.team.id)     return res.status(403).json({ error: 'Not your kill to acknowledge' });
  if (kill.status !== 'pending_ack')           return res.status(400).json({ error: 'Kill already processed' });

  const now = Math.floor(Date.now() / 1000);
  if (now > kill.ack_deadline) {
    db.updateKillEvent(kill.id, { status: 'rejected', rejection_reason: 'Ack window expired' });
    return res.status(400).json({ error: 'Acknowledgment window expired — kill voided' });
  }

  db.updateKillEvent(kill.id, { status: 'pending_admin', acknowledged_at: now });
  req.io.to('admin').emit('kill:acknowledged', { killId: kill.id, victimTeamId: req.team.id });
  res.json({ ok: true, message: 'Acknowledged — awaiting admin approval' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EMERGENCY MEETING
// ═══════════════════════════════════════════════════════════════════════════════
const handleMeeting = (req, res) => {
  const settings = db.getSettings();
  const maxPerTeam = parseInt(settings.max_meetings_per_team || 2);

  if (req.team.meetings_called >= maxPerTeam) {
    return res.status(429).json({ error: `Your team has reached the meeting call limit (${maxPerTeam})` });
  }

  const active = db.getActiveMeeting();
  if (active) return res.status(400).json({ error: 'A meeting is already in progress' });

  const session  = db.getActiveSession();
  const discSecs = parseInt(settings.discussion_timer_secs || 180);
  const { id, discEnd } = db.createMeeting(req.team.id, req.body.reason || '', discSecs, session?.id);

  db.updateSessionPhase('MEETING');
  db.addActivity('MEETING_CALLED', `🔔 Emergency meeting called by "${req.team.name}"!`, { meetingId: id, reason: req.body.reason }, 1);

  req.io.emit('meeting:called', {
    meetingId:  id,
    calledBy:   req.team.name,
    reason:     req.body.reason || '',
    discEnd
  });

  res.json({ ok: true, meetingId: id, discEnd });
};

router.post('/meeting', meetingRateLimit, requireAliveTeam, handleMeeting);
router.post('/emergency-meeting', meetingRateLimit, requireAliveTeam, handleMeeting);

// ═══════════════════════════════════════════════════════════════════════════════
// VOTING
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/vote', requireVolunteer, (req, res) => {
  // Team must be alive to vote
  if (req.team.status !== 'alive') return res.status(403).json({ error: 'Eliminated teams cannot vote' });

  const meeting = db.getActiveMeeting();
  if (!meeting)                      return res.status(400).json({ error: 'No active meeting' });
  if (meeting.phase !== 'voting')    return res.status(400).json({ error: 'Voting is not open yet' });

  const now = Math.floor(Date.now() / 1000);
  if (meeting.voting_ends_at && now > meeting.voting_ends_at) {
    return res.status(400).json({ error: 'Voting has closed' });
  }
  if (db.hasVoted(meeting.id, req.team.id)) {
    return res.status(400).json({ error: 'Your team has already voted' });
  }

  const targetTeamId = req.body.targetTeamId !== undefined ? req.body.targetTeamId : req.body.voted_team_id;
  const finalTarget = (targetTeamId === 'skip' || !targetTeamId) ? null : targetTeamId;

  db.castVote(meeting.id, req.team.id, finalTarget);

  const tally = db.getVoteTally(meeting.id);
  req.io.to('admin').emit('vote:tally', { meetingId: meeting.id, tally });
  req.io.emit('vote:cast', { meetingId: meeting.id, count: tally.length });

  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECRET MISSIONS (imposter only)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/secret-missions', requireImposter, (req, res) => {
  res.json(db.getSecretMissions(req.team.id));
});

router.post('/secret-missions/:id/complete', requireImposter, (req, res) => {
  const missions = db.getSecretMissions(req.team.id);
  const mission  = missions.find(m => m.id === req.params.id);
  if (!mission) return res.status(403).json({ error: 'Not your mission' });
  db.completeSecretMission(mission.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVE MEETING STATE (for volunteer to poll)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/active-meeting', requireVolunteer, (req, res) => {
  const m = db.getActiveMeeting();
  if (!m) return res.json(null);
  const voted = db.hasVoted(m.id, req.team.id);
  const aliveTeams = db.getAliveTeams().map(t => ({ id: t.id, name: t.name }));
  res.json({ ...m, hasVoted: voted, aliveTeams });
});

module.exports = router;


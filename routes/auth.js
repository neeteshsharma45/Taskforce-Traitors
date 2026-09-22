const express = require('express');
const bcrypt  = require('bcryptjs');
const router  = express.Router();
const {
  getAdminByUsername, getVolunteer, getVolunteerByTeam, getTeam, verifyVolunteerPin, getTeams
} = require('../database/db');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { type, username, password, teamId, pin } = req.body;

  try {
    if (type === 'admin') {
      const user = getAdminByUsername(username || 'admin');
      if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      req.session.userId   = user.id;
      req.session.role     = 'admin';
      req.session.username = user.username;
      return res.json({ ok: true, role: 'admin', redirect: '/admin' });
    }

    if (type === 'volunteer') {
      if (!teamId || !pin) return res.status(400).json({ error: 'teamId and pin required' });
      const vol = verifyVolunteerPin(teamId, String(pin));
      if (!vol) return res.status(401).json({ error: 'Invalid team PIN' });
      const team = getTeam(vol.team_id);
      req.session.userId  = vol.id;
      req.session.role    = 'volunteer';
      req.session.teamId  = vol.team_id;
      return res.json({ ok: true, role: 'volunteer', redirect: '/volunteer', team: { id: team.id, name: team.name, status: team.status } });
    }

    return res.status(400).json({ error: 'type must be admin or volunteer' });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });

  if (req.session.role === 'admin') {
    return res.json({ role: 'admin', username: req.session.username });
  }

  // Volunteer — return team info but NEVER expose role (crew/imposter) here to wrong client
  const vol  = getVolunteer(req.session.userId);
  const team = vol ? getTeam(vol.team_id) : null;
  if (!team) return res.status(404).json({ error: 'Team not found' });

  return res.json({
    role:       'volunteer',
    volunteerId: vol.id,
    volunteerName: vol.name,
    team: {
      id:      team.id,
      name:    team.name,
      status:  team.status,
      member1: team.member1,
      member2: team.member2,
      member3: team.member3,
      // Only expose team role to the volunteer who belongs to that team
      teamRole: team.role
    }
  });
});

// GET /api/auth/teams  — public list for login screen team selector
router.get('/teams', (req, res) => {
  const teams = getTeams().map(t => ({ id: t.id, name: t.name }));
  res.json(teams);
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

module.exports = router;

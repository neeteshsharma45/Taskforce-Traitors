const { getAdminByUsername, getVolunteer, getTeam } = require('../database/db');

/**
 * Require any authenticated session (admin or volunteer)
 */
function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

/**
 * Require admin session
 */
function requireAdmin(req, res, next) {
  if (!req.session?.userId || req.session?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Require volunteer session — attaches req.volunteer and req.team
 */
function requireVolunteer(req, res, next) {
  if (!req.session?.userId || req.session?.role !== 'volunteer') {
    return res.status(403).json({ error: 'Volunteer access required' });
  }
  const volunteer = getVolunteer(req.session.userId);
  if (!volunteer) return res.status(403).json({ error: 'Volunteer not found' });

  const team = getTeam(volunteer.team_id);
  if (!team) return res.status(403).json({ error: 'Team not found' });

  req.volunteer = volunteer;
  req.team      = team;
  next();
}

/**
 * Require volunteer whose team is alive
 */
function requireAliveTeam(req, res, next) {
  requireVolunteer(req, res, () => {
    if (req.team.status !== 'alive') {
      return res.status(403).json({ error: 'Your team has been eliminated' });
    }
    next();
  });
}

/**
 * Require volunteer whose team is an imposter
 */
function requireImposter(req, res, next) {
  requireVolunteer(req, res, () => {
    if (req.team.role !== 'imposter') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin, requireVolunteer, requireAliveTeam, requireImposter };

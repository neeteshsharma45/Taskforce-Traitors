const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const { requireAdmin } = require('../middleware/auth');

// GET /api/game/state — full state for admin
router.get('/state', requireAdmin, (req, res) => {
  res.json(db.getGameStats());
});

// GET /api/game/phase
router.get('/phase', (req, res) => {
  const s = db.getActiveSession();
  res.json({ phase: s?.phase || 'LOBBY', winner: s?.winner });
});

module.exports = router;

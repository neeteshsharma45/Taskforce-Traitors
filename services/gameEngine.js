const db = require('../database/db');

/**
 * Check win conditions and return winner string or null.
 * Called after every kill approval and every meeting close.
 */
function checkWinConditions(io) {
  const settings = db.getSettings();
  const aliveTeams    = db.getAliveTeams();
  const crewAlive     = aliveTeams.filter(t => t.role === 'crew').length;
  const imposterAlive = aliveTeams.filter(t => t.role === 'imposter').length;

  // Imposters win: imposter count >= crew count (Among Us rule)
  const imposterRatio = parseFloat(settings.imposter_ratio_win || '1');
  if (imposterAlive > 0 && imposterAlive >= crewAlive * imposterRatio) {
    return 'imposters';
  }

  // Imposters win: all crew eliminated
  if (crewAlive === 0) return 'imposters';

  // Crew wins: all imposters eliminated
  if (imposterAlive === 0) return 'crew';

  // Crew wins: task completion target reached
  const crewTaskPct = parseFloat(settings.crew_task_win_pct || '70') / 100;
  const totalTasks  = db.db.prepare("SELECT COUNT(*) as c FROM team_tasks WHERE team_id IN (SELECT id FROM teams WHERE role='crew')").get().c;
  const doneTasks   = db.db.prepare("SELECT COUNT(*) as c FROM team_tasks WHERE status='completed' AND verification_status IN ('approved','not_required') AND team_id IN (SELECT id FROM teams WHERE role='crew')").get().c;

  if (totalTasks > 0 && doneTasks / totalTasks >= crewTaskPct) {
    return 'crew';
  }

  return null; // game continues
}

/**
 * Trigger end-of-game sequence
 */
function endGame(winner, io) {
  db.endSession(winner);
  db.addActivity('GAME_OVER', `Game over! ${winner === 'crew' ? '🟦 Crew wins!' : '🔴 Imposters win!'}`, { winner }, 1);

  // Compute final standings
  const teams = db.getTeams();
  computeAchievements(teams);

  const stats = buildFinalStats(winner, teams);

  if (io) {
    io.emit('game:over', { winner, stats });
  }
  return stats;
}

function computeAchievements(teams) {
  for (const team of teams) {
    const tasks = db.getTeamTasks(team.id);
    const completed = tasks.filter(t => t.status === 'completed');

    if (completed.length === tasks.length && tasks.length > 0) {
      db.awardAchievement(team.id, 'mission_master');
    }
    if (team.status === 'alive') {
      db.awardAchievement(team.id, 'survivor');
    }
    if (team.role === 'imposter' && team.kill_count >= 3) {
      db.awardAchievement(team.id, 'master_deceiver');
    }
    if (team.kill_count > 0 && team.status === 'alive') {
      db.awardAchievement(team.id, 'clutch_player');
    }
    // Speedrunner: completed all tasks with shortest avg time
    const avgTime = completed.reduce((s, t) => s + (t.time_taken_secs || 999), 0) / (completed.length || 1);
    if (completed.length >= 5 && avgTime < 120) {
      db.awardAchievement(team.id, 'speedrunner');
    }
  }
}

function buildFinalStats(winner, teams) {
  const crewTeams     = teams.filter(t => t.role === 'crew').sort((a, b) => b.total_points - a.total_points);
  const imposterTeams = teams.filter(t => t.role === 'imposter').sort((a, b) => b.kill_count - a.kill_count);

  const bestCrew     = crewTeams[0] || null;
  const bestImposter = imposterTeams[0] || null;

  return {
    winner,
    bestCrew:     bestCrew ? { id: bestCrew.id, name: bestCrew.name, points: bestCrew.total_points } : null,
    bestImposter: bestImposter ? { id: bestImposter.id, name: bestImposter.name, kills: bestImposter.kill_count } : null,
    teams: teams.map(t => ({
      id: t.id, name: t.name, role: t.role, status: t.status,
      kills: t.kill_count, points: t.total_points,
      achievements: db.getTeamAchievements(t.id).map(a => a.achievement_key)
    }))
  };
}

module.exports = { checkWinConditions, endGame };

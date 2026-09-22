const db = require('../database/db');

const ACHIEVEMENT_LABELS = {
  mission_master:  { label: 'Mission Master',  icon: '🏆', desc: 'Completed every assigned task' },
  survivor:        { label: 'Survivor',         icon: '💪', desc: 'Still alive at game end' },
  master_deceiver: { label: 'Master Deceiver',  icon: '🎭', desc: '3+ confirmed kills as imposter' },
  clutch_player:   { label: 'Clutch Player',    icon: '⚡', desc: 'Got kills and survived' },
  speedrunner:     { label: 'Speedrunner',       icon: '🚀', desc: 'Blazing fast task completion' },
  detective:       { label: 'Detective',         icon: '🔍', desc: 'Successfully voted out an imposter' },
  last_stand:      { label: 'Last Stand',        icon: '🛡️', desc: 'Last crew team standing' }
};

/**
 * Build a leaderboard snapshot for the admin analytics view.
 */
function buildLeaderboard() {
  const teams = db.getTeams();
  return teams.map(team => {
    const tasks       = db.getTeamTasks(team.id);
    const completed   = tasks.filter(t => t.status === 'completed');
    const approved    = completed.filter(t => t.verification_status === 'approved' || t.verification_status === 'not_required');
    const bonusDone   = approved.filter(t => t.is_bonus);
    const achievements = db.getTeamAchievements(team.id).map(a => ({
      key: a.achievement_key,
      ...ACHIEVEMENT_LABELS[a.achievement_key]
    }));

    return {
      id:              team.id,
      name:            team.name,
      role:            team.role,
      status:          team.status,
      tasksTotal:      tasks.length,
      tasksCompleted:  approved.length,
      bonusDone:       bonusDone.length,
      points:          team.total_points,
      kills:           team.kill_count,
      meetingsCalled:  team.meetings_called,
      achievements
    };
  }).sort((a, b) => {
    // Sort: alive > eliminated, then by points desc
    if (a.status !== b.status) return a.status === 'alive' ? -1 : 1;
    return b.points - a.points;
  });
}

/**
 * Build CSV export data
 */
function buildExportData() {
  const teams = db.getTeams();
  const rows  = [];

  for (const team of teams) {
    const tasks = db.getTeamTasks(team.id);
    const completed = tasks.filter(t => t.status === 'completed' && (t.verification_status === 'approved' || t.verification_status === 'not_required'));
    const achievements = db.getTeamAchievements(team.id).map(a => a.achievement_key).join(';');

    rows.push({
      team_id:         team.id,
      team_name:       team.name,
      role:            team.role,
      status:          team.status,
      member1:         team.member1,
      member2:         team.member2,
      member3:         team.member3,
      tasks_completed: completed.length,
      tasks_total:     tasks.length,
      total_points:    team.total_points,
      kill_count:      team.kill_count,
      meetings_called: team.meetings_called,
      achievements
    });
  }
  return rows;
}

module.exports = { buildLeaderboard, buildExportData, ACHIEVEMENT_LABELS };

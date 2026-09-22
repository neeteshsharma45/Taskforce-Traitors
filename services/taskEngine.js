const { getTask, getTeamTaskByIds } = require('../database/db');

// The 12 supported task types
const TASK_TYPES = [
  'code_entry', 'quiz', 'cipher', 'photo_proof',
  'find_object', 'navigation', 'team_challenge',
  'timed_challenge', 'interaction', 'investigation',
  'digital_puzzle', 'bonus_mission'
];

// Which types are auto-gradeable (correct_answer compared server-side)
const AUTO_GRADE_TYPES = new Set(['code_entry', 'quiz', 'cipher', 'digital_puzzle']);

/**
 * Validate a task submission server-side.
 * Returns { valid: bool, autoApproved: bool, reason: string }
 */
function validateSubmission(teamTask, submittedAnswer) {
  const task = getTask(teamTask.task_id);
  if (!task) return { valid: false, reason: 'Task not found' };

  // Already done?
  if (teamTask.status === 'completed') {
    return { valid: false, reason: 'Task already completed' };
  }

  // Time limit check (server-side)
  if (task.time_limit && teamTask.started_at) {
    const elapsed = Math.floor(Date.now() / 1000) - teamTask.started_at;
    if (elapsed > task.time_limit) {
      return { valid: false, reason: `Time limit exceeded (${task.time_limit}s)` };
    }
  }

  // Auto-grade
  if (AUTO_GRADE_TYPES.has(task.type) && task.correct_answer) {
    const normalise = s => String(s || '').trim().toLowerCase();
    const correct   = normalise(task.correct_answer) === normalise(submittedAnswer);
    return {
      valid:        correct,
      autoApproved: correct,
      reason:       correct ? 'Correct!' : 'Incorrect answer'
    };
  }

  // Manual verification needed (photo_proof, find_object, etc.)
  return { valid: true, autoApproved: false, reason: 'Submitted — awaiting admin verification' };
}

/**
 * Generate a balanced set of task IDs for a team.
 * @param {Object[]} allTasks - all active tasks from DB
 * @param {Object} quotas    - { type: count } e.g. { quiz: 2, photo_proof: 1 }
 * @param {number} min       - min tasks per team
 * @param {number} max       - max tasks per team
 */
function generateTaskSet(allTasks, quotas = {}, min = 8, max = 12) {
  const activeTasks = allTasks.filter(t => t.is_active && !t.is_bonus);
  const bonusTasks  = allTasks.filter(t => t.is_active && t.is_bonus);
  const selected    = [];
  const used        = new Set();

  // Fill quotas first
  for (const [type, count] of Object.entries(quotas)) {
    const pool = activeTasks.filter(t => t.type === type && !used.has(t.id));
    const pick = shuffled(pool).slice(0, count);
    pick.forEach(t => { selected.push(t.id); used.add(t.id); });
  }

  // Fill up to min with random remaining tasks
  const remaining = shuffled(activeTasks.filter(t => !used.has(t.id)));
  while (selected.length < min && remaining.length > 0) {
    const t = remaining.pop();
    selected.push(t.id);
    used.add(t.id);
  }

  // Optionally add bonus tasks up to max
  const bonusPick = shuffled(bonusTasks).slice(0, max - selected.length);
  bonusPick.forEach(t => selected.push(t.id));

  return selected;
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { TASK_TYPES, AUTO_GRADE_TYPES, validateSubmission, generateTaskSet };

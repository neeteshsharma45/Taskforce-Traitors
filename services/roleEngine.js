const { v4: uuidv4 } = require('uuid');

/**
 * Randomly selects `count` unique indexes from an array
 */
function sample(arr, count) {
  const copy = [...arr];
  const result = [];
  for (let i = 0; i < Math.min(count, copy.length); i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

/**
 * assignRoles(teams, imposterCount)
 * Returns { imposterIds: string[], crewIds: string[] }
 * Pure function — caller writes to DB.
 */
function selectImposters(teams, imposterCount = 5) {
  if (teams.length < imposterCount) {
    throw new Error(`Cannot assign ${imposterCount} imposters from ${teams.length} teams`);
  }
  const imposters = sample(teams, imposterCount);
  const imposterIds = imposters.map(t => t.id);
  const crewIds     = teams.filter(t => !imposterIds.includes(t.id)).map(t => t.id);
  return { imposterIds, crewIds };
}

/**
 * Default secret missions for imposter teams
 */
const DEFAULT_SECRET_MISSIONS = [
  'Eliminate a crew team without being detected.',
  'Survive at least 2 emergency meetings without being voted out.',
  'Blend in — complete at least 3 fake tasks before your first kill.',
  'Avoid being spotted near a kill site.',
  'Outlast all other imposter teams.'
];

module.exports = { selectImposters, DEFAULT_SECRET_MISSIONS };

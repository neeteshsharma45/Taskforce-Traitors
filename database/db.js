const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'game.db');

let adapterInstance = null;

class SqlJsDatabaseAdapter {
  constructor(sqlDb, filePath) {
    this.sqlDb = sqlDb;
    this.filePath = filePath;
  }

  save() {
    try {
      const data = this.sqlDb.export();
      fs.writeFileSync(this.filePath, Buffer.from(data));
    } catch (e) {
      console.error('Database save error:', e);
    }
  }

  pragma(sql) {
    try { this.sqlDb.exec(`PRAGMA ${sql};`); } catch(e) {}
  }

  exec(sql) {
    this.sqlDb.exec(sql);
    this.save();
  }

  prepare(sql) {
    const self = this;
    return {
      run(...args) {
        let params = args;
        if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
          params = args[0];
        } else if (args.length === 1 && Array.isArray(args[0])) {
          params = args[0];
        }
        self.sqlDb.run(sql, params);
        self.save();
        return { changes: self.sqlDb.getRowsModified() };
      },

      get(...args) {
        let params = args;
        if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
          params = args[0];
        } else if (args.length === 1 && Array.isArray(args[0])) {
          params = args[0];
        }
        const stmt = self.sqlDb.prepare(sql);
        stmt.bind(params);
        let result;
        if (stmt.step()) {
          result = stmt.getAsObject();
        }
        stmt.free();
        return result;
      },

      all(...args) {
        let params = args;
        if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
          params = args[0];
        } else if (args.length === 1 && Array.isArray(args[0])) {
          params = args[0];
        }
        const stmt = self.sqlDb.prepare(sql);
        stmt.bind(params);
        const results = [];
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      }
    };
  }

  transaction(fn) {
    return (...args) => {
      this.exec('BEGIN TRANSACTION');
      try {
        const res = fn(...args);
        this.exec('COMMIT');
        return res;
      } catch (err) {
        this.exec('ROLLBACK');
        throw err;
      }
    };
  }
}

const db = {
  pragma: (sql) => adapterInstance?.pragma(sql),
  exec: (sql) => adapterInstance?.exec(sql),
  prepare: (sql) => adapterInstance?.prepare(sql),
  transaction: (fn) => adapterInstance?.transaction(fn)
};

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
async function initDB() {
  const SQL = await initSqlJs();
  let fileBuffer = null;
  if (fs.existsSync(dbPath)) {
    try { fileBuffer = fs.readFileSync(dbPath); } catch (e) {}
  }
  const sqlDb = new SQL.Database(fileBuffer);
  adapterInstance = new SqlJsDatabaseAdapter(sqlDb, dbPath);
  adapterInstance.pragma('journal_mode = WAL');
  adapterInstance.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      username     TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at   INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS game_sessions (
      id          TEXT PRIMARY KEY,
      phase       TEXT DEFAULT 'LOBBY',
      started_at  INTEGER,
      ended_at    INTEGER,
      winner      TEXT,
      created_at  INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS game_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS stations (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT DEFAULT '',
      location_note TEXT DEFAULT '',
      capacity      INTEGER DEFAULT 3,
      is_active     INTEGER DEFAULT 1,
      created_at    INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id                   TEXT PRIMARY KEY,
      title                TEXT NOT NULL,
      description          TEXT DEFAULT '',
      type                 TEXT NOT NULL,
      station_id           TEXT,
      difficulty           TEXT DEFAULT 'medium',
      points               INTEGER DEFAULT 10,
      time_limit           INTEGER,
      verification_type    TEXT DEFAULT 'manual',
      correct_answer       TEXT,
      hint                 TEXT,
      max_concurrent_teams INTEGER DEFAULT 5,
      is_bonus             INTEGER DEFAULT 0,
      is_active            INTEGER DEFAULT 1,
      created_at           INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (station_id) REFERENCES stations(id)
    );

    CREATE TABLE IF NOT EXISTS teams (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      member1          TEXT DEFAULT '',
      member2          TEXT DEFAULT '',
      member3          TEXT DEFAULT '',
      role             TEXT DEFAULT 'crew',
      status           TEXT DEFAULT 'alive',
      kill_count       INTEGER DEFAULT 0,
      meetings_called  INTEGER DEFAULT 0,
      total_points     INTEGER DEFAULT 0,
      created_at       INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS volunteers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      team_id     TEXT NOT NULL UNIQUE,
      pin_hash    TEXT NOT NULL,
      pin_display TEXT NOT NULL,
      created_at  INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );

    CREATE TABLE IF NOT EXISTS team_tasks (
      id                  TEXT PRIMARY KEY,
      team_id             TEXT NOT NULL,
      task_id             TEXT NOT NULL,
      status              TEXT DEFAULT 'assigned',
      started_at          INTEGER,
      completed_at        INTEGER,
      time_taken_secs     INTEGER,
      attempts            INTEGER DEFAULT 0,
      proof_url           TEXT,
      answer_submitted    TEXT,
      verification_status TEXT DEFAULT 'not_required',
      verified_by         TEXT,
      verified_at         INTEGER,
      rejection_note      TEXT,
      points_awarded      INTEGER DEFAULT 0,
      UNIQUE(team_id, task_id),
      FOREIGN KEY (team_id) REFERENCES teams(id),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS kill_events (
      id                TEXT PRIMARY KEY,
      imposter_team_id  TEXT NOT NULL,
      victim_team_id    TEXT NOT NULL,
      reported_by       TEXT NOT NULL,
      evidence_note     TEXT DEFAULT '',
      reported_at       INTEGER NOT NULL,
      ack_deadline      INTEGER,
      acknowledged_at   INTEGER,
      status            TEXT DEFAULT 'pending_ack',
      approved_by       TEXT,
      approved_at       INTEGER,
      rejection_reason  TEXT,
      FOREIGN KEY (imposter_team_id) REFERENCES teams(id),
      FOREIGN KEY (victim_team_id)   REFERENCES teams(id)
    );

    CREATE TABLE IF NOT EXISTS meetings (
      id                  TEXT PRIMARY KEY,
      game_session_id     TEXT,
      called_by_team_id   TEXT NOT NULL,
      reason              TEXT DEFAULT '',
      phase               TEXT DEFAULT 'discussion',
      started_at          INTEGER NOT NULL,
      discussion_ends_at  INTEGER,
      voting_starts_at    INTEGER,
      voting_ends_at      INTEGER,
      closed_at           INTEGER,
      voted_out_team_id   TEXT,
      was_imposter        INTEGER,
      FOREIGN KEY (called_by_team_id) REFERENCES teams(id)
    );

    CREATE TABLE IF NOT EXISTS votes (
      id               TEXT PRIMARY KEY,
      meeting_id       TEXT NOT NULL,
      voter_team_id    TEXT NOT NULL,
      target_team_id   TEXT,
      cast_at          INTEGER NOT NULL,
      UNIQUE(meeting_id, voter_team_id),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id)
    );

    CREATE TABLE IF NOT EXISTS secret_missions (
      id           TEXT PRIMARY KEY,
      team_id      TEXT NOT NULL,
      description  TEXT NOT NULL,
      is_completed INTEGER DEFAULT 0,
      completed_at INTEGER,
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      description TEXT NOT NULL,
      data        TEXT,
      is_public   INTEGER DEFAULT 1,
      timestamp   INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS achievements (
      id              TEXT PRIMARY KEY,
      team_id         TEXT NOT NULL,
      achievement_key TEXT NOT NULL,
      awarded_at      INTEGER DEFAULT (unixepoch()),
      UNIQUE(team_id, achievement_key),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );

    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id          TEXT PRIMARY KEY,
      admin_id    TEXT NOT NULL,
      action      TEXT NOT NULL,
      target_id   TEXT,
      details     TEXT,
      timestamp   INTEGER DEFAULT (unixepoch())
    );
  `);

  // Default admin
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get(process.env.ADMIN_USERNAME || 'admin');
  if (!admin) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'taskforce2024', 10);
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(uuidv4(), process.env.ADMIN_USERNAME || 'admin', hash);
    console.log(`✅ Admin created: ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD || 'taskforce2024'}`);
  }

  // Default settings
  const defaults = {
    crew_task_win_pct:     '70',
    imposter_ratio_win:    '1',
    discussion_timer_secs: '180',
    voting_timer_secs:     '120',
    kill_ack_window_secs:  '90',
    max_meetings_per_team: '2',
    tie_vote_action:       'skip',   // 'skip' | 'revote'
    tasks_per_team_min:    '8',
    tasks_per_team_max:    '12',
    ordered_tasks:         '0',
    roles_assigned:        '0',
    total_imposter_teams:  '5',
    total_crew_teams:      '15'
  };
  const ins = db.prepare('INSERT OR IGNORE INTO game_settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) ins.run(k, v);

  // Ensure active session
  const sess = db.prepare('SELECT id FROM game_sessions ORDER BY created_at DESC LIMIT 1').get();
  if (!sess) db.prepare('INSERT INTO game_sessions (id) VALUES (?)').run(uuidv4());

  console.log('✅ Database ready');
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
const getSettings = () => Object.fromEntries(
  db.prepare('SELECT key, value FROM game_settings').all().map(r => [r.key, r.value])
);
const getSetting  = k => db.prepare('SELECT value FROM game_settings WHERE key = ?').get(k)?.value;
const setSetting  = (k, v) => db.prepare('INSERT OR REPLACE INTO game_settings (key, value) VALUES (?, ?)').run(k, String(v));

// ─────────────────────────────────────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────────────────────────────────────
const getAdminByUsername = u => db.prepare('SELECT * FROM users WHERE username = ?').get(u);

// ─────────────────────────────────────────────────────────────────────────────
// GAME SESSION
// ─────────────────────────────────────────────────────────────────────────────
const getActiveSession  = () => db.prepare('SELECT * FROM game_sessions ORDER BY created_at DESC LIMIT 1').get();
const updateSessionPhase = phase => {
  const s = getActiveSession();
  if (s) db.prepare('UPDATE game_sessions SET phase = ? WHERE id = ?').run(phase, s.id);
};
const startSession = () => {
  const s = getActiveSession();
  if (s) db.prepare("UPDATE game_sessions SET phase = 'MISSION', started_at = unixepoch() WHERE id = ?").run(s.id);
};
const endSession = winner => {
  const s = getActiveSession();
  if (s) db.prepare("UPDATE game_sessions SET phase = 'RESULT', ended_at = unixepoch(), winner = ? WHERE id = ?").run(winner, s.id);
};
const resetSession = () => {
  const newId = uuidv4();
  db.prepare('INSERT INTO game_sessions (id) VALUES (?)').run(newId);
};

// ─────────────────────────────────────────────────────────────────────────────
// TEAMS
// ─────────────────────────────────────────────────────────────────────────────
const getTeams = () => db.prepare('SELECT * FROM teams ORDER BY created_at').all();
const getTeam  = id => db.prepare('SELECT * FROM teams WHERE id = ?').get(id);

/** Returns the team for a given volunteer id */
const getTeamByVolunteerId = volId => {
  const v = db.prepare('SELECT team_id FROM volunteers WHERE id = ?').get(volId);
  return v ? getTeam(v.team_id) : null;
};

const createTeam = (name, m1, m2, m3) => {
  const id = uuidv4();
  db.prepare('INSERT INTO teams (id, name, member1, member2, member3) VALUES (?, ?, ?, ?, ?)').run(id, name, m1 || '', m2 || '', m3 || '');
  return id;
};

const updateTeam = (id, { name, member1, member2, member3 }) =>
  db.prepare('UPDATE teams SET name=?, member1=?, member2=?, member3=? WHERE id=?').run(name, member1 || '', member2 || '', member3 || '', id);

const deleteTeam = id => {
  db.prepare('DELETE FROM volunteers WHERE team_id = ?').run(id);
  db.prepare('DELETE FROM team_tasks    WHERE team_id = ?').run(id);
  db.prepare('DELETE FROM secret_missions WHERE team_id = ?').run(id);
  db.prepare('DELETE FROM achievements  WHERE team_id = ?').run(id);
  db.prepare('DELETE FROM teams         WHERE id = ?').run(id);
};

const assignRoles = imposterIds => {
  db.prepare("UPDATE teams SET role = 'crew'").run();
  for (const id of imposterIds)
    db.prepare("UPDATE teams SET role = 'imposter' WHERE id = ?").run(id);
};

const getAliveTeams       = () => db.prepare("SELECT * FROM teams WHERE status = 'alive'").all();
const getAliveTeamsByRole = r  => db.prepare("SELECT * FROM teams WHERE status = 'alive' AND role = ?").all(r);
const eliminateTeam       = id => db.prepare("UPDATE teams SET status = 'eliminated' WHERE id = ?").run(id);
const incrementKills      = id => db.prepare('UPDATE teams SET kill_count = kill_count + 1 WHERE id = ?').run(id);
const addPoints           = (id, pts) => db.prepare('UPDATE teams SET total_points = total_points + ? WHERE id = ?').run(pts, id);

// ─────────────────────────────────────────────────────────────────────────────
// VOLUNTEERS
// ─────────────────────────────────────────────────────────────────────────────
const getVolunteer       = id     => db.prepare('SELECT * FROM volunteers WHERE id = ?').get(id);
const getVolunteerByTeam = teamId => db.prepare('SELECT * FROM volunteers WHERE team_id = ?').get(teamId);
const getVolunteers      = ()     => db.prepare(
  'SELECT v.*, t.name as team_name FROM volunteers v JOIN teams t ON v.team_id = t.id ORDER BY t.name'
).all();

const createVolunteer = (name, teamId) => {
  const pin = Math.floor(100000 + Math.random() * 900000).toString();
  const id  = uuidv4();
  db.prepare('INSERT INTO volunteers (id, name, team_id, pin_hash, pin_display) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, teamId, bcrypt.hashSync(pin, 10), pin);
  return { id, pin };
};

const verifyVolunteerPin = (teamId, pin) => {
  const v = db.prepare('SELECT * FROM volunteers WHERE team_id = ?').get(teamId);
  if (!v) return null;
  return bcrypt.compareSync(String(pin), v.pin_hash) ? v : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIONS
// ─────────────────────────────────────────────────────────────────────────────
const getStations  = () => db.prepare('SELECT * FROM stations ORDER BY name').all();
const getStation   = id => db.prepare('SELECT * FROM stations WHERE id = ?').get(id);

const createStation = ({ name, description, location_note, capacity, is_active }) => {
  const id = uuidv4();
  db.prepare('INSERT INTO stations (id, name, description, location_note, capacity, is_active) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, description || '', location_note || '', capacity || 3, is_active !== false ? 1 : 0);
  return id;
};

const updateStation = (id, { name, description, location_note, capacity, is_active }) =>
  db.prepare('UPDATE stations SET name=?, description=?, location_note=?, capacity=?, is_active=? WHERE id=?')
    .run(name, description || '', location_note || '', capacity || 3, is_active ? 1 : 0, id);

const deleteStation = id => db.prepare('DELETE FROM stations WHERE id = ?').run(id);

// ─────────────────────────────────────────────────────────────────────────────
// TASKS
// ─────────────────────────────────────────────────────────────────────────────
const getTasks = () => db.prepare(`
  SELECT t.*, s.name as station_name
  FROM tasks t LEFT JOIN stations s ON t.station_id = s.id
  ORDER BY t.created_at
`).all();
const getTask = id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);

const createTask = data => {
  const id = uuidv4();
  const {
    title, description, type, station_id, difficulty, points,
    time_limit, verification_type, correct_answer, hint,
    max_concurrent_teams, is_bonus, is_active
  } = data;
  db.prepare(`
    INSERT INTO tasks
      (id, title, description, type, station_id, difficulty, points, time_limit,
       verification_type, correct_answer, hint, max_concurrent_teams, is_bonus, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, description || '', type, station_id || null, difficulty || 'medium',
         points || 10, time_limit || null, verification_type || 'manual',
         correct_answer || null, hint || null, max_concurrent_teams || 5,
         is_bonus ? 1 : 0, is_active !== false ? 1 : 0);
  return id;
};

const updateTask = (id, data) => {
  const {
    title, description, type, station_id, difficulty, points,
    time_limit, verification_type, correct_answer, hint,
    max_concurrent_teams, is_bonus, is_active
  } = data;
  db.prepare(`
    UPDATE tasks SET
      title=?, description=?, type=?, station_id=?, difficulty=?, points=?,
      time_limit=?, verification_type=?, correct_answer=?, hint=?,
      max_concurrent_teams=?, is_bonus=?, is_active=?
    WHERE id=?
  `).run(title, description || '', type, station_id || null, difficulty || 'medium',
         points || 10, time_limit || null, verification_type || 'manual',
         correct_answer || null, hint || null, max_concurrent_teams || 5,
         is_bonus ? 1 : 0, is_active !== false ? 1 : 0, id);
};

const deleteTask = id => db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

// ─────────────────────────────────────────────────────────────────────────────
// TEAM TASKS
// ─────────────────────────────────────────────────────────────────────────────
const getTeamTasks = teamId => db.prepare(`
  SELECT tt.*, t.title, t.description, t.type, t.points, t.time_limit,
         t.verification_type, t.hint, t.is_bonus, t.difficulty,
         s.name as station_name, s.location_note
  FROM team_tasks tt
  JOIN tasks t ON tt.task_id = t.id
  LEFT JOIN stations s ON t.station_id = s.id
  WHERE tt.team_id = ?
  ORDER BY tt.rowid
`).all(teamId);

const getTeamTask = id => db.prepare(`
  SELECT tt.*, t.title, t.description, t.type, t.points, t.time_limit,
         t.verification_type, t.correct_answer, t.hint, t.is_bonus
  FROM team_tasks tt
  JOIN tasks t ON tt.task_id = t.id
  WHERE tt.id = ?
`).get(id);

const getTeamTaskByIds = (teamId, taskId) =>
  db.prepare('SELECT * FROM team_tasks WHERE team_id = ? AND task_id = ?').get(teamId, taskId);

const assignTaskToTeam = (teamId, taskId) => {
  const id = uuidv4();
  try {
    db.prepare('INSERT OR IGNORE INTO team_tasks (id, team_id, task_id, verification_status) VALUES (?, ?, ?, ?)')
      .run(id, teamId, taskId, 'not_required');
  } catch { /* already assigned */ }
  return id;
};

const updateTeamTask = (id, data) => {
  const cols = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const vals = Object.values(data);
  db.prepare(`UPDATE team_tasks SET ${cols} WHERE id = ?`).run(...vals, id);
};

const getPendingVerifications = () => db.prepare(`
  SELECT tt.*, t.title, t.type, tm.name as team_name
  FROM team_tasks tt
  JOIN tasks t ON tt.task_id = t.id
  JOIN teams tm ON tt.team_id = tm.id
  WHERE tt.verification_status = 'pending' AND tt.status = 'submitted'
  ORDER BY tt.completed_at
`).all();

// ─────────────────────────────────────────────────────────────────────────────
// KILL EVENTS
// ─────────────────────────────────────────────────────────────────────────────
const createKillEvent = (imposterTeamId, victimTeamId, reportedBy, evidenceNote, ackSecs) => {
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO kill_events
      (id, imposter_team_id, victim_team_id, reported_by, evidence_note, reported_at, ack_deadline)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, imposterTeamId, victimTeamId, reportedBy, evidenceNote || '', now, now + (ackSecs || 90));
  return id;
};

const getKillEvent  = id => db.prepare('SELECT * FROM kill_events WHERE id = ?').get(id);
const getKillEvents = () => db.prepare(`
  SELECT ke.*, t1.name as imposter_name, t2.name as victim_name
  FROM kill_events ke
  JOIN teams t1 ON ke.imposter_team_id = t1.id
  JOIN teams t2 ON ke.victim_team_id   = t2.id
  ORDER BY ke.reported_at DESC
`).all();
const getPendingKills = () => db.prepare(`
  SELECT ke.*, t1.name as imposter_name, t2.name as victim_name
  FROM kill_events ke
  JOIN teams t1 ON ke.imposter_team_id = t1.id
  JOIN teams t2 ON ke.victim_team_id   = t2.id
  WHERE ke.status IN ('pending_ack', 'acknowledged', 'pending_admin')
  ORDER BY ke.reported_at
`).all();
const updateKillEvent = (id, data) => {
  const cols = Object.keys(data).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE kill_events SET ${cols} WHERE id = ?`).run(...Object.values(data), id);
};
const hasPendingKillAgainst = victimId =>
  !!db.prepare("SELECT id FROM kill_events WHERE victim_team_id = ? AND status NOT IN ('approved','rejected')").get(victimId);

// ─────────────────────────────────────────────────────────────────────────────
// MEETINGS
// ─────────────────────────────────────────────────────────────────────────────
const createMeeting = (calledByTeamId, reason, discSecs, sessionId) => {
  const id  = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  const discEnd = now + (Number(discSecs) || 180);
  db.prepare(`
    INSERT INTO meetings (id, game_session_id, called_by_team_id, reason, phase, started_at, discussion_ends_at)
    VALUES (?, ?, ?, ?, 'discussion', ?, ?)
  `).run(id, sessionId || null, calledByTeamId, reason || '', now, discEnd);
  db.prepare('UPDATE teams SET meetings_called = meetings_called + 1 WHERE id = ?').run(calledByTeamId);
  return { id, now, discEnd };
};

const getActiveMeeting = () => db.prepare("SELECT * FROM meetings WHERE phase != 'closed' ORDER BY started_at DESC LIMIT 1").get();
const getMeeting       = id => db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
const getMeetings      = () => db.prepare(`
  SELECT m.*, t.name as called_by_name
  FROM meetings m JOIN teams t ON m.called_by_team_id = t.id
  ORDER BY m.started_at DESC
`).all();
const updateMeeting = (id, data) => {
  const cols = Object.keys(data).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE meetings SET ${cols} WHERE id = ?`).run(...Object.values(data), id);
};

// ─────────────────────────────────────────────────────────────────────────────
// VOTES
// ─────────────────────────────────────────────────────────────────────────────
const castVote = (meetingId, voterTeamId, targetTeamId) => {
  const id  = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT OR REPLACE INTO votes (id, meeting_id, voter_team_id, target_team_id, cast_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, meetingId, voterTeamId, targetTeamId || null, now);
};
const hasVoted    = (meetingId, teamId) => !!db.prepare('SELECT id FROM votes WHERE meeting_id=? AND voter_team_id=?').get(meetingId, teamId);
const getVotes    = meetingId => db.prepare(`
  SELECT v.*, t.name as voter_name, t2.name as target_name
  FROM votes v
  JOIN teams t ON v.voter_team_id = t.id
  LEFT JOIN teams t2 ON v.target_team_id = t2.id
  WHERE v.meeting_id = ?
`).all(meetingId);
const getVoteTally = meetingId => db.prepare(`
  SELECT target_team_id, COUNT(*) as count, t.name as target_name
  FROM votes v LEFT JOIN teams t ON v.target_team_id = t.id
  WHERE v.meeting_id = ? AND v.target_team_id IS NOT NULL
  GROUP BY target_team_id
  ORDER BY count DESC
`).all(meetingId);

// ─────────────────────────────────────────────────────────────────────────────
// SECRET MISSIONS
// ─────────────────────────────────────────────────────────────────────────────
const getSecretMissions     = teamId => db.prepare('SELECT * FROM secret_missions WHERE team_id = ?').all(teamId);
const createSecretMission   = (teamId, description) => {
  const id = uuidv4();
  db.prepare('INSERT INTO secret_missions (id, team_id, description) VALUES (?, ?, ?)').run(id, teamId, description);
  return id;
};
const completeSecretMission = id =>
  db.prepare('UPDATE secret_missions SET is_completed=1, completed_at=unixepoch() WHERE id=?').run(id);

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY LOG
// ─────────────────────────────────────────────────────────────────────────────
const addActivity = (type, description, data = null, isPublic = 1) => {
  const id = uuidv4();
  db.prepare('INSERT INTO activity_log (id, type, description, data, is_public) VALUES (?, ?, ?, ?, ?)')
    .run(id, type, description, data ? JSON.stringify(data) : null, isPublic ? 1 : 0);
  return id;
};
const getActivity = (limit = 100, publicOnly = false) => db.prepare(
  `SELECT * FROM activity_log${publicOnly ? ' WHERE is_public = 1' : ''} ORDER BY timestamp DESC LIMIT ?`
).all(limit);

// ─────────────────────────────────────────────────────────────────────────────
// ACHIEVEMENTS
// ─────────────────────────────────────────────────────────────────────────────
const awardAchievement = (teamId, key) => {
  try {
    db.prepare('INSERT OR IGNORE INTO achievements (id, team_id, achievement_key) VALUES (?, ?, ?)').run(uuidv4(), teamId, key);
    return true;
  } catch { return false; }
};
const getTeamAchievements = teamId => db.prepare('SELECT * FROM achievements WHERE team_id = ?').all(teamId);

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────────────────────────────────────
const auditLog = (adminId, action, targetId, details) =>
  db.prepare('INSERT INTO admin_audit_log (id, admin_id, action, target_id, details) VALUES (?, ?, ?, ?, ?)')
    .run(uuidv4(), adminId, action, targetId || null, details || null);

// ─────────────────────────────────────────────────────────────────────────────
// STATS (for overview + public)
// ─────────────────────────────────────────────────────────────────────────────
const getGameStats = () => {
  const teams = getTeams();
  const alive = teams.filter(t => t.status === 'alive');
  const crewAlive      = alive.filter(t => t.role === 'crew').length;
  const imposterAlive  = alive.filter(t => t.role === 'imposter').length;
  const totalTasks     = db.prepare('SELECT COUNT(*) as c FROM team_tasks').get().c;
  const completedTasks = db.prepare("SELECT COUNT(*) as c FROM team_tasks WHERE status='completed' AND verification_status IN ('approved','not_required')").get().c;
  const pendingVerif   = db.prepare("SELECT COUNT(*) as c FROM team_tasks WHERE verification_status='pending' AND status='submitted'").get().c;
  const pendingKills   = db.prepare("SELECT COUNT(*) as c FROM kill_events WHERE status NOT IN ('approved','rejected')").get().c;
  const session        = getActiveSession();
  const settings       = getSettings();

  return {
    crewAlive, imposterAlive,
    crewTotal:    teams.filter(t => t.role === 'crew').length,
    imposterTotal: teams.filter(t => t.role === 'imposter').length,
    totalTeams:   teams.length,
    totalTasks, completedTasks,
    pendingVerif, pendingKills,
    gamePhase: session?.phase || 'LOBBY',
    startedAt: session?.started_at,
    winner:    session?.winner,
    settings
  };
};

module.exports = {
  db, initDB,
  // settings
  getSettings, getSetting, setSetting,
  // users
  getAdminByUsername,
  // session
  getActiveSession, updateSessionPhase, startSession, endSession, resetSession,
  // teams
  getTeams, getTeam, getTeamByVolunteerId, createTeam, updateTeam, deleteTeam,
  assignRoles, getAliveTeams, getAliveTeamsByRole, eliminateTeam, incrementKills, addPoints,
  // volunteers
  getVolunteer, getVolunteerByTeam, getVolunteers, createVolunteer, verifyVolunteerPin,
  // stations
  getStations, getStation, createStation, updateStation, deleteStation,
  // tasks
  getTasks, getTask, createTask, updateTask, deleteTask,
  // team tasks
  getTeamTasks, getTeamTask, getTeamTaskByIds, assignTaskToTeam, updateTeamTask, getPendingVerifications,
  // kills
  createKillEvent, getKillEvent, getKillEvents, getPendingKills, updateKillEvent, hasPendingKillAgainst,
  // meetings
  createMeeting, getActiveMeeting, getMeeting, getMeetings, updateMeeting,
  // votes
  castVote, hasVoted, getVotes, getVoteTally,
  // secret missions
  getSecretMissions, createSecretMission, completeSecretMission,
  // activity
  addActivity, getActivity,
  // achievements
  awardAchievement, getTeamAchievements,
  // audit
  auditLog,
  // stats
  getGameStats
};

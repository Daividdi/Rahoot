/**
 * Database layer — Phase 1.
 *
 * Uses Node's built-in node:sqlite (experimental, stable enough in 22.x).
 * Schema is idempotent — safe to call init() on every startup.
 *
 * This module is ADDITIVE: it does not modify the existing history.json flow.
 * Later phases will start double-writing here. For now, only the one-shot
 * migration runs on startup if the DB is empty.
 */

import { DatabaseSync } from "node:sqlite"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

const DB_PATH = () =>
  resolve(process.env.CONFIG_PATH || resolve(process.cwd(), "../../config"), "rahoot.db")

const HISTORY_JSON = () =>
  resolve(process.env.CONFIG_PATH || resolve(process.cwd(), "../../config"), "history.json")

let _db: DatabaseSync | null = null

export function db(): DatabaseSync {
  if (!_db) throw new Error("Database not initialized — call Database.init() first")
  return _db
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY,
  client_id     TEXT UNIQUE,
  real_name     TEXT NOT NULL,
  username      TEXT NOT NULL,
  avatar_json   TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_real_name ON players(real_name);
CREATE INDEX IF NOT EXISTS idx_players_client_id ON players(client_id);

CREATE TABLE IF NOT EXISTS player_progress (
  player_id        TEXT PRIMARY KEY REFERENCES players(id),
  xp               INTEGER NOT NULL DEFAULT 0,
  level            INTEGER NOT NULL DEFAULT 1,
  tier             TEXT NOT NULL DEFAULT 'bronze',
  longest_streak   INTEGER NOT NULL DEFAULT 0,
  games_played     INTEGER NOT NULL DEFAULT 0,
  perfect_games    INTEGER NOT NULL DEFAULT 0,
  total_correct    INTEGER NOT NULL DEFAULT 0,
  total_answered   INTEGER NOT NULL DEFAULT 0,
  last_game_at     TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  quiz_id      TEXT NOT NULL,
  quiz_title   TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'classic',
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  week_iso     TEXT NOT NULL,
  month_iso    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_week ON sessions(week_iso);
CREATE INDEX IF NOT EXISTS idx_sessions_month ON sessions(month_iso);
CREATE INDEX IF NOT EXISTS idx_sessions_quiz ON sessions(quiz_id);

CREATE TABLE IF NOT EXISTS session_players (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  player_id     TEXT NOT NULL REFERENCES players(id),
  rank          INTEGER NOT NULL,
  points        INTEGER NOT NULL,
  correct       INTEGER NOT NULL DEFAULT 0,
  incorrect     INTEGER NOT NULL DEFAULT 0,
  unanswered    INTEGER NOT NULL DEFAULT 0,
  xp_gained     INTEGER NOT NULL DEFAULT 0,
  answers_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sp_player ON session_players(player_id);
CREATE INDEX IF NOT EXISTS idx_sp_session ON session_players(session_id);

CREATE TABLE IF NOT EXISTS player_badges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id    TEXT NOT NULL REFERENCES players(id),
  badge_id     TEXT NOT NULL,
  unlocked_at  TEXT NOT NULL,
  UNIQUE(player_id, badge_id)
);

CREATE TABLE IF NOT EXISTS weekly_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  week_iso     TEXT NOT NULL,
  player_id    TEXT NOT NULL REFERENCES players(id),
  rank         INTEGER NOT NULL,
  points       INTEGER NOT NULL,
  games        INTEGER NOT NULL,
  snapshot_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ws_week ON weekly_snapshots(week_iso);

CREATE TABLE IF NOT EXISTS solo_attempts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id       TEXT NOT NULL REFERENCES players(id),
  quiz_id         TEXT NOT NULL,
  attempt_number  INTEGER NOT NULL,
  points          INTEGER NOT NULL,
  correct         INTEGER NOT NULL,
  incorrect       INTEGER NOT NULL,
  unanswered      INTEGER NOT NULL,
  xp_gained       INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT NOT NULL,
  ended_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sa_player_quiz ON solo_attempts(player_id, quiz_id);

CREATE TABLE IF NOT EXISTS quiz_feedback (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id          TEXT NOT NULL,
  game_id          TEXT NOT NULL,
  player_client_id TEXT NOT NULL,
  player_name      TEXT,
  rating           INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
  auto_filled      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT DEFAULT (datetime('now')),
  UNIQUE(game_id, player_client_id)
);
CREATE INDEX IF NOT EXISTS idx_qf_quiz ON quiz_feedback(quiz_id);
CREATE INDEX IF NOT EXISTS idx_qf_game ON quiz_feedback(game_id);

CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`

// ─── Helpers ────────────────────────────────────────────────────────────────

function getISOWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

function normName(s: string): string {
  return (s || "").toLowerCase().trim().replace(/\s+/g, " ")
}

// ─── Migration from history.json ────────────────────────────────────────────

function isMigrated(): boolean {
  const row = _db!.prepare("SELECT value FROM meta WHERE key = 'history_migrated'").get() as
    | { value: string }
    | undefined
  return row?.value === "1"
}

function markMigrated(): void {
  _db!.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('history_migrated', '1')").run()
}

function migrateFromHistoryJson(): { sessions: number; players: number; sessionPlayers: number } {
  const stats = { sessions: 0, players: 0, sessionPlayers: 0 }

  const path = HISTORY_JSON()
  if (!existsSync(path)) {
    console.log("[db] no history.json found — nothing to migrate")
    markMigrated()
    return stats
  }

  let raw: any
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"))
  } catch (e) {
    console.error("[db] failed to parse history.json:", e)
    return stats
  }

  if (!raw?.sessions || !Array.isArray(raw.sessions)) {
    markMigrated()
    return stats
  }

  // Deduplicate players by normalized realName/username across the whole history
  const playerIdByName = new Map<string, string>()

  const upsertPlayer = _db!.prepare(`
    INSERT OR IGNORE INTO players (id, client_id, real_name, username, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const upsertProgress = _db!.prepare(`
    INSERT OR IGNORE INTO player_progress (player_id) VALUES (?)
  `)
  const insertSession = _db!.prepare(`
    INSERT OR IGNORE INTO sessions (id, quiz_id, quiz_title, mode, started_at, ended_at, week_iso, month_iso)
    VALUES (?, ?, ?, 'classic', ?, ?, ?, ?)
  `)
  const insertSP = _db!.prepare(`
    INSERT INTO session_players (session_id, player_id, rank, points, correct, incorrect, unanswered, answers_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  _db!.exec("BEGIN")
  try {
    for (const session of raw.sessions) {
      const sessionId = session.id || randomUUID()
      const date = session.date || new Date().toISOString()
      const weekIso = getISOWeek(new Date(date))
      const monthIso = (session.month as string) || date.slice(0, 7)

      const insResult = insertSession.run(
        sessionId,
        session.quizId || "unknown",
        session.quizTitle || session.quizId || "Quiz",
        date,
        date,
        weekIso,
        monthIso
      )
      if (insResult.changes > 0) stats.sessions += 1

      const players: any[] = session.players || []
      for (let i = 0; i < players.length; i++) {
        const p = players[i]
        const nameKey = normName(p.realName || p.username || "")
        if (!nameKey) continue

        let playerId = playerIdByName.get(nameKey)
        if (!playerId) {
          const existing = _db!
            .prepare("SELECT id FROM players WHERE LOWER(real_name) = ? LIMIT 1")
            .get(nameKey) as { id: string } | undefined
          if (existing) {
            playerId = existing.id
          } else {
            playerId = randomUUID()
            upsertPlayer.run(
              playerId,
              null,
              (p.realName || p.username || "").trim(),
              (p.username || p.realName || "").trim(),
              date,
              date
            )
            upsertProgress.run(playerId)
            stats.players += 1
          }
          playerIdByName.set(nameKey, playerId)
        }

        insertSP.run(
          sessionId,
          playerId,
          Number(p.rank) || i + 1,
          Math.round(Number(p.points) || 0),
          Number(p.correct) || 0,
          Number(p.incorrect) || 0,
          Number(p.unanswered) || 0,
          JSON.stringify(p.answers || [])
        )
        stats.sessionPlayers += 1
      }
    }
    markMigrated()
    _db!.exec("COMMIT")
  } catch (e) {
    _db!.exec("ROLLBACK")
    throw e
  }
  return stats
}

function ensureAvatarKindColumns(): void {
  const cols = _db!.prepare("PRAGMA table_info(players)").all() as Array<{ name: string }>
  const names = new Set(cols.map(c => c.name))
  if (!names.has("avatar_kind")) {
    _db!.exec("ALTER TABLE players ADD COLUMN avatar_kind TEXT NOT NULL DEFAULT 'dicebear'")
    console.log("[db] added players.avatar_kind")
  }
  if (!names.has("avatar_3d_id")) {
    _db!.exec("ALTER TABLE players ADD COLUMN avatar_3d_id TEXT")
    console.log("[db] added players.avatar_3d_id")
  }
}


function ensureLdapPlayersTable(): void {
  _db!.exec("CREATE TABLE IF NOT EXISTS ldap_players (real_name TEXT PRIMARY KEY)")

  // Identity that survives a rename.
  //
  // `ldap_players` records only the DISPLAY NAME, and the display name is
  // derived from AD and changes whenever HR corrects someone's record. When it
  // changes, this app creates a brand new player row and the old history is
  // orphaned - there is nothing tying the two together.
  //
  // The account (sAMAccountName) never changes, so it is the real identity.
  // The primary key is (account, display_name) rather than account alone: a
  // rename ADDS a row instead of overwriting one, which is exactly what lets a
  // consumer see that two differently-named player rows are the same person.
  //
  // Read by ShiftSync (escalas) to attribute the ranking. Before this table
  // existed it had to guess from the name alone, and it merged two different
  // employees whose names abbreviated to the same string.
  _db!.exec(`CREATE TABLE IF NOT EXISTS ldap_identities (
    account       TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    PRIMARY KEY (account, display_name)
  )`)
  _db!.exec("CREATE INDEX IF NOT EXISTS idx_ldap_identities_name ON ldap_identities(display_name)")
}

// ─── Public API ─────────────────────────────────────────────────────────────

export const Database = {
  init(): void {
    if (_db) return

    const path = DB_PATH()
    console.log(`[db] opening ${path}`)
    _db = new DatabaseSync(path)
    _db.exec("PRAGMA journal_mode = WAL")
    _db.exec("PRAGMA foreign_keys = ON")
    _db.exec(SCHEMA_SQL)
    console.log("[db] schema ready"); ensureAvatarKindColumns(); ensureLdapPlayersTable()

    if (!isMigrated()) {
      console.log("[db] migrating history.json …")
      const stats = migrateFromHistoryJson()
      console.log(
        `[db] migrated: ${stats.sessions} sessions, ${stats.players} players, ${stats.sessionPlayers} session_players`
      )
    } else {
      console.log("[db] history already migrated (skipped)")
    }
  },

  close(): void {
    if (_db) {
      _db.close()
      _db = null
    }
  },

  // Introspection helpers for ops / testing
  counts(): Record<string, number> {
    const tables = [
      "players",
      "player_progress",
      "sessions",
      "session_players",
      "player_badges",
      "weekly_snapshots",
      "solo_attempts",
    ]
    const result: Record<string, number> = {}
    for (const t of tables) {
      const row = _db!.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }
      result[t] = row.n
    }
    return result
  },
}

export { getISOWeek, normName }

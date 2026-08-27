import { Server } from "@rahoot/common/types/game/socket"
import { inviteCodeValidator } from "@rahoot/common/validators/auth"
import env from "@rahoot/socket/env"
import Config from "@rahoot/socket/services/config"
import { Database, db } from "@rahoot/socket/services/db"
import { backfillXpFromExistingSessions } from "@rahoot/socket/services/sessionRecorder"
import { backfillBadgesForAll, BADGE_CATALOG_PUBLIC } from "@rahoot/socket/services/badges"
import Game from "@rahoot/socket/services/game"
import Registry from "@rahoot/socket/services/registry"
import { withGame } from "@rahoot/socket/utils/game"
import { appendSession, getPlayerHistory, getMonthlyLeaderboard } from "@rahoot/socket/services/history"
import { recordSession } from "@rahoot/socket/services/sessionRecorder"
import { getProfile } from "@rahoot/socket/services/profile"
import { getSoloQuizFor, submitSoloAttempt, getSoloReview } from "@rahoot/socket/services/soloMode"
import { snapshotClosedWeeks, getAllLeaderboards } from "@rahoot/socket/services/leaderboards"
import { listAvatars, saveAvatarSelection } from "@rahoot/socket/services/avatars3d"
import { ldapAuthenticate } from "@rahoot/socket/services/ldap"
import { Server as ServerIO } from "socket.io"
import { createRequire as _createRequire } from "module"
// Works in both ESM (dev/tsx) and CJS bundle (production)
const require = typeof __filename !== "undefined"
  ? _createRequire(__filename)
  : _createRequire(import.meta.url)

const io: Server = new ServerIO({
  cors: { origin: [env.WEB_ORIGIN] },
})
Config.init()
Database.init()
const _bf = backfillXpFromExistingSessions(); if (_bf.updated > 0) console.log(`[xp] backfilled ${_bf.updated} rows across ${_bf.playersTouched} players`)
const _bb = backfillBadgesForAll(); if (_bb.badgesAwarded > 0) console.log(`[badges] awarded ${_bb.badgesAwarded} badges across ${_bb.playersTouched} players (backfill)`)
const _sn = snapshotClosedWeeks(); if (_sn.weeksSnapshotted > 0) console.log(`[leaderboards] snapshotted ${_sn.weeksSnapshotted} closed weeks (${_sn.rowsInserted} rows)`)

const registry = Registry.getInstance()
// In-memory cache: gameId → last fullResults payload
const lastSessionResults = new Map<string, { quizId: string; quizTitle: string; players: any[] }>()

// Build a lightweight player list for the waiting room
const buildRoomList = (game: any) =>
  (game.players as any[])
    .filter(p => p.connected !== false)
    .map(p => ({ id: p.id, username: p.username, avatarUrl: p.avatarUrl || null }))

const port = 3001

// 60s cache for the difficult-questions analytics (expensive full scan), keyed by period filter
const difficultQuestionsCache = new Map<string, { at: number; questions: any[] }>()

console.log(`Socket server running on port ${port}`)
io.listen(Number(port))

io.on("connection", (socket) => {
  console.log(`A user connected: socketId: ${socket.id}, clientId: ${socket.handshake.auth.clientId}`)

  socket.on("player:reconnect", ({ gameId }) => {
    const game = registry.getPlayerGame(gameId, socket.handshake.auth.clientId)
    if (game) { game.reconnect(socket); return; }
    socket.emit("game:reset", "Game not found")
  })

  socket.on("manager:reconnect", ({ gameId }) => {
    const game = registry.getManagerGame(gameId, socket.handshake.auth.clientId)
    if (game) { game.reconnect(socket); return; }
    socket.emit("game:reset", "Game expired")
  })

  socket.on("manager:auth", (password) => {
    try {
      const config = Config.game()
      if (password !== config.managerPassword) {
        socket.emit("manager:errorMessage", "Invalid password")
        return
      }
      socket.emit("manager:quizzList", Config.quizz())
    } catch (error) {
      console.error("Failed to read game config:", error)
      socket.emit("manager:errorMessage", "Failed to read game config")
    }
  })

  socket.on("game:create", ({ quizzId, mode = "classic" }: { quizzId: string; mode?: "classic" | "team" }) => {
    const quizzList = Config.quizz()
    const quizz = quizzList.find((q) => q.id === quizzId)
    if (!quizz) { socket.emit("game:errorMessage", "Quizz not found"); return; }
    const game = new Game(io, socket, quizz, mode)
    registry.addGame(game)
  })

  socket.on("player:join", (inviteCode) => {
    const result = inviteCodeValidator.safeParse(inviteCode)
    if (result.error) { socket.emit("game:errorMessage", result.error.issues[0].message); return; }
    const game = registry.getGameByInviteCode(inviteCode)
    if (!game) { socket.emit("game:errorMessage", "Game not found"); return; }
    socket.emit("game:successRoom", game.gameId)
  })

  socket.on("player:login", ({ gameId, data }: any) => {
    let correctedRealName = data.realName
    try {
      const fs = require("fs"); const path = require("path")
      const namesPath = require("path").join(findQuizDir(), "..", "player-names.json")
      if (fs.existsSync(namesPath)) {
        const corrections = JSON.parse(fs.readFileSync(namesPath, "utf-8"))
        const cid = socket.handshake.auth.clientId
        if (corrections[cid]) correctedRealName = corrections[cid]
      }
    } catch {}
    withGame(gameId, socket, (game) => {
      game.join(socket, data.username, data.deviceInfo, correctedRealName, data.avatarUrl)
      // If the name was corrected by the manager, tell the player's browser to update localStorage
      if (correctedRealName !== data.realName) {
        socket.emit("player:nameCorrection" as any, correctedRealName)
      }
      // Broadcast updated player list to everyone in the room (players + manager)
      setTimeout(() => {
        const list = buildRoomList(game)
        io.to(game.gameId).emit("game:roomPlayers" as any, list)
      }, 50)
    })
  })

  // Waiting-room reactions: player sends a funny emoji that broadcasts to everyone
  socket.on("player:waitingReaction", ({ gameId, emoji, label }: any) => {
    const game = registry.getGameById(gameId)
    if (!game) return
    const player = (game.players as any[]).find(p => p.id === socket.id)
    if (!player) return
    io.to(game.gameId).emit("game:waitingReaction" as any, {
      username: player.username,
      avatarUrl: player.avatarUrl || null,
      emoji,
      label,
    })
  })

  // Player requests current room list (on Wait component mount)
  socket.on("player:getRoomPlayers", ({ gameId }: any) => {
    const game = registry.getGameById(gameId)
    if (!game) return
    socket.emit("game:roomPlayers" as any, buildRoomList(game))
  })

  socket.on("manager:kickPlayer", ({ gameId, playerId }) =>
    withGame(gameId, socket, (game) => game.kickPlayer(socket, playerId)),
  )

  socket.on("manager:startGame", ({ gameId }) =>
    withGame(gameId, socket, (game) => game.start(socket)),
  )

  socket.on("player:selectedAnswer", ({ gameId, data }) =>
    withGame(gameId, socket, (game) => game.selectAnswer(socket, data.answerKey)),
  )

  socket.on("player:joinTeam", ({ gameId, data }: any) =>
    withGame(gameId, socket, (game: any) => game.assignTeam(socket, data.team)),
  )

  socket.on("manager:abortQuiz", ({ gameId }) =>
    withGame(gameId, socket, (game) => game.abortRound(socket)),
  )

  socket.on("manager:nextQuestion", ({ gameId }) =>
    withGame(gameId, socket, (game) => game.nextRound(socket)),
  )

  socket.on("manager:showLeaderboard", ({ gameId }) =>
    withGame(gameId, socket, (game) => game.showLeaderboard()),
  )

  socket.on("manager:cancelQuestion", ({ gameId, questionIndex }: any) =>
    withGame(gameId, socket, (game: any) => game.cancelQuestion(socket, questionIndex)),
  )

  socket.on("manager:nextReviewQuestion", ({ gameId }) =>
    withGame(gameId, socket, (game: any) => game.nextReviewQuestion(socket)),
  )

  socket.on("manager:prevReviewQuestion", ({ gameId }) =>
    withGame(gameId, socket, (game: any) => game.prevReviewQuestion(socket)),
  )

  socket.on("manager:endReview", ({ gameId }) =>
    withGame(gameId, socket, (game: any) => game.endReview(socket)),
  )

  socket.on("manager:setAutoPlay", ({ gameId, enabled }: any) =>
    withGame(gameId, socket, (game: any) => game.setAutoPlay(enabled)),
  )

  socket.on("manager:cancelAutoPlay", ({ gameId }: any) =>
    withGame(gameId, socket, (game: any) => game.cancelAutoPlay()),
  )

  // Broadcast emoji reaction from a player to everyone in the game room (manager + all players)
  socket.on("player:fireReaction", ({ gameId, reactionUrl }: any) => {
    if (gameId) {
      io.to(gameId).emit("game:reaction" as any, { reactionUrl })
    }
  })

  // --- PLAYER NAME CORRECTIONS ---
  socket.on("manager:getPlayerNames", (callback: any) => {
    try {
      const fs = require("fs")
      const namesPath = require("path").join(findQuizDir(), "..", "player-names.json")
      callback(fs.existsSync(namesPath) ? JSON.parse(fs.readFileSync(namesPath, "utf-8")) : {})
    } catch { callback({}) }
  })



  // ── Solo + Combined DB report for manager analytics ──────────────────────
  // Accepts an optional { from, to } ISO date range so the dashboard period
  // filter applies to real session/attempt dates (not quiz last-played).
  // Revisao de uma tentativa, pedida pelo proprio jogador. O servidor confere
  // o dono e aplica a politica do quiz antes de responder — ver getSoloReview.
  socket.on("player:getSoloReview" as any, (args: any, callback?: any) => {
    try {
      const r = getSoloReview(String(args?.sessionId || ""), String(args?.realName || ""))
      if (typeof callback === "function") callback(r)
      else socket.emit("player:soloReview" as any, r)
    } catch (e: any) {
      const err = { ok: false, reason: "not_found" }
      if (typeof callback === "function") callback(err)
      else socket.emit("player:soloReview" as any, err)
    }
  })

  // Exportacao por PERGUNTA, para o treinador. O relatorio que ja existia
  // agrega por pessoa e por quiz, o que responde "quem foi bem"; esta responde
  // "qual pergunta o time erra", que e a que muda o treinamento.
  socket.on("manager:getSoloAnswers" as any, (args: any, callback?: any) => {
    try {
      const quizId = String(args?.quizId || "")
      const linhas = db()
        .prepare(
          `SELECT s.quiz_id AS quizId, s.quiz_title AS quizTitle, s.started_at AS startedAt,
                  p.real_name AS player, sp.answers_json AS answersJson
             FROM sessions s
             JOIN session_players sp ON sp.session_id = s.id
             JOIN players p ON p.id = sp.player_id
            WHERE s.mode = 'solo' ${quizId ? "AND s.quiz_id = ?" : ""}
            ORDER BY s.started_at DESC`
        )
        .all(...(quizId ? [quizId] : [])) as any[]

      const saida: any[] = []
      for (const l of linhas) {
        let itens: any[] = []
        try { itens = JSON.parse(l.answersJson || "[]") } catch { itens = [] }
        itens.forEach((a: any, i: number) => {
          saida.push({
            quiz: l.quizTitle,
            player: l.player,
            when: l.startedAt,
            question_no: (typeof a.questionIndex === "number" ? a.questionIndex : i) + 1,
            question: a.questionTitle ?? "",
            answered: a.selectedAnswer ?? "",
            correct_answer: a.correctAnswer ?? "",
            result: a.isCorrect ? "correct" : "wrong",
          })
        })
      }
      const r = { ok: true, rows: saida }
      if (typeof callback === "function") callback(r)
      else socket.emit("manager:soloAnswers" as any, r)
    } catch (e: any) {
      const err = { ok: false, rows: [] }
      if (typeof callback === "function") callback(err)
      else socket.emit("manager:soloAnswers" as any, err)
    }
  })

  socket.on("manager:getSoloReport", (args: any, callback?: any) => {
    if (typeof args === "function") { callback = args; args = {} }
    if (typeof callback !== "function") return
    try {
      const d = db()
      const from = typeof args?.from === "string" ? args.from : null
      const to   = typeof args?.to   === "string" ? args.to   : null

      // Range clauses for solo_attempts (sa.ended_at) and sessions (s.ended_at)
      let saRange = ""; let sRange = ""; const rp: string[] = []
      if (from) { saRange += " AND sa.ended_at >= ?"; sRange += " AND s.ended_at >= ?"; rp.push(from) }
      if (to)   { saRange += " AND sa.ended_at < ?";  sRange += " AND s.ended_at < ?";  rp.push(to) }

      // Per-quiz aggregate (solo only) — all players, no ldap filter
      const quizStats = d.prepare(`
        SELECT sa.quiz_id,
          COALESCE(
            (SELECT quiz_title FROM sessions WHERE quiz_id = sa.quiz_id AND mode = 'solo' LIMIT 1),
            sa.quiz_id
          ) AS quiz_title,
          COUNT(*) AS total_attempts,
          COUNT(DISTINCT sa.player_id) AS unique_players,
          ROUND(100.0 * SUM(sa.correct) / MAX(1, SUM(sa.correct + sa.incorrect + sa.unanswered))) AS avg_accuracy,
          MAX(sa.points) AS best_score,
          MAX(sa.ended_at) AS last_played
        FROM solo_attempts sa
        JOIN players p ON p.id = sa.player_id
        WHERE 1=1${saRange}
        GROUP BY sa.quiz_id
        ORDER BY total_attempts DESC
      `).all(...rp)

      // Per-player aggregate (solo only) — all players
      const playerStats = d.prepare(`
        SELECT p.real_name,
          COUNT(*) AS total_attempts,
          COUNT(DISTINCT sa.quiz_id) AS quizzes_played,
          SUM(sa.correct) AS total_correct,
          SUM(sa.incorrect + sa.unanswered) AS total_wrong,
          ROUND(100.0 * SUM(sa.correct) / MAX(1, SUM(sa.correct + sa.incorrect + sa.unanswered))) AS avg_accuracy,
          MAX(sa.points) AS best_points,
          MAX(sa.ended_at) AS last_played
        FROM solo_attempts sa
        JOIN players p ON p.id = sa.player_id
        WHERE 1=1${saRange}
        GROUP BY sa.player_id
        ORDER BY avg_accuracy DESC, total_correct DESC
      `).all(...rp)

      // Per-player per-quiz detail — all players
      const detail = d.prepare(`
        SELECT p.real_name, sa.quiz_id,
          COALESCE(
            (SELECT quiz_title FROM sessions WHERE quiz_id = sa.quiz_id AND mode = 'solo' LIMIT 1),
            sa.quiz_id
          ) AS quiz_title,
          COUNT(*) AS attempts,
          MAX(sa.correct) AS best_correct,
          MAX(sa.points) AS best_points,
          ROUND(MAX(100.0 * sa.correct / MAX(1, sa.correct + sa.incorrect + sa.unanswered))) AS best_accuracy,
          MAX(sa.ended_at) AS last_played
        FROM solo_attempts sa
        JOIN players p ON p.id = sa.player_id
        WHERE 1=1${saRange}
        GROUP BY sa.player_id, sa.quiz_id
        ORDER BY p.real_name, sa.quiz_id
      `).all(...rp)

      // Per-player aggregate (team/classic only) — all players, no ldap filter
      const teamStats = d.prepare(`
        SELECT p.real_name,
          COUNT(DISTINCT s.id) AS games_played,
          ROUND(AVG(sp.rank)) AS avg_rank,
          SUM(sp.correct) AS total_correct,
          SUM(sp.incorrect + sp.unanswered) AS total_wrong,
          ROUND(100.0 * SUM(sp.correct) / MAX(1, SUM(sp.correct + sp.incorrect + sp.unanswered))) AS avg_accuracy,
          MAX(sp.points) AS best_points,
          MAX(s.ended_at) AS last_played
        FROM session_players sp
        JOIN sessions s ON s.id = sp.session_id AND s.mode = 'classic'
        JOIN players p ON p.id = sp.player_id
        WHERE 1=1${sRange}
        GROUP BY sp.player_id
        ORDER BY avg_accuracy DESC
      `).all(...rp)

      // Per-quiz aggregate for team/classic games
      const teamQuizStats = d.prepare(`
        SELECT s.quiz_id, s.quiz_title,
          COUNT(DISTINCT s.id) AS total_sessions,
          COUNT(DISTINCT sp.player_id) AS unique_players,
          ROUND(100.0 * SUM(sp.correct) / MAX(1, SUM(sp.correct + sp.incorrect + sp.unanswered))) AS avg_accuracy,
          MAX(sp.points) AS best_score,
          MAX(s.ended_at) AS last_played
        FROM sessions s
        JOIN session_players sp ON sp.session_id = s.id
        WHERE s.mode = 'classic'${sRange}
        GROUP BY s.quiz_id
        ORDER BY total_sessions DESC
      `).all(...rp)

      // Per-player per-quiz detail for team games
      const teamDetail = d.prepare(`
        SELECT p.real_name, s.quiz_id, s.quiz_title,
          COUNT(DISTINCT s.id) AS sessions,
          SUM(sp.correct) AS total_correct,
          MAX(sp.points) AS best_points,
          ROUND(100.0 * SUM(sp.correct) / MAX(1, SUM(sp.correct + sp.incorrect + sp.unanswered))) AS avg_accuracy,
          MIN(sp.rank) AS best_rank,
          MAX(s.ended_at) AS last_played
        FROM session_players sp
        JOIN sessions s ON sp.session_id = s.id AND s.mode = 'classic'
        JOIN players p ON p.id = sp.player_id
        WHERE 1=1${sRange}
        GROUP BY sp.player_id, s.quiz_id
        ORDER BY p.real_name, s.quiz_id
      `).all(...rp)

      callback({ ok: true, quizStats, playerStats, detail, teamStats, teamQuizStats, teamDetail })
    } catch (err: any) {
      callback({ ok: false, error: String(err) })
    }
  })

  // ── Participation by day — real per-session rows for a given local date ──
  socket.on("manager:getDayParticipation", (args: any, callback: any) => {
    if (typeof callback !== "function") return
    try {
      const date  = typeof args?.date  === "string" ? args.date  : null
      const month = typeof args?.month === "string" ? args.month : null
      if (!date && !month) { callback({ ok: false, error: "missing date or month" }); return }

      // `month_iso` is written by this server, whose container runs in
      // America/Sao_Paulo, so the month needs no conversion. The day filter
      // keeps using date(...,'localtime') exactly as before.
      const where = date ? "date(s.ended_at, 'localtime') = ?" : "s.month_iso = ?"
      const arg = (date || month) as string

      const rows = db().prepare(`
        SELECT p.real_name, s.quiz_id, s.quiz_title,
          sp.points, sp.correct, sp.incorrect, sp.unanswered
        FROM session_players sp
        JOIN sessions s ON s.id = sp.session_id AND s.mode = 'classic'
        JOIN players p ON p.id = sp.player_id
        WHERE ${where}
      `).all(arg)

      const sessions = db().prepare(
        `SELECT COUNT(*) AS n FROM sessions s WHERE s.mode = 'classic' AND ${where}`
      ).get(arg) as any

      // Everyone who has ever signed in, so the screen can also show who did
      // NOT take part. Without it the list silently hides exactly the people a
      // manager is looking for.
      const roster = (db().prepare(
        "SELECT real_name FROM ldap_players ORDER BY real_name"
      ).all() as any[]).map(x => x.real_name)

      // Months that actually have sessions, for the picker.
      const months = (db().prepare(
        "SELECT DISTINCT month_iso AS m FROM sessions WHERE mode = 'classic' ORDER BY m DESC"
      ).all() as any[]).map(x => x.m)

      callback({ ok: true, rows, sessions: sessions?.n ?? 0, roster, months })
    } catch (err: any) {
      callback({ ok: false, error: String(err) })
    }
  })

  // ── Real session list for the Activity view (optional date range) ────────
  socket.on("manager:getSessionsList", (args: any, callback: any) => {
    if (typeof callback !== "function") return
    try {
      const from = typeof args?.from === "string" ? args.from : null
      const to   = typeof args?.to   === "string" ? args.to   : null
      let range = ""; const rp: string[] = []
      if (from) { range += " AND s.ended_at >= ?"; rp.push(from) }
      if (to)   { range += " AND s.ended_at < ?";  rp.push(to) }
      const rows = db().prepare(`
        SELECT s.id AS session_id, s.quiz_id, s.quiz_title, s.ended_at,
          COUNT(sp.id) AS player_count,
          SUM(sp.correct) AS total_correct,
          SUM(sp.correct + sp.incorrect + sp.unanswered) AS total_answers
        FROM sessions s
        JOIN session_players sp ON sp.session_id = s.id
        WHERE s.mode = 'classic'${range}
        GROUP BY s.id
        ORDER BY s.ended_at DESC
        LIMIT 50
      `).all(...rp)
      callback({ ok: true, rows })
    } catch (err: any) {
      callback({ ok: false, error: String(err) })
    }
  })

  // ── Daily activity aggregates + range summary (Overview KPIs/trend) ──────
  socket.on("manager:getActivityTrend", (args: any, callback: any) => {
    if (typeof callback !== "function") return
    try {
      const from = typeof args?.from === "string" ? args.from : null
      const to   = typeof args?.to   === "string" ? args.to   : null
      let range = ""; const rp: string[] = []
      if (from) { range += " AND s.ended_at >= ?"; rp.push(from) }
      if (to)   { range += " AND s.ended_at < ?";  rp.push(to) }
      const d = db()
      const days = d.prepare(`
        SELECT date(s.ended_at, 'localtime') AS day,
          COUNT(DISTINCT s.id) AS sessions,
          COUNT(sp.id) AS participations,
          COUNT(DISTINCT sp.player_id) AS players,
          SUM(sp.correct) AS correct,
          SUM(sp.correct + sp.incorrect + sp.unanswered) AS total
        FROM sessions s
        JOIN session_players sp ON sp.session_id = s.id
        WHERE s.mode = 'classic'${range}
        GROUP BY day
        ORDER BY day
      `).all(...rp)
      const summary = d.prepare(`
        SELECT COUNT(DISTINCT s.id) AS sessions,
          COUNT(sp.id) AS participations,
          COUNT(DISTINCT sp.player_id) AS unique_players,
          SUM(sp.correct) AS correct,
          SUM(sp.correct + sp.incorrect + sp.unanswered) AS total
        FROM sessions s
        JOIN session_players sp ON sp.session_id = s.id
        WHERE s.mode = 'classic'${range}
      `).get(...rp)
      callback({ ok: true, days, summary })
    } catch (err: any) {
      callback({ ok: false, error: String(err) })
    }
  })

  // ── Weekly engagement — active players per ISO week + retention ──────────
  socket.on("manager:getEngagement", (callback: any) => {
    if (typeof callback !== "function") return
    try {
      const pairs = db().prepare(`
        SELECT DISTINCT s.week_iso AS week, sp.player_id AS pid
        FROM sessions s
        JOIN session_players sp ON sp.session_id = s.id
        WHERE s.mode = 'classic'
      `).all() as any[]
      const byWeek = new Map<string, Set<string>>()
      for (const r of pairs) {
        if (!byWeek.has(r.week)) byWeek.set(r.week, new Set())
        byWeek.get(r.week)!.add(r.pid)
      }
      const weeks = [...byWeek.keys()].sort()
      const result = weeks.map((w, i) => {
        const cur = byWeek.get(w)!
        const prev = i > 0 ? byWeek.get(weeks[i - 1])! : null
        let retained = 0
        if (prev) for (const p of cur) if (prev.has(p)) retained++
        return { week: w, active: cur.size, retention: prev && prev.size > 0 ? Math.round((retained / prev.size) * 100) : null }
      })
      callback({ ok: true, weeks: result.slice(-12) })
    } catch (err: any) {
      callback({ ok: false, error: String(err) })
    }
  })

  // ── Per-player accuracy/points evolution (recent sessions, both modes) ───
  socket.on("manager:getPlayerTrend", (args: any, callback: any) => {
    if (typeof callback !== "function") return
    try {
      const name = typeof args?.name === "string" ? args.name : null
      if (!name) { callback({ ok: false, error: "missing name" }); return }
      const d = db()
      const classic = d.prepare(`
        SELECT s.ended_at, sp.points, sp.correct,
          (sp.correct + sp.incorrect + sp.unanswered) AS total
        FROM session_players sp
        JOIN sessions s ON s.id = sp.session_id AND s.mode = 'classic'
        JOIN players p ON p.id = sp.player_id
        WHERE p.real_name = ?
        ORDER BY s.ended_at DESC
        LIMIT 20
      `).all(name) as any[]
      const solo = d.prepare(`
        SELECT sa.ended_at, sa.points, sa.correct,
          (sa.correct + sa.incorrect + sa.unanswered) AS total
        FROM solo_attempts sa
        JOIN players p ON p.id = sa.player_id
        WHERE p.real_name = ?
        ORDER BY sa.ended_at DESC
        LIMIT 20
      `).all(name) as any[]
      callback({ ok: true, classic: classic.reverse(), solo: solo.reverse() })
    } catch (err: any) {
      callback({ ok: false, error: String(err) })
    }
  })

  // ── LDAP-known players with no activity in the period ────────────────────
  socket.on("manager:getNonParticipants", (args: any, callback: any) => {
    if (typeof callback !== "function") return
    try {
      const from = typeof args?.from === "string" ? args.from : null
      const to   = typeof args?.to   === "string" ? args.to   : null
      let cRange = ""; let sRange = ""; const rp: string[] = []
      if (from) { cRange += " AND s.ended_at >= ?"; rp.push(from) }
      if (to)   { cRange += " AND s.ended_at < ?";  rp.push(to) }
      if (from) { sRange += " AND sa.ended_at >= ?"; rp.push(from) }
      if (to)   { sRange += " AND sa.ended_at < ?";  rp.push(to) }
      const rows = db().prepare(`
        SELECT lp.real_name,
          (SELECT MAX(s2.ended_at) FROM session_players sp2
             JOIN sessions s2 ON s2.id = sp2.session_id
             JOIN players p2 ON p2.id = sp2.player_id
           WHERE p2.real_name = lp.real_name) AS last_classic,
          (SELECT MAX(sa2.ended_at) FROM solo_attempts sa2
             JOIN players p3 ON p3.id = sa2.player_id
           WHERE p3.real_name = lp.real_name) AS last_solo
        FROM ldap_players lp
        WHERE NOT EXISTS (
          SELECT 1 FROM session_players sp
            JOIN sessions s ON s.id = sp.session_id AND s.mode = 'classic'
            JOIN players p ON p.id = sp.player_id
          WHERE p.real_name = lp.real_name${cRange}
        ) AND NOT EXISTS (
          SELECT 1 FROM solo_attempts sa
            JOIN players p ON p.id = sa.player_id
          WHERE p.real_name = lp.real_name${sRange}
        )
        ORDER BY lp.real_name
      `).all(...rp)
      callback({ ok: true, rows })
    } catch (err: any) {
      callback({ ok: false, error: String(err) })
    }
  })

  // Player asks on mount: "do I have an AKA?" — returns corrected name or null
  socket.on("player:checkName", (callback: any) => {
    try {
      const cid = socket.handshake.auth.clientId
      if (!cid) { callback(null); return }
      const fs = require("fs")
      const namesPath = require("path").join(findQuizDir(), "..", "player-names.json")
      if (fs.existsSync(namesPath)) {
        const corrections = JSON.parse(fs.readFileSync(namesPath, "utf-8"))
        callback(corrections[cid] || null)
      } else { callback(null) }
    } catch { callback(null) }
  })

  socket.on("manager:updatePlayerName", ({ clientId, correctedName }: any) => {
    try {
      const fs = require("fs")
      const namesPath = require("path").join(findQuizDir(), "..", "player-names.json")
      const map = fs.existsSync(namesPath) ? JSON.parse(fs.readFileSync(namesPath, "utf-8")) : {}
      if (correctedName && correctedName.trim()) { map[clientId] = correctedName.trim() }
      else { delete map[clientId] }
      fs.writeFileSync(namesPath, JSON.stringify(map, null, 2))
      // Also update the SQLite players table so rankings and history use the corrected name
      if (correctedName && correctedName.trim()) {
        try {
          db().prepare("UPDATE players SET real_name = ? WHERE client_id = ?").run(correctedName.trim(), clientId)
        } catch {}
      }
      // Push corrected name to the player's browser in real-time if they are connected
      try {
        for (const [, s] of (io as any).sockets.sockets) {
          if ((s as any).handshake?.auth?.clientId === clientId) {
            s.emit("player:nameCorrection", correctedName && correctedName.trim() ? correctedName.trim() : null)
          }
        }
      } catch {}
    } catch (err) { console.error("Error updating player name:", err) }
  })

  // --- TOGGLE CANCELLED QUESTION IN QUIZ JSON ---
  socket.on("manager:toggleCancelledQuestion", ({ quizId, questionIndex }: any) => {
    try {
      const fs = require("fs")
      const dir = findQuizDir()
      const jsonPath = require("path").join(dir, quizId.endsWith(".json") ? quizId : quizId + ".json")
      if (!fs.existsSync(jsonPath)) return
      const quiz = JSON.parse(fs.readFileSync(jsonPath, "utf-8"))
      if (!quiz.cancelledQuestions) quiz.cancelledQuestions = []
      const idx = quiz.cancelledQuestions.indexOf(questionIndex)
      if (idx >= 0) quiz.cancelledQuestions.splice(idx, 1)
      else quiz.cancelledQuestions.push(questionIndex)
      fs.writeFileSync(jsonPath, JSON.stringify(quiz, null, 2))
      socket.emit("manager:quizzList", Config.quizz())
    } catch (err) { console.error("Error toggling cancelled question:", err) }
  })

  // --- START CMS & UPLOAD SYSTEM ---
  const findQuizDir = () => {
    const fs = require("fs");
    const path = require("path");
    const possiblePaths = [
      path.join(process.cwd(), "../../config/quizz"),
      "/rahoot/config/quizz",
      "/app/config/quizz",
      path.join(process.cwd(), "config/quizz")
    ];
    return possiblePaths.find((p: string) => fs.existsSync(p)) || possiblePaths[0];
  };

  socket.on("manager:uploadImage", ({ fileName, fileBuffer }: any, callback: any) => {
    const fs = require('fs');
    const path = require('path');
    try {
      const uploadDir = path.join(process.cwd(), "../web/public/uploads");
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const fileExt = path.extname(fileName);
      const safeName = "img-" + Date.now() + fileExt;
      const filePath = path.join(uploadDir, safeName);
      fs.writeFileSync(filePath, fileBuffer);
      callback({ success: true, url: "/uploads/" + safeName });
    } catch (err: any) {
      callback({ success: false, error: String(err) });
    }
  });

  socket.on("manager:createQuiz", (newQuiz: any) => {
    try {
      const fs = require("fs");
      const path = require("path");
      const dir = findQuizDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const safeName = newQuiz.id || (newQuiz.subject.toLowerCase().replace(/[^a-z0-9]/g, '-') + "-" + Date.now() + ".json");
      const filePath = path.join(dir, safeName.endsWith('.json') ? safeName : safeName + '.json');
      // Editing an existing quiz reuses this same event, and the editor's
      // client-side copy can go stale (e.g. someone runs the quiz while the
      // manager still has the editor open) — the game-end handler writes
      // results straight to disk without refreshing the manager's quiz list.
      // Always keep whatever is on disk for result fields so an edit save
      // can never erase results a session just recorded.
      if (fs.existsSync(filePath)) {
        try {
          const onDisk = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          for (const k of ["lastSessionStats", "totalGamesPlayed", "cancelledQuestions"]) {
            if (onDisk[k] !== undefined) newQuiz[k] = onDisk[k];
          }
        } catch {}
      }
      fs.writeFileSync(filePath, JSON.stringify(newQuiz, null, 2));
    } catch (err: any) {
      console.error("Error creating quiz:", err);
    }
  });

  socket.on("manager:deleteQuiz", (id: any) => {
    try {
      const fs = require("fs");
      const path = require("path");
      const dir = findQuizDir();
      const jsonPath = path.join(dir, id + (id.endsWith('.json') ? '' : '.json'));
      if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
    } catch (err: any) {
      console.error("Error deleting quiz:", err);
    }
  });

  socket.on("manager:updateLastPlayed", (id: any) => {
    try {
      const fs = require("fs");
      const path = require("path");
      const dir = findQuizDir();
      const jsonPath = path.join(dir, id + (id.endsWith('.json') ? '' : '.json'));
      if (fs.existsSync(jsonPath)) {
        const quizData = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
        quizData.lastPlayedAt = new Intl.DateTimeFormat('pt-BR', { 
          day: '2-digit', month: '2-digit', year: 'numeric', 
          hour: '2-digit', minute: '2-digit' 
        }).format(new Date());
        fs.writeFileSync(jsonPath, JSON.stringify(quizData, null, 2));
      }
    } catch (err: any) {
      console.error("Error updating last played:", err);
    }
  });
  
  // 🚀 CÓDIGO CORRIGIDO PARA SALVAR STATS (DOCKER SAFE)
    socket.on("manager:saveSessionStats", ({ quizId, stats }: any) => {
    try {
      const fs = require("fs");
      const path = require("path");
      const dir = findQuizDir();
      let targetId = quizId || "";

      const jsonPath = path.join(dir, targetId.endsWith('.json') ? targetId : targetId + '.json');
      let saved = false;
      let quizTitle = targetId;

      if (fs.existsSync(jsonPath)) {
        const quizData = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
        quizData.lastSessionStats = stats;
        quizData.totalGamesPlayed = (quizData.totalGamesPlayed || 0) + 1;
        fs.writeFileSync(jsonPath, JSON.stringify(quizData, null, 2));
        quizTitle = quizData.subject || targetId;
        saved = true;
      } else {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.json')) {
            const qPath = path.join(dir, file);
            const qData = JSON.parse(fs.readFileSync(qPath, "utf-8"));
            if (qData.subject === targetId || qData.id === targetId) {
              qData.lastSessionStats = stats;
              qData.totalGamesPlayed = (qData.totalGamesPlayed || 0) + 1;
              fs.writeFileSync(qPath, JSON.stringify(qData, null, 2));
              quizTitle = qData.subject || targetId;
              saved = true;
              break;
            }
          }
        }
      }

      if (saved) {
        console.log("Stats saved for quiz: " + targetId);
        // Cache results so late-connecting players can still request them
        const mg = registry.getGameByManagerSocketId(socket.id);
        const gid = mg?.gameId;
        const payload = { quizId: targetId, quizTitle, players: stats };
        if (gid) lastSessionResults.set(gid, payload);

        // Broadcast full results to everyone in the game room
        try {
          appendSession(targetId, quizTitle, stats);
          try { const r = recordSession(targetId, quizTitle, "classic", stats); console.log("[xp] session " + r.sessionId + " awarded xp to " + r.awarded.length + " players"); } catch (xe) { console.error("recordSession error:", xe); }
        } catch (he) { console.error("appendSession error:", he); }

        if (gid) {
          io.to(gid).emit("game:fullResults" as any, payload);
          console.log("Full results broadcast to room " + gid);
        }

        // Backfill 5/5 for players who did not submit feedback
        try {
          const mg2 = registry.getGameByManagerSocketId(socket.id);
          if (mg2) {
            const gid2 = mg2.gameId;
            const quizId2 = targetId.replace(/\.json$/i, "");
            const insertFb = db().prepare(
              "INSERT OR IGNORE INTO quiz_feedback (quiz_id, game_id, player_client_id, player_name, rating, auto_filled) VALUES (?, ?, ?, ?, 5, 1)"
            );
            for (const player of (stats as any[])) {
              const cid = player.clientId || player.client_id || "";
              if (cid) insertFb.run(quizId2, gid2, cid, player.realName || player.username || "");
            }
            console.log("[feedback] backfill done for game " + gid2);
          }
        } catch (fbe) { console.error("Feedback backfill error:", fbe); }
      }
    } catch (err) {
      console.error("Error saving session stats:", err);
    }
  });
  // --- END CMS & UPLOAD SYSTEM ---

    // --- PLAYER HISTORY & MONTHLY LEADERBOARD ---
  socket.on("player:getHistory", ({ realName, minSessions, sortBy }: { realName: string; minSessions?: number; sortBy?: 'total' | 'average' | 'balanced' }) => {
    try {
      const history = getPlayerHistory(realName || "");
      const leaderboard = getMonthlyLeaderboard(minSessions ?? 1, sortBy ?? 'total');
      socket.emit("player:history" as any, { history, leaderboard });
    } catch (err) { console.error("History fetch error:", err); }
  });

  socket.on("player:getProfile" as any, ({ realName }: any) => {
    try {
      const profile = getProfile(realName || "");
      socket.emit("player:profile" as any, profile);
    } catch (err) { console.error("Profile fetch error:", err); }
  });

  socket.on("solo:getQuiz" as any, ({ quizId, realName }: any) => {
    try {
      const resp = getSoloQuizFor(String(quizId || ""), String(realName || ""));
      socket.emit("solo:quiz" as any, resp);
    } catch (err) {
      console.error("solo:getQuiz error:", err);
      socket.emit("solo:quiz" as any, { ok: false, reason: "server_error" });
    }
  });

  socket.on("solo:submit" as any, (payload: any) => {
    try {
      const resp = submitSoloAttempt(payload || {});
      socket.emit("solo:result" as any, resp);
      if ((resp as any).ok) {
        console.log("[solo] " + payload.realName + " completed " + payload.quizId + " (attempt " + (resp as any).attemptNumber + "/" + (resp as any).maxAttempts + ", +" + (resp as any).xpGained + " XP)");
      }
    } catch (err) {
      console.error("solo:submit error:", err);
      socket.emit("solo:result" as any, { ok: false, reason: "server_error" });
    }
  });

  socket.on("leaderboards:get" as any, () => {
    try {
      const data = getAllLeaderboards();
      socket.emit("leaderboards:data" as any, { ok: true, data });
    } catch (err) {
      console.error("leaderboards:get error:", err);
      socket.emit("leaderboards:data" as any, { ok: false, reason: "server_error" });
    }
  });

  socket.on("avatar3d:list" as any, () => {
    try {
      const payload = listAvatars();
      socket.emit("avatar3d:catalog" as any, { ok: true, ...payload });
    } catch (err) {
      console.error("avatar3d:list error:", err);
      socket.emit("avatar3d:catalog" as any, { ok: false, reason: "server_error" });
    }
  });

  socket.on("avatar3d:save" as any, (payload: any) => {
    try {
      const resp = saveAvatarSelection(payload || {});
      socket.emit("avatar3d:saved" as any, resp);
    } catch (err) {
      console.error("avatar3d:save error:", err);
      socket.emit("avatar3d:saved" as any, { ok: false, reason: "server_error" });
    }
  });

  // Re-emit cached full results to a player who missed the initial broadcast
  socket.on("player:requestResults", ({ gameId }: any) => {
    if (!gameId) return;
    const cached = lastSessionResults.get(gameId);
    if (cached) {
      socket.emit("game:fullResults" as any, cached);
    }
  });


  socket.on("player:ldapAuth", async ({ username, password }, callback) => {
    if (typeof callback !== "function") return
    if (!username || !password) { callback({ ok: false, error: "Username and password required" }); return }
    try {
      const result = await ldapAuthenticate(String(username).trim(), String(password))
      if (result.ok) {
        try {
          db().prepare("INSERT OR IGNORE INTO ldap_players (real_name) VALUES (?)").run(result.fullName)
        } catch {}
        try {
          // Record account -> display name. ON CONFLICT touches last_seen_at
          // only, so the first sighting of each name is preserved: that is what
          // lets a consumer order the names an account has been known by, and
          // therefore follow a person across an AD rename.
          const now = new Date().toISOString()
          db().prepare(
            `INSERT INTO ldap_identities (account, display_name, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(account, display_name) DO UPDATE SET last_seen_at = excluded.last_seen_at`
          ).run(result.account, result.fullName, now, now)
        } catch (e) { console.error("ldap_identities:", e) }
      }
      callback(result)
    } catch (err) {
      callback({ ok: false, error: "Authentication error" })
    }
  })

  // ─── Feedback ────────────────────────────────────────────────────────────────
  socket.on("player:submitFeedback" as any, ({ gameId, rating }: any) => {
    try {
      if (!gameId || !rating || rating < 1 || rating > 5) return;
      const game = registry.getPlayerGame(gameId, socket.handshake.auth.clientId);
      const quizId = (game?.quizz?.id || "").replace(/\.json$/i, "");
      const player = game?.players?.find((p: any) => p.clientId === socket.handshake.auth.clientId);
      const playerName = player?.realName || player?.username || "";
      db().prepare(
        "INSERT OR REPLACE INTO quiz_feedback (quiz_id, game_id, player_client_id, player_name, rating, auto_filled) VALUES (?, ?, ?, ?, ?, 0)"
      ).run(quizId, gameId, socket.handshake.auth.clientId, playerName, Math.round(rating));
      console.log();
    } catch (err) { console.error("submitFeedback error:", err); }
  });

  socket.on("manager:getFeedbackStats" as any, ({ quizId }: any) => {
    try {
      if (!quizId) return;
      const normalizedId = String(quizId).replace(/\.json$/i, "");
      const rows = db().prepare(
        "SELECT rating, auto_filled FROM quiz_feedback WHERE quiz_id = ? OR quiz_id = ?"
      ).all(normalizedId, normalizedId + ".json") as Array<{ rating: number; auto_filled: number }>;
      const total = rows.length;
      const autoFilled = rows.filter(r => r.auto_filled === 1).length;
      const avgRating = total > 0 ? +(rows.reduce((s, r) => s + r.rating, 0) / total).toFixed(2) : 0;
      const dist = [1,2,3,4,5].map(n => ({ rating: n, count: rows.filter(r => r.rating === n).length }));
      socket.emit("manager:feedbackStats" as any, { quizId, avgRating, total, autoFilled, distribution: dist });
    } catch (err) { console.error("getFeedbackStats error:", err); }
  });

  // ── Difficult questions analytics (per-question error rates) ─────────────
  // Full-table scan + JSON.parse of every answers blob — cached for 60s so
  // repeated dashboard opens don't re-run it.
  socket.on("manager:getDifficultQuestions", (args: any, callback?: any) => {
    // Back-compat: older clients emit with the callback as the only argument
    if (typeof args === "function") { callback = args; args = {} }
    if (typeof callback !== "function") return
    const days = Number(args?.days) > 0 ? Math.floor(Number(args.days)) : 0
    const cacheKey = String(days)
    const cached = difficultQuestionsCache.get(cacheKey)
    if (cached && Date.now() - cached.at < 60_000) {
      callback({ ok: true, questions: cached.questions })
      return
    }
    try {
      const d = db()
      // ended_at is ISO 8601, so a string comparison filters by date correctly
      const dateFilter = days > 0 ? " AND s.ended_at >= ?" : ""
      const params = days > 0 ? [new Date(Date.now() - days * 86_400_000).toISOString()] : []
      const rows = d.prepare(`
        SELECT sp.answers_json, s.quiz_id, s.quiz_title, s.ended_at
        FROM session_players sp
        JOIN sessions s ON s.id = sp.session_id
        WHERE sp.answers_json IS NOT NULL${dateFilter}
      `).all(...params) as any[]

      const qmap: Record<string, { questionTitle: string; quizzes: Set<string>; timesAnswered: number; timesCorrect: number; lastAnswered: string }> = {}
      for (const row of rows) {
        try {
          const answers = JSON.parse(row.answers_json) as any[]
          for (const ans of answers) {
            const title = (ans.questionTitle || "").trim()
            if (!title) continue
            if (!qmap[title]) qmap[title] = { questionTitle: title, quizzes: new Set(), timesAnswered: 0, timesCorrect: 0, lastAnswered: "" }
            qmap[title].timesAnswered++
            if (ans.isCorrect) qmap[title].timesCorrect++
            qmap[title].quizzes.add(row.quiz_id)
            if ((row.ended_at || "") > qmap[title].lastAnswered) qmap[title].lastAnswered = row.ended_at
          }
        } catch {}
      }

      const result = Object.values(qmap)
        .filter(q => q.timesAnswered >= 2)
        .map(q => ({
          questionTitle: q.questionTitle,
          quizCount: q.quizzes.size,
          timesAnswered: q.timesAnswered,
          timesCorrect: q.timesCorrect,
          timesWrong: q.timesAnswered - q.timesCorrect,
          errorRate: Math.round((1 - q.timesCorrect / q.timesAnswered) * 100),
          lastAnswered: q.lastAnswered || null,
        }))
        .sort((a, b) => b.errorRate - a.errorRate || b.timesAnswered - a.timesAnswered)
        .slice(0, 100)

      difficultQuestionsCache.set(cacheKey, { at: Date.now(), questions: result })
      callback({ ok: true, questions: result })
    } catch (err: any) {
      callback({ ok: false, error: String(err) })
    }
  })

  // ── Save question bank ─────────────────────────────────────────────────────
  socket.on("manager:saveQuestionBank", ({ title, questionTitles }: any, callback: any) => {
    if (typeof callback !== "function") return
    try {
      const fs = require("fs")
      const path = require("path")
      const dir = findQuizDir()
      const quizFiles = fs.readdirSync(dir).filter((f: string) => f.endsWith(".json"))

      const questionsByTitle: Record<string, any> = {}
      for (const file of quizFiles) {
        try {
          const quiz = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"))
          for (const q of (quiz.questions || [])) {
            const t = (q.question || "").trim()
            if (t && !questionsByTitle[t]) questionsByTitle[t] = { ...q }
          }
        } catch {}
      }

      const found: any[] = []
      for (const qt of (questionTitles || [])) {
        const q = questionsByTitle[(qt || "").trim()]
        if (q) found.push(q)
      }

      if (found.length === 0) { callback({ ok: false, error: "No matching questions found in quiz files" }); return }

      const bankId = `question-bank-${Date.now()}.json`
      const bankQuiz = {
        id: bankId,
        subject: title || "Question Bank",
        createdBy: "Manager",
        createdAt: new Date().toLocaleDateString("pt-BR") + ", " + new Date().toLocaleTimeString("pt-BR"),
        lastPlayedAt: "",
        questions: found,
        lastSessionStats: [],
      }
      fs.writeFileSync(path.join(dir, bankId), JSON.stringify(bankQuiz, null, 2))
      callback({ ok: true, quizId: bankId, count: found.length })
    } catch (err: any) {
      callback({ ok: false, error: String(err) })
    }
  })

  socket.on("disconnect", () => {
    console.log(`A user disconnected : ${socket.id}`)
    const managerGame = registry.getGameByManagerSocketId(socket.id)

    if (managerGame) {
      managerGame.manager.connected = false
      registry.markGameAsEmpty(managerGame)
      if (!managerGame.started) {
        console.log("Reset game (manager disconnected)")
        managerGame.abortCooldown()
        io.to(managerGame.gameId).emit("game:reset", "Manager disconnected")
        registry.removeGame(managerGame.gameId)
        return
      }
    }

    const game = registry.getGameByPlayerSocketId(socket.id)
    if (!game) return;
    const player = game.players.find((p) => p.id === socket.id)
    if (!player) return;

    if (!game.started) {
      game.players = game.players.filter((p) => p.id !== socket.id)
      io.to(game.manager.id).emit("manager:removePlayer", player.id)
      io.to(game.gameId).emit("game:totalPlayers", game.players.length)
      io.to(game.gameId).emit("game:roomPlayers" as any, buildRoomList(game))
      console.log(`Removed player ${player.username} from game ${game.gameId}`)
      return
    }

    player.connected = false
    io.to(game.gameId).emit("game:totalPlayers", game.players.length)
  })
})

process.on("SIGINT", () => {
  Registry.getInstance().cleanup()
  process.exit(0)
})

process.on("SIGTERM", () => {
  Registry.getInstance().cleanup()
  process.exit(0)
})

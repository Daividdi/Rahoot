/**
 * Solo mode — Phase 5.
 *
 * Self-paced single-player quiz runner. No manager, no orchestrator — the
 * client drives the flow and submits the final stats here. Server records
 * the session (mode="solo") and increments the attempt counter.
 *
 * Attempt limit comes from the quiz JSON (`solo.maxAttempts`, default 3).
 * Solo sessions count for XP, progression, and badges but NOT for weekly
 * or monthly multiplayer rankings — that's enforced downstream by filtering
 * `sessions.mode = 'classic'` where it matters.
 */

import Config from "@rahoot/socket/services/config"
import { db, normName } from "@rahoot/socket/services/db"
import { randomUUID } from "node:crypto"
import {
  xpForSession,
  longestStreak,
  levelFromXp,
  tierFromLevel,
} from "@rahoot/socket/services/progression"
import { checkAndAwardBadges, BadgeUnlock } from "@rahoot/socket/services/badges"

const DEFAULT_MAX_ATTEMPTS = 3

export interface SoloQuizPayload {
  ok: true
  quiz: {
    id: string
    subject: string
    questions: Array<{
      question: string
      answers: string[]
      solution: number      // kept client-side for local grading (honor-system)
      time: number
      cooldown: number
      image?: string
    }>
  }
  attemptsUsed: number
  maxAttempts: number
}

export type SoloQuizResponse =
  | SoloQuizPayload
  | {
      ok: false
      reason: "not_found" | "no_attempts_left" | "solo_disabled"
      /** Present on no_attempts_left so the screen can say how many were used. */
      attemptsUsed?: number
      maxAttempts?: number
    }

function findPlayerIdByName(realName: string): string | null {
  const key = normName(realName)
  if (!key) return null
  const r = db()
    .prepare("SELECT id FROM players WHERE LOWER(real_name) = ? LIMIT 1")
    .get(key) as { id: string } | undefined
  return r?.id ?? null
}

function ensurePlayer(realName: string, username: string): string {
  const existing = findPlayerIdByName(realName)
  if (existing) return existing
  const id = randomUUID()
  const now = new Date().toISOString()
  db()
    .prepare(
      `INSERT INTO players (id, client_id, real_name, username, created_at, last_seen_at)
       VALUES (?, NULL, ?, ?, ?, ?)`
    )
    .run(id, realName.trim(), username.trim() || realName.trim(), now, now)
  db().prepare("INSERT OR IGNORE INTO player_progress (player_id) VALUES (?)").run(id)
  return id
}

function loadQuiz(quizId: string): any {
  const list = Config.quizz()
  return list.find((q: any) => q.id === quizId) ?? null
}

function countAttempts(playerId: string, quizId: string): number {
  const r = db()
    .prepare("SELECT COUNT(*) AS n FROM solo_attempts WHERE player_id = ? AND quiz_id = ?")
    .get(playerId, quizId) as { n: number }
  return r.n
}

export function getSoloQuizFor(quizId: string, realName: string): SoloQuizResponse {
  const quiz = loadQuiz(quizId)
  if (!quiz) return { ok: false, reason: "not_found" }

  const solo = quiz.solo || {}
  // Default-enabled for MVP; teacher can set `solo.enabled=false` in JSON to opt out.
  if (solo.enabled === false) return { ok: false, reason: "solo_disabled" }
  const maxAttempts = Number(solo.maxAttempts) > 0 ? Number(solo.maxAttempts) : DEFAULT_MAX_ATTEMPTS

  let attemptsUsed = 0
  if (realName.trim()) {
    const pid = findPlayerIdByName(realName)
    if (pid) attemptsUsed = countAttempts(pid, quizId)
  }

  if (attemptsUsed >= maxAttempts) {
    return { ok: false, reason: "no_attempts_left", attemptsUsed, maxAttempts }
  }

  return {
    ok: true,
    quiz: {
      id: quiz.id,
      subject: quiz.subject || quiz.id,
      questions: (quiz.questions || []).map((q: any) => ({
        question: q.question,
        answers: q.answers,
        answerImages: q.answerImages || null,
        solution: q.solution,
        time: Number(q.time) || 15,
        cooldown: Number(q.cooldown) || 0,
        image: q.image,
      })),
    },
    attemptsUsed,
    maxAttempts,
  }
}

export interface SoloSubmitInput {
  quizId: string
  realName: string
  username?: string
  avatarUrl?: string
  startedAt: string
  answers: Array<{
    questionTitle: string
    selectedAnswer: string
    isCorrect: boolean
  }>
  points: number
}

export interface SoloSubmitOk {
  ok: true
  sessionId: string
  attemptNumber: number
  maxAttempts: number
  xpGained: number
  newXp: number
  newLevel: number
  newTier: string
  newBadges: BadgeUnlock[]
  correct: number
  incorrect: number
  unanswered: number
  longestStreak: number
  isPerfect: boolean
}

export type SoloSubmitResponse = SoloSubmitOk | { ok: false; reason: "not_found" | "no_attempts_left" | "invalid_payload" | "solo_disabled" }

export function submitSoloAttempt(input: SoloSubmitInput): SoloSubmitResponse {
  if (!input.realName?.trim() || !input.quizId) {
    return { ok: false, reason: "invalid_payload" }
  }
  const quiz = loadQuiz(input.quizId)
  if (!quiz) return { ok: false, reason: "not_found" }

  const solo = quiz.solo || {}
  if (solo.enabled === false) return { ok: false, reason: "solo_disabled" }
  const maxAttempts = Number(solo.maxAttempts) > 0 ? Number(solo.maxAttempts) : DEFAULT_MAX_ATTEMPTS

  const realName = input.realName.trim()
  const username = (input.username || realName).trim()
  const playerId = ensurePlayer(realName, username)

  const attemptsUsed = countAttempts(playerId, input.quizId)
  if (attemptsUsed >= maxAttempts) {
    return { ok: false, reason: "no_attempts_left" }
  }

  const answers = Array.isArray(input.answers) ? input.answers : []
  const correct = answers.filter(a => a?.isCorrect === true).length
  const incorrect = answers.filter(a => a && a.isCorrect !== true && a.selectedAnswer !== "Não respondeu").length
  const unanswered = answers.filter(a => a?.selectedAnswer === "Não respondeu").length
  const totalQ = correct + incorrect + unanswered
  const isPerfect = totalQ >= 3 && correct === totalQ
  const lg = longestStreak(answers)
  const points = Math.round(Number(input.points) || 0)

  const xpGained = xpForSession({
    rank: 1,
    totalPlayers: 1,
    correct, incorrect, unanswered,
    points,
    longestStreakInGame: lg,
  })

  const now = new Date().toISOString()
  const sessionId = randomUUID()
  const weekIso = getISOWeekInternal(new Date(now))
  const monthIso = now.slice(0, 7)
  const quizTitle = quiz.subject || input.quizId

  const insSession = db().prepare(
    `INSERT INTO sessions (id, quiz_id, quiz_title, mode, started_at, ended_at, week_iso, month_iso)
     VALUES (?, ?, ?, 'solo', ?, ?, ?, ?)`
  )
  const insSP = db().prepare(
    `INSERT INTO session_players
       (session_id, player_id, rank, points, correct, incorrect, unanswered, xp_gained, answers_json)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`
  )
  const insSolo = db().prepare(
    `INSERT INTO solo_attempts
       (player_id, quiz_id, attempt_number, points, correct, incorrect, unanswered, xp_gained, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const getProg = db().prepare("SELECT xp FROM player_progress WHERE player_id = ?")
  const updProg = db().prepare(
    `UPDATE player_progress
        SET xp = ?, level = ?, tier = ?,
            longest_streak = MAX(longest_streak, ?),
            games_played   = games_played + 1,
            perfect_games  = perfect_games + ?,
            total_correct  = total_correct + ?,
            total_answered = total_answered + ?,
            last_game_at   = ?
      WHERE player_id = ?`
  )

  let newXp = 0
  let newLevel = 1
  let newTier = "bronze"
  let newBadges: BadgeUnlock[] = []

  db().exec("BEGIN")
  try {
    insSession.run(sessionId, input.quizId, quizTitle, input.startedAt || now, now, weekIso, monthIso)
    insSP.run(sessionId, playerId, points, correct, incorrect, unanswered, xpGained, JSON.stringify(answers))
    insSolo.run(
      playerId, input.quizId, attemptsUsed + 1,
      points, correct, incorrect, unanswered, xpGained,
      input.startedAt || now, now
    )

    const prev = getProg.get(playerId) as { xp: number } | undefined
    newXp = (prev?.xp ?? 0) + xpGained
    newLevel = levelFromXp(newXp)
    newTier = tierFromLevel(newLevel)
    updProg.run(newXp, newLevel, newTier, lg, isPerfect ? 1 : 0, correct, totalQ, now, playerId)

    newBadges = checkAndAwardBadges(playerId)
    db().exec("COMMIT")
  } catch (e) {
    db().exec("ROLLBACK")
    throw e
  }

  return {
    ok: true,
    sessionId,
    attemptNumber: attemptsUsed + 1,
    maxAttempts,
    xpGained,
    newXp,
    newLevel,
    newTier,
    newBadges,
    correct,
    incorrect,
    unanswered,
    longestStreak: lg,
    isPerfect,
  }
}

// Local copy of getISOWeek to avoid pulling the full db module just for this
function getISOWeekInternal(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

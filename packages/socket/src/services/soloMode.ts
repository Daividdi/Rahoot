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
      solution: number | number[] // kept client-side for local grading (honor-system)
      time: number
      cooldown: number
      image?: string
      answerImages?: string[] | null
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

  // O que foi respondido ja era guardado em `session_players.answers_json`; o
  // que faltava era o GABARITO. Sem ele a revisao teria de procurar a pergunta
  // no quiz atual pelo texto — e um quiz editado depois faria a revisao de uma
  // tentativa antiga mentir, ou simplesmente nao achar. Guardar a resposta
  // certa junto congela a tentativa como ela foi.
  const perguntas: any[] = Array.isArray(quiz.questions) ? quiz.questions : []
  const respostasDetalhadas = (input.answers || []).map((a, i) => {
    const q = perguntas[i]
    const opcoes: string[] = Array.isArray(q?.answers) ? q.answers : []
    let idxCerta: number | number[] = -1
    if (Array.isArray(q?.solution)) {
      idxCerta = q.solution
    } else if (typeof q?.solution === "number") {
      idxCerta = q.solution
    }
    const indicesCertos = Array.isArray(idxCerta)
      ? idxCerta
      : idxCerta >= 0
        ? [idxCerta]
        : []
    return {
      ...a,
      questionIndex: i,
      options: opcoes,
      correctIndex: idxCerta,
        correctAnswer: indicesCertos
          .map((index) => opcoes[index] ?? String(index))
          .join(", "),
    }
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

  // O console lia `lastPlayedAt`/`totalGamesPlayed` do JSON do quiz, e so o
  // modo classico os escrevia — por isso um quiz jogado dezenas de vezes em
  // solo aparecia como "Never played, 0 sessions". Solo passa a marcar os
  // proprios campos, separados: misturar com os do classico distorceria as
  // estatisticas de sessao, que sao de jogo com turma.
  try {
    const fsq = require("fs")
    const arq = Config.quizzFilePath(input.quizId)
    if (fsq.existsSync(arq)) {
      const j = JSON.parse(fsq.readFileSync(arq, "utf-8"))
      j.lastSoloAt = new Date().toISOString()
      j.totalSoloAttempts = (j.totalSoloAttempts || 0) + 1
      fsq.writeFileSync(arq, JSON.stringify(j, null, 2))
    }
  } catch (e) {
    // Marcar o quiz e conveniencia de relatorio; se falhar, a tentativa em si
    // (que esta no banco, logo abaixo) nao pode ser perdida por causa disso.
  }

  db().exec("BEGIN")
  try {
    insSession.run(sessionId, input.quizId, quizTitle, input.startedAt || now, now, weekIso, monthIso)
    insSP.run(sessionId, playerId, points, correct, incorrect, unanswered, xpGained, JSON.stringify(respostasDetalhadas))
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

/* ────────────────────────────── REVISAO ────────────────────────────── */

export type PoliticaRevisao = "never" | "after_attempts" | "always"

/**
 * Politica de revisao de um quiz.
 *
 * O padrao e `after_attempts` de proposito. Mostrar o gabarito durante as
 * tentativas transforma a revisao em folha de respostas — a pessoa erra,
 * confere e refaz acertando, e o numero deixa de dizer o que ela sabe.
 * Esgotadas as tentativas isso nao existe mais, e ai a revisao so ensina.
 * Quem quiser outro comportamento escolhe no editor do quiz.
 */
export function politicaRevisao(quiz: any): PoliticaRevisao {
  const v = String(quiz?.solo?.review || "").trim()
  return v === "never" || v === "always" ? v : "after_attempts"
}

export interface ItemRevisao {
  questionIndex: number
  questionTitle: string
  selectedAnswer: string
  isCorrect: boolean
  options?: string[]
  correctAnswer?: string
}

export type RevisaoResponse =
  | {
      ok: true
      quizId: string
      quizTitle: string
      startedAt: string
      points: number
      correct: number
      incorrect: number
      unanswered: number
      /** Se o gabarito veio junto. A tela precisa saber para explicar por que nao. */
      showsKey: boolean
      policy: PoliticaRevisao
      attemptsUsed: number
      maxAttempts: number
      items: ItemRevisao[]
    }
  | { ok: false; reason: "not_found" | "not_yours" | "no_detail" }

/**
 * Revisao de UMA tentativa solo, para o proprio jogador.
 *
 * Chaveada por sessao e conferida contra o dono: o cliente manda um id, e sem a
 * conferencia qualquer pessoa leria a tentativa de qualquer outra trocando o
 * numero. O gabarito so viaja quando a politica do quiz permite — filtrar na
 * TELA nao serviria, porque o dado ja teria saido do servidor.
 */
export function getSoloReview(sessionId: string, realName: string): RevisaoResponse {
  if (!sessionId || !realName?.trim()) return { ok: false, reason: "not_found" }

  const playerId = findPlayerIdByName(realName.trim())
  if (!playerId) return { ok: false, reason: "not_yours" }

  const row = db()
    .prepare(
      `SELECT s.quiz_id AS quizId, s.quiz_title AS quizTitle, s.started_at AS startedAt,
              sp.player_id AS playerId, sp.points AS points, sp.correct AS correct,
              sp.incorrect AS incorrect, sp.unanswered AS unanswered,
              sp.answers_json AS answersJson
         FROM sessions s
         JOIN session_players sp ON sp.session_id = s.id
        WHERE s.id = ? AND s.mode = 'solo'`
    )
    .get(sessionId) as any

  if (!row) return { ok: false, reason: "not_found" }
  if (row.playerId !== playerId) return { ok: false, reason: "not_yours" }

  let bruto: any[] = []
  try { bruto = JSON.parse(row.answersJson || "[]") } catch { bruto = [] }
  if (!Array.isArray(bruto) || !bruto.length) return { ok: false, reason: "no_detail" }

  const quiz = loadQuiz(row.quizId)
  const politica = politicaRevisao(quiz)
  const maxAttempts = Number(quiz?.solo?.maxAttempts) > 0 ? Number(quiz.solo.maxAttempts) : DEFAULT_MAX_ATTEMPTS
  const attemptsUsed = countAttempts(playerId, row.quizId)

  const mostraGabarito =
    politica === "always" || (politica === "after_attempts" && attemptsUsed >= maxAttempts)

  const items: ItemRevisao[] = bruto.map((a: any, i: number) => {
    const base: ItemRevisao = {
      questionIndex: typeof a.questionIndex === "number" ? a.questionIndex : i,
      questionTitle: String(a.questionTitle ?? ""),
      selectedAnswer: String(a.selectedAnswer ?? ""),
      isCorrect: !!a.isCorrect,
    }
    if (!mostraGabarito) return base
    // Tentativas anteriores a v1.44 nao guardaram o gabarito. Em vez de mentir
    // ou de sumir com a linha, cai para o quiz atual — que pode ter mudado,
    // entao so vale quando a pergunta ainda bate exatamente.
    if (a.correctAnswer || Array.isArray(a.options)) {
      return { ...base, options: a.options, correctAnswer: a.correctAnswer }
    }
    const q = Array.isArray(quiz?.questions) ? quiz.questions[base.questionIndex] : null
    if (q && String(q.question) === base.questionTitle && Array.isArray(q.answers)) {
      const correctIndexes = Array.isArray(q.solution) ? q.solution : [q.solution]
      return {
        ...base,
        options: q.answers,
        correctAnswer: correctIndexes
          .map((index: number) => q.answers[index] ?? String(index))
          .join(", "),
      }
    }
    return base
  })

  return {
    ok: true,
    quizId: row.quizId,
    quizTitle: row.quizTitle,
    startedAt: row.startedAt,
    points: row.points,
    correct: row.correct,
    incorrect: row.incorrect,
    unanswered: row.unanswered,
    showsKey: mostraGabarito,
    policy: politica,
    attemptsUsed,
    maxAttempts,
    items,
  }
}

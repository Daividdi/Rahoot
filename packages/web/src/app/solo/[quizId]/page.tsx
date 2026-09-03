"use client"

import Button from "@rahoot/web/components/Button"
import Input from "@rahoot/web/components/Input"
import TierBadge from "@rahoot/web/components/profile/TierBadge"
import AnswerButton from "@rahoot/web/components/AnswerButton"
import { useSocket } from "@rahoot/web/contexts/socketProvider"
import {
  ANSWERS_COLORS,
  ANSWERS_ICONS,
  SFX_ANSWERS_MUSIC,
  SFX_ANSWERS_SOUND,
  SFX_RESULTS_SOUND,
  SFX_SHOW_SOUND,
} from "@rahoot/web/utils/constants"
import { useParams, useSearchParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { motion, AnimatePresence } from "motion/react"
import useSound from "use-sound"
import clsx from "clsx"
import {
  answerIndexes,
  answerSelectionText,
  isAnswerSelectionCorrect,
  type AnswerSelection,
} from "@rahoot/web/utils/soloAnswers"

const REAL_NAME_KEY = "rahoot_v2_name"
const KEEP_KEY = "rahoot_keep_logged"

type SoloQuestion = {
  question: string
  answers: string[]
  answerImages?: string[] | null
  solution: AnswerSelection
  time: number
  cooldown: number
  image?: string
}

type SoloQuiz = {
  id: string
  subject: string
  questions: SoloQuestion[]
}

type SoloQuizResp =
  | { ok: true; quiz: SoloQuiz; attemptsUsed: number; maxAttempts: number }
  | {
      ok: false
      reason:
        | "not_found"
        | "no_attempts_left"
        | "solo_disabled"
        | "server_error"
      attemptsUsed?: number
      maxAttempts?: number
    }

type SoloResultResp =
  | {
      ok: true
      attemptNumber: number
      maxAttempts: number
      xpGained: number
      newXp: number
      newLevel: number
      newTier: "bronze" | "silver" | "gold" | "platinum" | "mythic"
      newBadges: Array<{
        id: string
        label: string
        emoji: string
        description: string
      }>
      correct: number
      incorrect: number
      unanswered: number
      longestStreak: number
      isPerfect: boolean
    }
  | { ok: false; reason: string }

function scoreFor(
  correct: boolean,
  msToAnswer: number,
  questionDurationMs: number,
): number {
  if (!correct) return 0
  const factor = Math.max(
    0,
    1 - msToAnswer / Math.max(1000, questionDurationMs),
  )
  return Math.round(500 + 500 * factor)
}

// ── Streak helpers ───────────────────────────────────────────────────────────
const getStreak = (): number => {
  try {
    return parseInt(sessionStorage.getItem("rahoot_solo_streak") || "0")
  } catch {
    return 0
  }
}
const saveStreak = (n: number) => {
  try {
    sessionStorage.setItem("rahoot_solo_streak", String(n))
  } catch {}
}
const STREAK_MSGS: Record<number, string> = {
  2: "2 in a row! On fire!",
  3: "3 in a row! Hat-trick!",
  4: "4 streak! Unstoppable!",
  5: "LEGENDARY 5-streak!",
}
const getStreakMsg = (s: number): string | null =>
  s >= 5 ? STREAK_MSGS[5] : (STREAK_MSGS[s] ?? null)

// ── StreakBadge ──────────────────────────────────────────────────────────────
function StreakBadge({ streak }: { streak: number }) {
  if (streak < 2) return null
  const icon =
    streak >= 5 ? "🏆" : streak >= 4 ? "💥" : streak >= 3 ? "🎯" : "🔥"
  const color =
    streak >= 5
      ? "bg-purple-500"
      : streak >= 4
        ? "bg-orange-500"
        : streak >= 3
          ? "bg-red-500"
          : "bg-orange-400"
  return (
    <motion.div
      initial={{ scale: 0, rotate: -20 }}
      animate={{ scale: 1, rotate: 0 }}
      transition={{ type: "spring", stiffness: 500, damping: 18, delay: 0.55 }}
      className={clsx(
        "flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-black text-white shadow-lg",
        color,
      )}
    >
      <span className="text-base">{icon}</span>
      <span>{streak} streak!</span>
    </motion.div>
  )
}

export default function SoloGamePage() {
  const { socket, isConnected, connect } = useSocket()
  const params = useParams<{ quizId: string }>()
  const searchParams = useSearchParams()
  const quizId = params?.quizId ? decodeURIComponent(params.quizId) : ""

  // ── Auth ──────────────────────────────────────────────────────────────────
  const [realName, setRealName] = useState<string>("")
  const [needName, setNeedName] = useState(false)
  const [ldapUser, setLdapUser] = useState("")
  const [ldapPass, setLdapPass] = useState("")
  const [keepLoggedIn, setKeepLoggedIn] = useState(false)
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState("")

  // ── Quiz state ────────────────────────────────────────────────────────────
  const [resp, setResp] = useState<SoloQuizResp | null>(null)
  const [stage, setStage] = useState<
    "loading" | "ready" | "playing" | "done" | "error"
  >("loading")
  const [error, setError] = useState<string>("")

  // ── Play state ────────────────────────────────────────────────────────────
  const [qIndex, setQIndex] = useState(0)
  const [playPhase, setPlayPhase] = useState<"cooldown" | "answers" | "result">(
    "cooldown",
  )
  const [selected, setSelected] = useState<AnswerSelection | null>(null)
  const [selectedAnswers, setSelectedAnswers] = useState<number[]>([])
  const [timeLeft, setTimeLeft] = useState(0)
  const [lastCorrect, setLastCorrect] = useState(false)
  const [lastPoints, setLastPoints] = useState(0)
  const [streak, setStreak] = useState(0)
  const [displayPoints, setDisplayPoints] = useState(0)
  const [answers, setAnswers] = useState<
    Array<{ questionTitle: string; selectedAnswer: string; isCorrect: boolean }>
  >([])
  const [points, setPoints] = useState(0)

  const questionStartRef = useRef<number>(0)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [result, setResult] = useState<SoloResultResp | null>(null)

  const quiz = resp?.ok ? resp.quiz : null
  const question = quiz?.questions[qIndex]
  const totalQuestions = quiz?.questions.length ?? 0

  // ── Sounds ────────────────────────────────────────────────────────────────
  const [sfxShow] = useSound(SFX_SHOW_SOUND, { volume: 0.5 })
  const [sfxPop] = useSound(SFX_ANSWERS_SOUND, { volume: 0.1 })
  const [playMusic, { stop: stopMusic }] = useSound(SFX_ANSWERS_MUSIC, {
    volume: 0.2,
    interrupt: true,
    loop: true,
  })
  const [sfxResults] = useSound(SFX_RESULTS_SOUND, { volume: 0.2 })

  // ── Connect + load name ───────────────────────────────────────────────────
  useEffect(() => {
    if (!isConnected) connect()
  }, [isConnected, connect])

  useEffect(() => {
    try {
      const urlName = (
        searchParams.get("u") ||
        searchParams.get("name") ||
        ""
      ).trim()
      if (urlName) {
        setRealName(urlName)
        return
      }
      const session = sessionStorage.getItem(REAL_NAME_KEY)
      if (session) {
        setRealName(session)
        return
      }
      if (localStorage.getItem(KEEP_KEY) === "1") {
        const local = localStorage.getItem(REAL_NAME_KEY)
        if (local) {
          setRealName(local)
          return
        }
      }
      setNeedName(true)
    } catch {
      setNeedName(true)
    }
  }, [searchParams])

  // ── Fetch quiz ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket || !isConnected || !quizId || !realName || needName) return
    setStage("loading")
    ;(socket as any).emit("solo:getQuiz", { quizId, realName })
    const handler = (data: SoloQuizResp) => {
      setResp(data)
      if (!data.ok) {
        setStage("error")
        setError(
          data.reason === "not_found"
            ? "Quiz not found."
            : data.reason === "no_attempts_left"
              ? "You've already used all attempts for this quiz."
              : data.reason === "solo_disabled"
                ? "This quiz does not allow solo mode."
                : "Error loading quiz.",
        )
      } else {
        setStage("ready")
      }
    }
    ;(socket as any).on("solo:quiz", handler)
    return () => {
      ;(socket as any).off("solo:quiz", handler)
    }
  }, [socket, isConnected, quizId, realName, needName])

  // ── Result listener ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return
    const handler = (data: SoloResultResp) => {
      setResult(data)
      setStage("done")
    }
    ;(socket as any).on("solo:result", handler)
    return () => {
      ;(socket as any).off("solo:result", handler)
    }
  }, [socket])

  // ── Cooldown phase ────────────────────────────────────────────────────────
  useEffect(() => {
    if (stage !== "playing" || playPhase !== "cooldown" || !question) return
    sfxShow()
    const cd = Math.max(0, question.cooldown)
    if (cd === 0) {
      setPlayPhase("answers")
      return
    }
    const t = setTimeout(() => setPlayPhase("answers"), cd * 1000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, playPhase, qIndex])

  // ── Answer phase timer ────────────────────────────────────────────────────
  useEffect(() => {
    if (stage !== "playing" || playPhase !== "answers" || !question) return
    playMusic()
    questionStartRef.current = Date.now()
    setTimeLeft(question.time)
    tickRef.current = setInterval(() => {
      setTimeLeft((r) => {
        if (r <= 1) {
          if (tickRef.current) {
            clearInterval(tickRef.current)
            tickRef.current = null
          }
          handleAnswer(null)
          return 0
        }
        return r - 1
      })
    }, 1000)
    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current)
        tickRef.current = null
      }
      stopMusic()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, playPhase, qIndex])

  // ── Points count-up (result phase) ───────────────────────────────────────
  useEffect(() => {
    if (playPhase !== "result" || !lastCorrect || !lastPoints) return
    let current = 0
    const step = Math.max(1, Math.ceil(lastPoints / 24))
    const timer = setInterval(() => {
      current = Math.min(current + step, lastPoints)
      setDisplayPoints(current)
      if (current >= lastPoints) clearInterval(timer)
    }, 35)
    return () => clearInterval(timer)
  }, [playPhase, lastCorrect, lastPoints])

  const handleAnswer = useCallback(
    (chosen: AnswerSelection | null) => {
      if (!question || !quiz) return
      if (tickRef.current) {
        clearInterval(tickRef.current)
        tickRef.current = null
      }
      stopMusic()
      const ms = Date.now() - questionStartRef.current
      const isCorrect = isAnswerSelectionCorrect(chosen, question.solution)
      const selectedText = answerSelectionText(question.answers, chosen)
      const gained = scoreFor(isCorrect, ms, question.time * 1000)

      const prev = getStreak()
      const next = isCorrect ? prev + 1 : 0
      saveStreak(next)

      setSelected(chosen)
      setSelectedAnswers([])
      setLastCorrect(isCorrect)
      setLastPoints(gained)
      setDisplayPoints(0)
      setStreak(next)
      setAnswers((prev) => [
        ...prev,
        {
          questionTitle: question.question,
          selectedAnswer: selectedText,
          isCorrect,
        },
      ])
      setPoints((p) => p + gained)
      setPlayPhase("result")
      sfxPop()
      sfxResults()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [question, quiz],
  )

  const toggleAnswer = (answerKey: number) => {
    if (
      !question ||
      !Array.isArray(question.solution) ||
      playPhase !== "answers"
    )
      return
    sfxPop()
    setSelectedAnswers((previous) =>
      previous.includes(answerKey)
        ? previous.filter((key) => key !== answerKey)
        : [...previous, answerKey],
    )
  }

  const confirmMultipleAnswer = () => {
    if (selectedAnswers.length === 0) return
    handleAnswer(selectedAnswers)
  }

  const advanceFromResult = () => {
    if (!question || !quiz || playPhase !== "result") return

    const nextIndex = qIndex + 1
    if (nextIndex >= totalQuestions) {
      const payload = {
        quizId: quiz.id,
        realName,
        username: realName,
        startedAt: new Date().toISOString(),
        answers,
        points,
      }
      ;(socket as any)?.emit("solo:submit", payload)
      setStage("loading")
      return
    }

    setQIndex(nextIndex)
    setSelected(null)
    setSelectedAnswers([])
    setPlayPhase("cooldown")
  }

  const handleStart = () => {
    setQIndex(0)
    setSelected(null)
    setSelectedAnswers([])
    setAnswers([])
    setPoints(0)
    setPlayPhase("cooldown")
    saveStreak(0)
    setStage("playing")
  }

  // ── LDAP login ────────────────────────────────────────────────────────────
  if (needName) {
    const handleLdapAuth = () => {
      if (!ldapUser.trim() || !ldapPass.trim()) return
      if (!socket || !isConnected) {
        setAuthError("Not connected — please wait and try again.")
        return
      }
      setAuthLoading(true)
      setAuthError("")
      ;(socket as any)
        .timeout(12000)
        .emit(
          "player:ldapAuth",
          { username: ldapUser.trim(), password: ldapPass },
          (err: any, res: any) => {
            setAuthLoading(false)
            if (err) {
              setAuthError("Request timed out. Check your connection.")
              return
            }
            if (res?.ok) {
              try {
                sessionStorage.setItem(REAL_NAME_KEY, res.fullName)
                if (keepLoggedIn) {
                  localStorage.setItem(REAL_NAME_KEY, res.fullName)
                  localStorage.setItem(KEEP_KEY, "1")
                } else {
                  localStorage.removeItem(REAL_NAME_KEY)
                  localStorage.removeItem(KEEP_KEY)
                }
              } catch {}
              setRealName(res.fullName)
              setNeedName(false)
            } else {
              setAuthError(res?.error || "Authentication failed")
              setLdapPass("")
            }
          },
        )
    }
    const onEnter = (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleLdapAuth()
    }
    return (
      <Shell>
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-lg font-bold text-gray-800">Sign in</h2>
            <p className="text-sm text-gray-400">
              Use your network credentials to continue.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Input
              value={ldapUser}
              onChange={(e) => setLdapUser(e.target.value)}
              onKeyDown={onEnter}
              placeholder="Username"
              maxLength={40}
              autoFocus
              disabled={authLoading}
            />
            <input
              type="password"
              value={ldapPass}
              onChange={(e) => setLdapPass(e.target.value)}
              onKeyDown={onEnter}
              placeholder="Password"
              maxLength={80}
              disabled={authLoading}
              className="focus:border-primary focus:ring-primary/20 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 outline-none focus:ring-2 disabled:opacity-50"
            />
            <label className="flex cursor-pointer items-center gap-2 select-none">
              <input
                type="checkbox"
                checked={keepLoggedIn}
                onChange={(e) => setKeepLoggedIn(e.target.checked)}
                disabled={authLoading}
                className="accent-primary h-4 w-4 rounded border-gray-300"
              />
              <span className="text-xs text-gray-500">Keep me signed in</span>
            </label>
          </div>
          {authError && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600">
              {authError}
            </p>
          )}
          <Button onClick={handleLdapAuth} disabled={authLoading}>
            {authLoading ? "Signing in…" : "Continue"}
          </Button>
        </div>
      </Shell>
    )
  }

  if (stage === "loading" || !isConnected) {
    return (
      <Shell>
        <div className="py-8 text-center text-sm text-gray-400">Loading…</div>
      </Shell>
    )
  }

  if (stage === "error") {
    // A single line of red text on an empty card reads as "the page did not
    // load". Say what happened, and for the common case say how to fix it.
    const failed = resp && !resp.ok ? resp : null
    const used = failed?.attemptsUsed
    const max = failed?.maxAttempts
    const reason = failed?.reason

    const title =
      reason === "no_attempts_left"
        ? "No attempts left"
        : reason === "not_found"
          ? "Quiz not found"
          : reason === "solo_disabled"
            ? "Solo mode is off for this quiz"
            : "Could not load this quiz"

    const detail =
      reason === "no_attempts_left"
        ? "Attempts are counted per person, per quiz. The link itself is still valid and does not expire \u2014 ask an administrator to raise the limit for this quiz if you need another go."
        : reason === "not_found"
          ? "This quiz is no longer on the server. The link may be from an older quiz that has since been removed."
          : reason === "solo_disabled"
            ? "This quiz was set up for live sessions only."
            : error

    return (
      <Shell>
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-primary text-[10px] font-bold tracking-widest uppercase">
              Solo Mode
            </p>
            <h2 className="text-lg font-bold text-gray-800">{title}</h2>
          </div>
          {reason === "no_attempts_left" &&
            typeof used === "number" &&
            typeof max === "number" && (
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Attempts used" value={`${used}/${max}`} />
                <Stat label="Remaining" value="0" />
              </div>
            )}
          <p className="text-[11px] text-gray-500">{detail}</p>
          <Button
            onClick={() => {
              window.location.href = "/"
            }}
          >
            Back to home
          </Button>
        </div>
      </Shell>
    )
  }

  if (stage === "ready" && resp?.ok) {
    const attemptsLeft = resp.maxAttempts - resp.attemptsUsed
    return (
      <Shell>
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-primary text-[10px] font-bold tracking-widest uppercase">
              Solo Mode
            </p>
            <h2 className="text-lg font-bold text-gray-800">
              {resp.quiz.subject}
            </h2>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Questions" value={resp.quiz.questions.length} />
            <Stat
              label="Time"
              value={`${resp.quiz.questions.reduce((s, q) => s + q.time, 0)}s`}
            />
            <Stat
              label="Attempts"
              value={`${attemptsLeft}/${resp.maxAttempts}`}
              highlight={attemptsLeft > 0}
            />
          </div>
          <p className="text-[11px] text-gray-500">
            You have <span className="font-bold">{attemptsLeft}</span>{" "}
            {attemptsLeft === 1 ? "attempt" : "attempts"} remaining for this
            quiz. Results count toward XP and achievements, but not the weekly
            ranking.
          </p>
          <Button onClick={handleStart}>Start</Button>
        </div>
      </Shell>
    )
  }

  // ── Playing: cooldown phase ───────────────────────────────────────────────
  if (stage === "playing" && quiz && question && playPhase === "cooldown") {
    return (
      <GameShell>
        <div className="relative mx-auto flex h-full w-full max-w-7xl flex-1 flex-col items-center px-4">
          <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="bg-accent h-full rounded-full"
              style={{
                animation: `progressBar ${question.cooldown || 0.5}s linear forwards`,
              }}
            />
          </div>
          <div className="flex flex-1 flex-col items-center justify-center gap-5">
            <p className="text-xs font-bold tracking-widest text-white/40 uppercase">
              Question {qIndex + 1} / {totalQuestions}
            </p>
            <h2 className="text-center text-3xl font-bold [text-wrap:balance] text-white drop-shadow-lg md:text-4xl">
              {question.question}
            </h2>
            {question.image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={question.image}
                alt=""
                className="max-h-52 w-auto rounded-xl shadow-2xl sm:max-h-80"
              />
            )}
          </div>
        </div>
      </GameShell>
    )
  }

  // ── Playing: answers phase ────────────────────────────────────────────────
  if (stage === "playing" && quiz && question && playPhase === "answers") {
    const timePercent = Math.round((timeLeft / question.time) * 100)
    const timeColor =
      timePercent > 50 ? "#4ade80" : timePercent > 25 ? "#fbbf24" : "#f87171"
    const timeBg =
      timePercent > 50
        ? "bg-green-400"
        : timePercent > 25
          ? "bg-amber-400"
          : "bg-red-400"
    const hasAnyAnswerImage =
      question.answerImages && question.answerImages.some(Boolean)
    const isMultipleQuestion = Array.isArray(question.solution)

    return (
      <GameShell>
        <div className="flex h-full flex-1 flex-col justify-between">
          <div className="mx-auto inline-flex h-full w-full max-w-7xl flex-1 flex-col items-center justify-center gap-4 px-4">
            <p className="text-xs font-bold tracking-widest text-white/40 uppercase">
              Question {qIndex + 1} / {totalQuestions}
            </p>
            <h2 className="text-center text-2xl font-bold [text-wrap:balance] text-white drop-shadow-lg md:text-4xl">
              {question.question}
            </h2>
            {question.image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                alt={question.question}
                src={question.image}
                className={clsx(
                  "mb-2 w-auto rounded-xl px-4 shadow-xl",
                  hasAnyAnswerImage ? "max-h-32" : "max-h-52 sm:max-h-80",
                )}
              />
            )}
          </div>

          <div className="pb-2">
            {/* Stats bar */}
            <div className="mx-auto mb-3 flex w-full max-w-7xl items-center justify-between gap-3 px-4">
              <div className="flex items-center gap-2 rounded-2xl bg-black/50 px-5 py-2.5 shadow-md backdrop-blur-sm">
                <div className="relative flex h-8 w-8 items-center justify-center">
                  <svg
                    className="absolute inset-0 -rotate-90"
                    viewBox="0 0 32 32"
                    fill="none"
                  >
                    <circle
                      cx="16"
                      cy="16"
                      r="14"
                      stroke="rgba(255,255,255,0.15)"
                      strokeWidth="3"
                    />
                    <circle
                      cx="16"
                      cy="16"
                      r="14"
                      stroke={timeColor}
                      strokeWidth="3"
                      strokeDasharray={`${2 * Math.PI * 14}`}
                      strokeDashoffset={`${2 * Math.PI * 14 * (1 - timePercent / 100)}`}
                      strokeLinecap="round"
                      style={{
                        transition: "stroke-dashoffset 1s linear, stroke 0.5s",
                      }}
                    />
                  </svg>
                  <span className="relative text-xs font-black text-white tabular-nums">
                    {timeLeft}
                  </span>
                </div>
                <span className="text-xs font-semibold tracking-wide text-white/60 uppercase">
                  Time
                </span>
              </div>

              <div className="flex items-center gap-2 rounded-2xl bg-black/50 px-5 py-2.5 shadow-md backdrop-blur-sm">
                <span className="text-xs font-semibold tracking-wide text-white/60 uppercase">
                  Points
                </span>
                <span className="text-lg font-black text-white tabular-nums">
                  {points}
                </span>
              </div>
            </div>

            <div className="mx-auto mb-3 h-1.5 w-full max-w-7xl overflow-hidden rounded-full bg-white/10 px-4">
              <div
                className={clsx(
                  "h-full rounded-full transition-all duration-1000",
                  timeBg,
                )}
                style={{ width: `${timePercent}%` }}
              />
            </div>

            {/* Answer buttons */}
            {isMultipleQuestion && (
              <p className="mb-2 text-center text-xs font-semibold tracking-widest text-white/50 uppercase">
                Select all that apply
              </p>
            )}

            <div className="mx-auto mb-3 grid w-full max-w-7xl grid-cols-2 gap-3 px-3">
              {question.answers.map((answer, i) => {
                const img = question.answerImages?.[i]
                const isSelected =
                  isMultipleQuestion && selectedAnswers.includes(i)
                return (
                  <AnswerButton
                    key={i}
                    className={clsx(
                      ANSWERS_COLORS[i],
                      img && "!items-start !py-3",
                      isSelected && "ring-4 ring-white/70 brightness-110",
                    )}
                    icon={ANSWERS_ICONS[i]}
                    onClick={() =>
                      isMultipleQuestion ? toggleAnswer(i) : handleAnswer(i)
                    }
                  >
                    <span className="flex w-full flex-col items-start gap-1.5">
                      {img && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={img}
                          alt=""
                          className="w-full rounded-xl border-2 border-white/30 object-contain shadow-lg"
                          style={{ maxHeight: "120px" }}
                        />
                      )}
                      {answer && <span>{answer}</span>}
                    </span>
                  </AnswerButton>
                )
              })}
            </div>

            {isMultipleQuestion && (
              <div className="mx-auto flex w-full max-w-7xl justify-center px-3">
                <Button
                  onClick={confirmMultipleAnswer}
                  disabled={selectedAnswers.length === 0}
                  variant="ghost"
                  className={clsx(
                    "min-w-44",
                    selectedAnswers.length === 0 &&
                      "cursor-not-allowed opacity-40",
                  )}
                >
                  {selectedAnswers.length === 0
                    ? "Select answers"
                    : `Confirm (${selectedAnswers.length} selected)`}
                </Button>
              </div>
            )}
          </div>
        </div>
      </GameShell>
    )
  }

  // ── Playing: result phase ─────────────────────────────────────────────────
  if (stage === "playing" && quiz && question && playPhase === "result") {
    const headline = lastCorrect
      ? "Correct!"
      : selected === null
        ? "Time up!"
        : "Wrong!"
    const streakMsg = lastCorrect ? getStreakMsg(streak) : null
    const correctAnswerIndexes = answerIndexes(question.solution)

    return (
      <GameShell>
        <section className="relative mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-5 px-6">
          {/* Result icon */}
          <motion.div
            initial={{ scale: 0, rotate: -25 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 350, damping: 18 }}
            className={clsx(
              "flex h-28 w-28 items-center justify-center rounded-full shadow-2xl ring-4",
              lastCorrect
                ? "bg-green-500/20 ring-green-400/40"
                : "bg-red-500/20 ring-red-400/40",
            )}
          >
            {lastCorrect ? (
              <svg
                viewBox="0 0 56 56"
                className="h-16 w-16 fill-green-400 drop-shadow-lg"
              >
                <path d="M28 52C41.255 52 52 41.255 52 28C52 14.745 41.255 4 28 4C14.745 4 4 14.745 4 28C4 41.255 14.745 52 28 52ZM24.766 40.023C23.969 40.023 23.359 39.672 22.68 38.875L15.93 30.531C15.578 30.086 15.367 29.523 15.367 29.008C15.367 27.906 16.234 27.063 17.266 27.063C17.945 27.063 18.508 27.32 19.07 28.047L24.672 35.289L35.570 17.828C36.016 17.102 36.625 16.75 37.234 16.75C38.266 16.75 39.273 17.43 39.273 18.555C39.273 19.07 38.969 19.633 38.664 20.102L26.758 38.875C26.242 39.648 25.586 40.023 24.766 40.023Z" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 56 56"
                className="h-16 w-16 fill-red-400 drop-shadow-lg"
              >
                <path d="M28 52C41.255 52 52 41.255 52 28C52 14.745 41.255 4 28 4C14.745 4 4 14.745 4 28C4 41.255 14.745 52 28 52ZM19.586 38.406C18.484 38.406 17.594 37.516 17.594 36.414C17.594 35.875 17.828 35.406 18.203 35.055L25.188 28.023L18.203 20.992C17.828 20.664 17.594 20.172 17.594 19.633C17.594 18.555 18.484 17.688 19.586 17.688C20.125 17.688 20.594 17.898 20.945 18.273L27.977 25.281L35.055 18.25C35.453 17.828 35.875 17.641 36.391 17.641C37.492 17.641 38.383 18.531 38.383 19.609C38.383 20.148 38.195 20.594 37.797 20.969L30.766 28.023L37.773 35.008C38.125 35.383 38.359 35.852 38.359 36.414C38.359 37.516 37.469 38.406 36.367 38.406C35.805 38.406 35.336 38.172 34.984 37.820L27.977 30.789L20.992 37.820C20.641 38.195 20.125 38.406 19.586 38.406Z" />
              </svg>
            )}
          </motion.div>

          {/* Headline + streak */}
          <div className="flex flex-col items-center gap-2">
            <motion.h2
              initial={{ opacity: 0, y: 18, scale: 0.88 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{
                type: "spring",
                stiffness: 300,
                damping: 20,
                delay: 0.15,
              }}
              className={clsx(
                "text-center text-4xl font-black drop-shadow-lg",
                lastCorrect ? "text-white" : "text-white/80",
              )}
            >
              {headline}
            </motion.h2>
            {streakMsg && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.28 }}
                className="text-base font-semibold text-white/60"
              >
                {streakMsg}
              </motion.p>
            )}
            <StreakBadge streak={streak} />
          </div>

          {/* Points badge */}
          <AnimatePresence>
            {lastCorrect && (
              <motion.div
                initial={{ scale: 0, y: 12 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0 }}
                transition={{
                  type: "spring",
                  stiffness: 420,
                  damping: 16,
                  delay: 0.38,
                }}
                className="bg-accent flex items-baseline gap-1.5 rounded-2xl px-8 py-3 shadow-xl"
              >
                <span className="text-4xl font-black text-gray-900 tabular-nums">
                  +{displayPoints}
                </span>
                <span className="text-base font-bold text-gray-700">pts</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Correct answer reveal when wrong */}
          <AnimatePresence>
            {!lastCorrect && (
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ delay: 0.4 }}
                className="w-full"
              >
                <p className="mb-2 text-center text-xs font-semibold tracking-widest text-white/40 uppercase">
                  Correct answer
                </p>
                <div className="flex flex-col items-center gap-2 rounded-xl border border-green-400/30 bg-green-500/15 px-4 py-4 text-center backdrop-blur-sm">
                  {correctAnswerIndexes.map((answerIndex) => (
                    <div
                      key={answerIndex}
                      className="flex flex-col items-center gap-2"
                    >
                      {question.answerImages?.[answerIndex] && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={question.answerImages[answerIndex]!}
                          alt=""
                          className="max-h-28 w-auto rounded-lg border border-white/20 object-contain"
                        />
                      )}
                      {question.answers[answerIndex] && (
                        <p className="text-lg font-bold text-green-300">
                          {question.answers[answerIndex]}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Progress */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            className="flex flex-col items-center gap-3 text-xs font-semibold text-white/30"
          >
            <Button
              onClick={advanceFromResult}
              variant="accent"
              className="min-w-44"
            >
              {qIndex + 1 < totalQuestions ? "Next" : "Finish"}
            </Button>
          </motion.div>
        </section>
      </GameShell>
    )
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  if (stage === "done" && result && "ok" in result && result.ok) {
    return (
      <Shell wide>
        <div className="flex flex-col items-center gap-4 text-center">
          <div>
            <p className="text-primary text-[11px] font-bold tracking-widest uppercase">
              Attempt {result.attemptNumber} of {result.maxAttempts}
            </p>
            <h2 className="text-xl font-bold text-gray-800">
              {result.isPerfect ? "🎯 Perfect score!" : "Quiz complete"}
            </h2>
          </div>

          <div className="grid w-full grid-cols-4 gap-2">
            <Stat label="Correct" value={result.correct} />
            <Stat label="Wrong" value={result.incorrect} />
            <Stat label="Streak" value={result.longestStreak} />
            <Stat label="+XP" value={result.xpGained} highlight />
          </div>

          <div className="w-full">
            <TierBadge
              tier={result.newTier}
              level={result.newLevel}
              size="md"
            />
          </div>

          {result.newBadges.length > 0 && (
            <div className="w-full rounded-xl bg-gradient-to-br from-amber-50 to-amber-100 p-3 ring-1 ring-amber-200">
              <p className="mb-2 text-[10px] font-bold tracking-widest text-amber-700 uppercase">
                New achievements
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {result.newBadges.map((b) => (
                  <div
                    key={b.id}
                    className="flex items-center gap-1.5 rounded-lg bg-white px-2 py-1 text-xs font-semibold shadow ring-1 ring-amber-200"
                  >
                    <span>{b.emoji}</span>
                    <span className="text-gray-700">{b.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex w-full gap-2">
            {result.attemptNumber < result.maxAttempts ? (
              <Button
                onClick={() => {
                  setResult(null)
                  setStage("ready")
                }}
                className="flex-1"
              >
                Try again
              </Button>
            ) : (
              <div className="flex-1 rounded-lg bg-gray-100 px-4 py-3 text-center text-xs font-semibold text-gray-500">
                No attempts left
              </div>
            )}
            <a
              href="/"
              className="hover:text-primary rounded-lg bg-white px-4 py-3 text-xs font-semibold text-gray-500 ring-1 ring-gray-200"
            >
              Back
            </a>
          </div>
        </div>
      </Shell>
    )
  }

  if (stage === "done" && result && !result.ok) {
    return (
      <Shell>
        <div className="py-8 text-center text-sm text-red-500">
          Error saving: {result.reason}
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="py-8 text-center text-sm text-gray-400">…</div>
    </Shell>
  )
}

// ── Shell: white card (login / ready / done) ─────────────────────────────────
function Shell({
  children,
  wide,
}: {
  children: React.ReactNode
  wide?: boolean
}) {
  return (
    <section className="bg-gradient-angel flex min-h-screen w-full flex-col items-center justify-start px-3 py-4 sm:justify-center sm:py-8">
      <div
        className={clsx(
          "card-3d z-10 flex w-full flex-col gap-4 rounded-2xl bg-white p-4 sm:p-5",
          wide ? "max-w-2xl" : "max-w-lg",
        )}
      >
        {children}
      </div>
    </section>
  )
}

// ── GameShell: dark full-screen (playing phases) ──────────────────────────────
function GameShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#1a1a2e]">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[#16213e] via-[#0f3460] to-[#533483] opacity-80" />
      <div className="relative z-10 flex flex-1 flex-col">{children}</div>
    </section>
  )
}

// ── Stat ──────────────────────────────────────────────────────────────────────
function Stat({
  label,
  value,
  highlight,
}: {
  label: string
  value: number | string
  highlight?: boolean
}) {
  return (
    <div
      className={clsx(
        "flex flex-col items-center rounded-xl px-2 py-2 ring-1",
        highlight ? "bg-primary/5 ring-primary/20" : "bg-gray-50 ring-gray-100",
      )}
    >
      <span className="text-base font-bold text-gray-800 tabular-nums">
        {value}
      </span>
      <span className="text-[9px] font-semibold tracking-wider text-gray-400 uppercase">
        {label}
      </span>
    </div>
  )
}

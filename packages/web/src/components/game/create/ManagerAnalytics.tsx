"use client"

import clsx from "clsx"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useSocket } from "@rahoot/web/contexts/socketProvider"
import SelectQuizz from "@rahoot/web/components/game/create/SelectQuizz"
import ManagerPlayers from "@rahoot/web/components/game/create/ManagerPlayers"
import Image from "next/image"
import logo from "@rahoot/web/assets/logo.svg"
import { APP_VERSION } from "@rahoot/web/version"

type Props = { quizzList: any[]; initialRegion?: "all" | "BR" | "MY" | "CN"; onSelect?: (_id: string) => void; onListChange?: (newList: any[]) => void }
type RFilter = "all" | "BR" | "MY" | "CN"
type PFilter = "all" | "month" | "week"
type NavView = "overview" | "players" | "leaderboard" | "participation" | "activity" | "quizzes" | "team" | "solo" | "combined" | "team_games" | "question_bank"

const EXCLUDED_PLAYERS = ["test user"]
const isExcluded = (name: string) => {
  const lower = name.toLowerCase().trim()
  return EXCLUDED_PLAYERS.some(ex => lower === ex || lower.includes(ex))
}

const downloadCsv = (filename: string, rows: Record<string, any>[]) => {
  if (!rows.length) return
  const headers = Object.keys(rows[0])
  const esc = (v: any) => { const s = String(v ?? ""); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const csv = [headers.join(","), ...rows.map(r => headers.map(h => esc(r[h])).join(","))].join("\n")
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

// Small accuracy-over-time line for expanded player rows
const TrendSparkline = ({ rows, label }: { rows?: any[]; label: string }) => {
  if (!rows) return <div className="flex h-10 items-center text-xs text-gray-300">Loading trend…</div>
  if (rows.length < 2) return <div className="flex h-10 items-center text-xs text-gray-300">Not enough sessions for a trend</div>
  const pts = rows.map(r => (r.total > 0 ? (100 * r.correct) / r.total : 0))
  const W = 220, H = 40, P = 4
  const xy = pts.map((v, i) => [P + (i * (W - 2 * P)) / (pts.length - 1), H - P - (v / 100) * (H - 2 * P)])
  const dPath = xy.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")
  const last = Math.round(pts[pts.length - 1])
  const delta = last - Math.round(pts[0])
  return (
    <div className="flex items-center gap-3 rounded-lg bg-white border border-gray-100 px-3 py-2">
      <svg width={W} height={H} className="shrink-0">
        <path d={dPath} fill="none" stroke="#009edf" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="3" fill="#009edf" />
      </svg>
      <div className="text-xs text-gray-500">
        <span className="font-bold text-gray-700">{last}%</span> latest
        <span className={clsx("ml-2 font-bold", delta >= 0 ? "text-green-600" : "text-red-500")}>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}pp</span>
        <span className="ml-1">vs first · {rows.length} {label}</span>
      </div>
    </div>
  )
}

const GROUP_COLORS: Record<string, { bg: string; text: string; bar: string; border: string }> = {
  ATP:    { bg: "bg-purple-50",  text: "text-purple-700", bar: "bg-purple-500",  border: "#7c3aed" },
  ATD:    { bg: "bg-orange-50",  text: "text-orange-700", bar: "bg-orange-500",  border: "#ea580c" },
  Others: { bg: "bg-gray-50",    text: "text-gray-600",   bar: "bg-gray-400",    border: "#6b7280" },
}

function safeGroup(quiz: any): string {
  const g = (quiz?.group || "").trim()
  if (g === "ATP" || g === "ATD") return g
  return "Others"
}

function safeRegion(quiz: any): "BR" | "MY" | "CN" {
  try {
    const r = (quiz?.region || "").toLowerCase()
    if (r.includes("my") || r.includes("malaysia")) return "MY"
    if (r.includes("cn") || r.includes("china")) return "CN"
    if (r.includes("br") || r.includes("brazil")) return "BR"
    const s = (quiz?.subject || "").toLowerCase()
    const c = (quiz?.createdBy || "").toLowerCase()
    if (["rule refresh", "my ", "malaysia"].some(k => s.includes(k)) ||
        ["grace", "elvina", "kt"].some(k => c.includes(k)) || s.includes("usa")) return "MY"
  } catch {}
  return "BR"
}

function safeCategory(quiz: any): string {
  try {
    if (quiz?.category) return quiz.category
    const s = (quiz?.subject || "").toLowerCase()
    if (s.includes("rule refresh")) return "Rule Refresh"
    if (s.includes("quality check") || s.includes("qc ") || s.includes("qc-")) return "Quality Check"
    if (s.includes("tooth") || s.includes("anatomy")) return "Tooth Anatomy"
    if (s.includes("ortodon")) return "Orthodontics"
    if (s.includes("weekly") || s.includes("review")) return "Weekly Review"
    if (s.includes("reinforce")) return "Reinforcement"
  } catch {}
  return "General"
}

function safeParseDate(d: string): Date | null {
  if (!d) return null
  try {
    const [datePart, timePart] = d.split(",").map(s => s.trim())
    const p = datePart.split("/")
    if (p.length !== 3) return null
    let day: number, month: number, year: number
    if (Number(p[2]) > 100) { day = Number(p[0]); month = Number(p[1]) - 1; year = Number(p[2]) }
    else { month = Number(p[0]) - 1; day = Number(p[1]); year = Number(p[2]) }
    const h = timePart ? Number(timePart.split(":")[0]) || 0 : 0
    const m = timePart ? Number(timePart.split(":")[1]) || 0 : 0
    return new Date(year, month, day, h, m)
  } catch { return null }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

const Tag = ({ region }: { region: string }) => (
  <span className={clsx("inline-flex rounded-md px-2 py-0.5 text-xs font-semibold",
    region === "BR" ? "bg-green-100 text-green-800" : region === "CN" ? "bg-red-100 text-red-800" : "bg-blue-100 text-blue-800")}>{region}</span>
)

const GroupTag = ({ group }: { group: string }) => {
  const c = GROUP_COLORS[group] || GROUP_COLORS.Others
  return (
    <span className={clsx("inline-flex rounded-md px-2.5 py-0.5 text-xs font-semibold", c.bg, c.text)}>{group}</span>
  )
}

const AccBadge = ({ v }: { v: number }) => (
  <span className={clsx("inline-flex rounded-md px-2 py-0.5 text-xs font-bold",
    v >= 70 ? "bg-green-100 text-green-800" : v >= 50 ? "bg-blue-100 text-blue-800" :
    v >= 35 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800")}>{v}%</span>
)

const AccRing = ({ v, size = 56 }: { v: number; size?: number }) => {
  const sw = size <= 36 ? 3 : size <= 48 ? 4 : 5
  const r = (size - sw * 2) / 2
  const circ = 2 * Math.PI * r
  const filled = (v / 100) * circ
  const color = v >= 65 ? "#22c55e" : v >= 50 ? "#009edf" : v >= 35 ? "#f59e0b" : "#ef4444"
  const fontSize = size <= 36 ? "8px" : size <= 44 ? "9px" : size <= 54 ? "10px" : "11px"
  return (
    <div className="relative shrink-0 flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)", position: "absolute" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f1f5f9" strokeWidth={sw} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={sw}
          strokeDasharray={`${filled} ${circ - filled}`} strokeLinecap="butt" />
      </svg>
      <span className="font-bold leading-none" style={{ color, fontSize, letterSpacing: "-0.02em" }}>{v}%</span>
    </div>
  )
}

const AccBar = ({ v }: { v: number }) => {
  const color = v >= 65 ? "#22c55e" : v >= 50 ? "#009edf" : v >= 35 ? "#f59e0b" : "#ef4444"
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-2 rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${v}%`, background: color }} />
      </div>
      <AccBadge v={v} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export default function ManagerAnalytics({ quizzList, initialRegion = "all", onSelect, onListChange }: Props) {
  const router = useRouter()
  const { socket } = useSocket()
  const [localList, setLocalList] = useState<any[]>(quizzList)
  useEffect(() => { setLocalList(quizzList) }, [quizzList])
  const handleListChange = useCallback((newList: any[]) => { setLocalList(newList); onListChange?.(newList) }, [onListChange])
  const [expandedSession, setExpandedSession] = useState<string | null>(null)
  const [localCancelled, setLocalCancelled] = useState<Record<string, number[]>>({})
  const [nameCorrections, setNameCorrections] = useState<Record<string, string>>({})

  type SoloQuizStat = { quiz_id: string; quiz_title: string; total_attempts: number; unique_players: number; avg_accuracy: number; best_score: number; last_played: string }
  type SoloPlayerStat = { real_name: string; total_attempts: number; quizzes_played: number; total_correct: number; total_wrong: number; avg_accuracy: number; best_points: number; last_played: string }
  type SoloDetail = { real_name: string; quiz_id: string; quiz_title: string; attempts: number; best_correct: number; best_points: number; best_accuracy: number; last_played: string }
  type TeamPlayerStat = { real_name: string; games_played: number; avg_rank: number; total_correct: number; total_wrong: number; avg_accuracy: number; best_points: number; last_played: string }
  type TeamQuizStat = { quiz_id: string; quiz_title: string; total_sessions: number; unique_players: number; avg_accuracy: number; best_score: number; last_played: string }
  type TeamDetail = { real_name: string; quiz_id: string; quiz_title: string; sessions: number; total_correct: number; best_points: number; avg_accuracy: number; best_rank: number; last_played: string }
  type SoloReport = { ok: true; quizStats: SoloQuizStat[]; playerStats: SoloPlayerStat[]; detail: SoloDetail[]; teamStats: TeamPlayerStat[]; teamQuizStats: TeamQuizStat[]; teamDetail: TeamDetail[] } | { ok: false; error: string }

  const [soloReport, setSoloReport] = useState<SoloReport | null>(null)
  const [soloLoading, setSoloLoading] = useState(false)
  const [soloExpandedPlayer, setSoloExpandedPlayer] = useState<string | null>(null)
  const [teamExpandedPlayer, setTeamExpandedPlayer] = useState<string | null>(null)
  type SortDir = "asc" | "desc"
  const [combinedSort, setCombinedSort] = useState<{ key: "name" | "solo_acc" | "team_acc" | "solo_games" | "team_games"; dir: SortDir }>({ key: "team_acc", dir: "desc" })
  const [combinedSearch, setCombinedSearch] = useState("")
  const [combinedMinGames, setCombinedMinGames] = useState(true)
  const [soloSearch, setSoloSearch] = useState("")
  const [soloSort, setSoloSort] = useState<{ key: "acc" | "attempts" | "quizzes" | "correct" | "points" | "name"; dir: SortDir }>({ key: "acc", dir: "desc" })
  const [teamSearch, setTeamSearch] = useState("")
  const [teamSort, setTeamSort] = useState<{ key: "acc" | "games" | "rank" | "correct" | "points" | "name"; dir: SortDir }>({ key: "acc", dir: "desc" })

  type DiffQuestion = { questionTitle: string; quizCount: number; timesAnswered: number; timesCorrect: number; timesWrong: number; errorRate: number; lastAnswered?: string | null }
  const [diffQuestions, setDiffQuestions] = useState<DiffQuestion[] | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffDays, setDiffDays] = useState<number>(30) // 0 = all time
  const [bankTitle, setBankTitle] = useState("Question Bank")
  const [bankSelected, setBankSelected] = useState<Set<string>>(new Set())
  const [bankSaving, setBankSaving] = useState(false)
  const [bankSaved, setBankSaved] = useState<string | null>(null)
  const [bankMinError, setBankMinError] = useState(0)
  const [showBelow50, setShowBelow50] = useState(false)

  useEffect(() => {
    if (!socket) return
    ;(socket as any).emit("manager:getPlayerNames", (data: Record<string, string>) => {
      setNameCorrections(data || {})
    })
  }, [socket])

  const fetchSoloReport = (range?: { from: string | null; to: string | null }) => {
    if (!socket) return
    setSoloLoading(true)
    ;(socket as any).timeout(15000).emit("manager:getSoloReport", { from: range?.from ?? null, to: range?.to ?? null }, (err: any, data: any) => {
      setSoloLoading(false)
      if (!err && data) setSoloReport(data)
    })
  }
  // (re)fetched whenever the period filter changes — see effect after periodRange

  const fetchDiffQuestions = (days?: number) => {
    if (!socket) return
    setDiffLoading(true)
    ;(socket as any).timeout(20000).emit("manager:getDifficultQuestions", { days: days ?? diffDays }, (err: any, data: any) => {
      setDiffLoading(false)
      if (!err && data?.ok) setDiffQuestions(data.questions)
    })
  }

  useEffect(() => {
    if (!socket) return
    fetchDiffQuestions(diffDays)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, diffDays])

  const saveBankQuiz = () => {
    if (!socket || bankSelected.size === 0) return
    setBankSaving(true)
    ;(socket as any).timeout(15000).emit("manager:saveQuestionBank",
      { title: bankTitle, questionTitles: Array.from(bankSelected) },
      (err: any, data: any) => {
        setBankSaving(false)
        if (!err && data?.ok) { setBankSaved(data.quizId); setBankSelected(new Set()) }
      }
    )
  }

  const applyName = (key: string, fallback: string) =>
    nameCorrections[key] || fallback

  useEffect(() => {
    setLocalCancelled(prev => {
      const next = { ...prev }
      ;(quizzList || []).forEach((q: any) => {
        next[q.id || ""] = Array.isArray(q.cancelledQuestions) ? q.cancelledQuestions : []
      })
      return next
    })
  }, [quizzList])

  const toggleCancelQuestion = (quizId: string, questionIndex: number) => {
    if (!socket) return
    setLocalCancelled(prev => {
      const curr = prev[quizId] || []
      const isCancelled = curr.includes(questionIndex)
      return { ...prev, [quizId]: isCancelled ? curr.filter(i => i !== questionIndex) : [...curr, questionIndex] }
    })
    ;(socket as any).emit("manager:toggleCancelledQuestion", { quizId, questionIndex })
  }

  const [activeView, setActiveView] = useState<NavView>("overview")
  const [rFilter, setRFilter] = useState<RFilter>(initialRegion as RFilter)
  const [pFilter, setPFilter] = useState<PFilter>("all")
  const [pOffset, setPOffset] = useState(0)
  const [aFilter, setAFilter] = useState("all")

  useEffect(() => { setRFilter(initialRegion as RFilter) }, [initialRegion])

  const pLabel = useMemo(() => {
    const mn = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    if (pFilter === "month") {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + pOffset)
      return `${mn[d.getMonth()]} ${d.getFullYear()}`
    }
    if (pFilter === "week") {
      const d = new Date(); const dow = d.getDay()
      d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1) + pOffset * 7); d.setHours(0,0,0,0)
      const end = new Date(d); end.setDate(end.getDate() + 6)
      return `${mn[d.getMonth()]} ${d.getDate()} – ${mn[end.getMonth()]} ${end.getDate()}`
    }
    return "All time"
  }, [pFilter, pOffset])

  // ISO date range matching the period filter — sent to the server so the
  // Solo/Team/All-Players reports and the Activity list filter by real
  // session dates instead of each quiz's last-played date.
  const periodRange = useMemo(() => {
    if (pFilter === "month") {
      const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + pOffset)
      const end = new Date(d); end.setMonth(end.getMonth() + 1)
      return { from: d.toISOString(), to: end.toISOString() }
    }
    if (pFilter === "week") {
      const d = new Date(); const dow = d.getDay()
      d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1) + pOffset * 7); d.setHours(0, 0, 0, 0)
      const end = new Date(d); end.setDate(end.getDate() + 7)
      return { from: d.toISOString(), to: end.toISOString() }
    }
    return { from: null as string | null, to: null as string | null }
  }, [pFilter, pOffset])

  useEffect(() => {
    if (!socket) return
    fetchSoloReport(periodRange)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, periodRange])

  const [sessionRows, setSessionRows] = useState<any[] | null>(null)
  useEffect(() => {
    if (!socket) return
    ;(socket as any).timeout(15000).emit("manager:getSessionsList", { from: periodRange.from, to: periodRange.to }, (err: any, data: any) => {
      if (!err && data?.ok) setSessionRows(data.rows)
    })
  }, [socket, periodRange])

  // Real daily aggregates for the Overview KPIs and trend chart
  const [trend, setTrend] = useState<{ days: any[]; summary: any } | null>(null)
  useEffect(() => {
    if (!socket) return
    ;(socket as any).timeout(15000).emit("manager:getActivityTrend", { from: periodRange.from, to: periodRange.to }, (err: any, res: any) => {
      if (!err && res?.ok) setTrend({ days: res.days, summary: res.summary })
    })
  }, [socket, periodRange])

  // Weekly engagement (active players + retention)
  const [engagement, setEngagement] = useState<any[] | null>(null)
  useEffect(() => {
    if (!socket) return
    ;(socket as any).timeout(15000).emit("manager:getEngagement", (err: any, res: any) => {
      if (!err && res?.ok) setEngagement(res.weeks)
    })
  }, [socket])

  // LDAP-known players with no activity in the selected period
  const [nonParticipants, setNonParticipants] = useState<any[] | null>(null)
  useEffect(() => {
    if (!socket) return
    ;(socket as any).timeout(20000).emit("manager:getNonParticipants", { from: periodRange.from, to: periodRange.to }, (err: any, res: any) => {
      if (!err && res?.ok) setNonParticipants(res.rows)
    })
  }, [socket, periodRange])

  // Per-player accuracy evolution, fetched on demand when a row is expanded
  const [playerTrends, setPlayerTrends] = useState<Record<string, any>>({})
  const fetchPlayerTrend = (name: string) => {
    if (!socket || playerTrends[name]) return
    ;(socket as any).timeout(15000).emit("manager:getPlayerTrend", { name }, (err: any, res: any) => {
      if (!err && res?.ok) setPlayerTrends(prev => ({ ...prev, [name]: res }))
    })
  }

  // Filters live in the URL so refresh/share keeps the same view
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search)
      const v = sp.get("view"); if (v) setActiveView(v as NavView)
      const p = sp.get("period"); if (p === "month" || p === "week") setPFilter(p)
      const o = Number(sp.get("offset")); if (!Number.isNaN(o) && o) setPOffset(o)
      const r = sp.get("region"); if (r === "BR" || r === "MY" || r === "CN") setRFilter(r)
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search)
      const setOrDel = (k: string, val: string | null) => { if (val) sp.set(k, val); else sp.delete(k) }
      setOrDel("view", activeView !== "overview" ? activeView : null)
      setOrDel("period", pFilter !== "all" ? pFilter : null)
      setOrDel("offset", pOffset !== 0 ? String(pOffset) : null)
      setOrDel("region", rFilter !== "all" ? rFilter : null)
      const qs = sp.toString()
      window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname)
    } catch {}
  }, [activeView, pFilter, pOffset, rFilter])

  const data = useMemo(() => {
    try {
      return (localList || []).map(q => {
        const stats = Array.isArray(q?.lastSessionStats) ? q.lastSessionStats : []
        return {
          id: q?.id || "",
          subject: q?.subject || "Untitled",
          createdBy: q?.createdBy || "System",
          createdAt: q?.createdAt || "",
          lastPlayedAt: q?.lastPlayedAt || "",
          questions: Array.isArray(q?.questions) ? q.questions : [],
          region: safeRegion(q),
          category: safeCategory(q),
          group: safeGroup(q),
          date: safeParseDate(q?.createdAt),
          playedDate: safeParseDate(q?.lastPlayedAt),
          stats,
          playerCount: stats.length,
        }
      })
    } catch { return [] }
  }, [localList])

  const filtered = useMemo(() => {
    try {
      let list = data
      if (rFilter !== "all") list = list.filter(q => q.region === rFilter)
      if (aFilter !== "all") list = list.filter(q => q.createdBy === aFilter)
      if (pFilter === "month") {
        const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + pOffset)
        list = list.filter(q => { const qd = q.playedDate || q.date; return qd && qd.getMonth() === d.getMonth() && qd.getFullYear() === d.getFullYear() })
      } else if (pFilter === "week") {
        const ws = new Date(); const dow = ws.getDay()
        ws.setDate(ws.getDate() - (dow === 0 ? 6 : dow - 1) + pOffset * 7); ws.setHours(0,0,0,0)
        const we = new Date(ws); we.setDate(we.getDate() + 7)
        list = list.filter(q => { const qd = q.playedDate || q.date; return qd && qd >= ws && qd < we })
      }
      return list
    } catch { return data }
  }, [data, rFilter, pFilter, pOffset, aFilter])

  const metrics = useMemo(() => {
    try {
      let tp = 0, tc = 0, ta = 0, tt = 0
      const up = new Set<string>(), cr = new Set<string>()
      const played = filtered.filter(q => q.playerCount > 0)
      filtered.forEach(q => {
        cr.add(q.createdBy)
        tt += q.questions.reduce((a: number, x: any) => a + (x?.time || 15) + (x?.cooldown || 5), 0)
        q.stats.forEach((p: any) => {
          tp++; up.add(p?.username || p?.name || "")
          ;(p?.answers || []).forEach((a: any) => { ta++; if (a?.isCorrect) tc++ })
        })
      })
      return {
        total: filtered.length, questions: filtered.reduce((a, q) => a + q.questions.length, 0),
        sessions: played.length, players: tp, unique: up.size, creators: cr.size,
        acc: ta > 0 ? Math.round(tc / ta * 100) : 0,
        totalCorrect: tc, totalAnswers: ta,
        avgP: played.length > 0 ? Math.round(tp / played.length * 10) / 10 : 0,
        avgD: played.length > 0 ? Math.round(tt / played.length / 60 * 10) / 10 : 0,
      }
    } catch { return { total: 0, questions: 0, sessions: 0, players: 0, unique: 0, creators: 0, acc: 0, totalCorrect: 0, totalAnswers: 0, avgP: 0, avgD: 0 } }
  }, [filtered])

  // Overview KPIs from real session data (every session counts, accuracy
  // weighted by answers). Falls back to quiz-level metrics while loading.
  const kpi = useMemo(() => {
    const sm = trend?.summary
    return {
      sessions: sm?.sessions ?? metrics.sessions,
      participations: sm?.participations ?? metrics.players,
      unique: sm?.unique_players ?? metrics.unique,
      acc: sm && sm.total > 0 ? Math.round((100 * sm.correct) / sm.total) : metrics.acc,
      avgP: sm && sm.sessions > 0 ? Math.round((sm.participations / sm.sessions) * 10) / 10 : metrics.avgP,
    }
  }, [trend, metrics])

  const playerTiers = useMemo(() => {
    try {
      const p: Record<string, { name: string; c: number; t: number }> = {}
      filtered.forEach(q => q.stats.forEach((s: any) => {
        const key = s?.clientId || s?.realName || s?.username || s?.name || ""; if (!key) return
        const _name = applyName(key, s?.realName || s?.username || s?.name || key); if (isExcluded(_name)) return
        if (!p[key]) p[key] = { name: _name, c: 0, t: 0 }
        p[key].name = applyName(key, s?.realName || s?.username || s?.name || key)
        ;(s?.answers || []).forEach((a: any) => { p[key].t++; if (a?.isCorrect) p[key].c++ })
      }))
      const nameMap: Record<string, string> = {}; const merged: typeof p = {}
      Object.entries(p).forEach(([key, val]) => {
        const norm = val.name.toLowerCase().trim()
        if (nameMap[norm]) { const ek = nameMap[norm]; merged[ek].c += val.c; merged[ek].t += val.t }
        else { nameMap[norm] = key; merged[key] = { ...val } }
      })
      const tiers = { green: 0, blue: 0, amber: 0, red: 0 }
      Object.values(merged).forEach(v => {
        const acc = v.t > 0 ? Math.round(v.c / v.t * 100) : 0
        if (acc >= 65) tiers.green++
        else if (acc >= 50) tiers.blue++
        else if (acc >= 35) tiers.amber++
        else tiers.red++
      })
      return tiers
    } catch { return { green: 0, blue: 0, amber: 0, red: 0 } }
  }, [filtered, nameCorrections, applyName])

  const regionStats = useMemo(() => {
    try {
      const s = { BR: { q: 0, p: 0, c: 0, t: 0, time: 0 }, MY: { q: 0, p: 0, c: 0, t: 0, time: 0 }, CN: { q: 0, p: 0, c: 0, t: 0, time: 0 } }
      data.forEach(q => {
        const r = q.region === "MY" ? "MY" : q.region === "CN" ? "CN" : "BR"
        s[r].q++
        s[r].time += q.questions.reduce((a: number, x: any) => a + (x?.time || 15) + (x?.cooldown || 5), 0)
        q.stats.forEach((p: any) => {
          s[r].p++
          ;(p?.answers || []).forEach((a: any) => { s[r].t++; if (a?.isCorrect) s[r].c++ })
        })
      })
      return s
    } catch { return { BR: { q: 0, p: 0, c: 0, t: 0, time: 0 }, MY: { q: 0, p: 0, c: 0, t: 0, time: 0 }, CN: { q: 0, p: 0, c: 0, t: 0, time: 0 } } }
  }, [data])

  const groupStats = useMemo(() => {
    try {
      const gs: Record<string, { q: number; p: number; c: number; t: number }> = {
        ATP: { q: 0, p: 0, c: 0, t: 0 }, ATD: { q: 0, p: 0, c: 0, t: 0 }, Others: { q: 0, p: 0, c: 0, t: 0 },
      }
      filtered.forEach(q => {
        const g = q.group
        if (!gs[g]) gs[g] = { q: 0, p: 0, c: 0, t: 0 }
        gs[g].q++
        q.stats.forEach((p: any) => {
          gs[g].p++
          ;(p?.answers || []).forEach((a: any) => { gs[g].t++; if (a?.isCorrect) gs[g].c++ })
        })
      })
      return gs
    } catch { return { ATP: { q: 0, p: 0, c: 0, t: 0 }, ATD: { q: 0, p: 0, c: 0, t: 0 }, Others: { q: 0, p: 0, c: 0, t: 0 } } }
  }, [filtered])

  const monthly = useMemo(() => {
    try {
      const m: Record<string, { q: number; p: number; c: number; t: number }> = {}
      filtered.forEach(q => {
        const d = q.playedDate || q.date
        if (!d || q.playerCount === 0) return
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
        if (!m[k]) m[k] = { q: 0, p: 0, c: 0, t: 0 }
        m[k].q++; m[k].p += q.playerCount
        q.stats.forEach((p: any) => (p?.answers || []).forEach((a: any) => { m[k].t++; if (a?.isCorrect) m[k].c++ }))
      })
      // Find earliest date across all quizzes (not just played)
      const allDates = filtered.map(q => q.playedDate || q.date).filter(Boolean) as Date[]
      if (allDates.length === 0) return []
      const minDate = allDates.reduce((a, b) => a < b ? a : b)
      const now = new Date()
      const mn = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
      const result = []
      let cur = new Date(minDate.getFullYear(), minDate.getMonth(), 1)
      const end = new Date(now.getFullYear(), now.getMonth(), 1)
      while (cur <= end) {
        const k = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`
        const v = m[k] || { q: 0, p: 0, c: 0, t: 0 }
        result.push({ key: k, label: `${mn[cur.getMonth()]} ${String(cur.getFullYear()).slice(2)}`, players: v.p, quizzes: v.q, correct: v.c, wrong: v.t - v.c, total: v.t, acc: v.t > 0 ? Math.round(v.c / v.t * 100) : 0 })
        cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1)
      }
      return result
    } catch { return [] }
  }, [filtered])

  const weeklyInMonth = useMemo(() => {
    if (pFilter !== "month") return []
    try {
      const w: Record<number, { p: number; q: number; c: number; t: number; label: string }> = {}
      filtered.forEach(q => {
        const d = q.playedDate || q.date; if (!d || q.playerCount === 0) return
        const weekNum = Math.floor((d.getDate() - 1) / 7) + 1
        if (!w[weekNum]) w[weekNum] = { p: 0, q: 0, c: 0, t: 0, label: `Wk ${weekNum}` }
        w[weekNum].q++; w[weekNum].p += q.playerCount
        q.stats.forEach((s: any) => (s?.answers || []).forEach((a: any) => { w[weekNum].t++; if (a?.isCorrect) w[weekNum].c++ }))
      })
      return [1, 2, 3, 4, 5].map(i => ({ week: i, label: w[i]?.label || `Wk ${i}`, players: w[i]?.p || 0, quizzes: w[i]?.q || 0, correct: w[i]?.c || 0, wrong: (w[i]?.t || 0) - (w[i]?.c || 0), total: w[i]?.t || 0, acc: (w[i]?.t ?? 0) > 0 ? Math.round(w[i].c / w[i].t * 100) : 0 })).filter((_, i) => i < 4 || (w[5]?.p ?? 0) > 0)
    } catch { return [] }
  }, [filtered, pFilter])

  const weeklyDays = useMemo(() => {
    if (pFilter !== "week") return []
    try {
      const DAY = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
      const d: Record<number, { p: number; q: number; c: number; t: number }> = {}
      filtered.forEach(q => {
        const date = q.playedDate || q.date; if (!date || q.playerCount === 0) return
        const dow = date.getDay()
        if (!d[dow]) d[dow] = { p: 0, q: 0, c: 0, t: 0 }
        d[dow].q++; d[dow].p += q.playerCount
        q.stats.forEach((s: any) => (s?.answers || []).forEach((a: any) => { d[dow].t++; if (a?.isCorrect) d[dow].c++ }))
      })
      return [1,2,3,4,5,6,0].map(i => ({ day: DAY[i], players: d[i]?.p || 0, quizzes: d[i]?.q || 0, correct: d[i]?.c || 0, wrong: Math.max((d[i]?.t || 0) - (d[i]?.c || 0), 0), total: d[i]?.t || 0, acc: (d[i]?.t ?? 0) > 0 ? Math.round(d[i].c / d[i].t * 100) : 0 }))
    } catch { return [] }
  }, [filtered, pFilter])

  const [minGames, setMinGames] = useState(2)
  const [topPlayersRegion, setTopPlayersRegion] = useState<"all" | "BR" | "MY" | "CN">("all")
  const [topMetric, setTopMetric] = useState<"avgPts" | "avgCorrect" | "games">("avgPts")

  const topPlayers = useMemo(() => {
    try {
      const source = topPlayersRegion === "all" ? filtered : filtered.filter(q => q.region === topPlayersRegion)
      const p: Record<string, { name: string; q: number; pts: number; c: number; t: number }> = {}
      source.forEach(q => q.stats.forEach((s: any) => {
        const key = s?.clientId || s?.realName || s?.username || s?.name || ""; if (!key) return
        const _tpName = applyName(key, s?.realName || s?.username || s?.name || key); if (isExcluded(_tpName)) return
        if (!p[key]) p[key] = { name: _tpName, q: 0, pts: 0, c: 0, t: 0 }
        p[key].name = applyName(key, s?.realName || s?.username || s?.name || key)
        p[key].q++; p[key].pts += s?.points || 0
        ;(s?.answers || []).forEach((a: any) => { p[key].t++; if (a?.isCorrect) p[key].c++ })
      }))
      const nameMap: Record<string, string> = {}; const merged: typeof p = {}
      Object.entries(p).forEach(([key, val]) => {
        const norm = val.name.toLowerCase().trim()
        if (nameMap[norm]) { const ek = nameMap[norm]; merged[ek].q += val.q; merged[ek].pts += val.pts; merged[ek].c += val.c; merged[ek].t += val.t }
        else { nameMap[norm] = key; merged[key] = { ...val } }
      })
      const threshold = showBelow50 ? 1 : minGames
      const all = Object.entries(merged).filter(([, v]) => v.q >= threshold)
        .map(([, v]) => ({ name: v.name, games: v.q, totalPts: v.pts, avgPts: v.q > 0 ? Math.round(v.pts / v.q) : 0, avgCorrect: v.q > 0 ? Math.round(v.c / v.q * 10) / 10 : 0, acc: v.t > 0 ? Math.round(v.c / v.t * 100) : 0 }))
      if (showBelow50) return all.filter(p => p.acc < 50).sort((a, b) => a.acc - b.acc)
      return all.sort((a, b) => topMetric === "avgPts" ? b.avgPts - a.avgPts || b.acc - a.acc : topMetric === "avgCorrect" ? b.avgCorrect - a.avgCorrect || b.acc - a.acc : b.games - a.games || b.avgPts - a.avgPts).slice(0, 10)
    } catch { return [] }
  }, [filtered, topPlayersRegion, nameCorrections, applyName, minGames, topMetric, showBelow50])

  const topCreators = useMemo(() => {
    try {
      const c: Record<string, { q: number; r: string; display: string }> = {}
      filtered.forEach(q => { const n = q.createdBy; const norm = n.toLowerCase().trim(); if (!c[norm]) c[norm] = { q: 0, r: q.region, display: n }; c[norm].q++ })
      return Object.entries(c).map(([, v]) => ({ name: v.display, quizzes: v.q, region: v.r })).sort((a, b) => b.quizzes - a.quizzes).slice(0, 5)
    } catch { return [] }
  }, [filtered])

  const categories = useMemo(() => {
    try {
      const c: Record<string, { total: number; played: number }> = {}
      filtered.forEach(q => { if (!c[q.category]) c[q.category] = { total: 0, played: 0 }; c[q.category].total++; if (q.playerCount > 0) c[q.category].played++ })
      return Object.entries(c).map(([n, v]) => ({ name: n, count: v.total, played: v.played })).sort((a, b) => b.count - a.count)
    } catch { return [] }
  }, [filtered])

  const hardest = useMemo(() => {
    try {
      return filtered.filter(q => q.playerCount > 2).map(q => {
        let c = 0, t = 0
        q.stats.forEach((p: any) => (p?.answers || []).forEach((a: any) => { t++; if (a?.isCorrect) c++ }))
        return { subject: q.subject, region: q.region, players: q.playerCount, acc: t > 0 ? Math.round(c / t * 100) : 0 }
      }).sort((a, b) => a.acc - b.acc).slice(0, 4)
    } catch { return [] }
  }, [filtered])

  // Real sessions from the database (period-filtered server-side) — the old
  // version listed quizzes by last-played, hiding earlier sessions entirely.
  const recent = useMemo(() => {
    try {
      if (!sessionRows) return []
      const quizById = new Map(data.map(q => [q.id, q]))
      return sessionRows
        .map((r: any) => {
          const q = quizById.get(r.quiz_id)
          return {
            sessionId: r.session_id,
            id: r.quiz_id,
            subject: q?.subject || r.quiz_title,
            createdBy: q?.createdBy || "System",
            region: q?.region || "BR",
            group: q?.group || "",
            questions: q?.questions || [],
            playerCount: r.player_count || 0,
            lastPlayedAt: (() => { try { return new Date(r.ended_at).toLocaleString("en-US") } catch { return r.ended_at || "--" } })(),
            acc: r.total_answers > 0 ? Math.round((r.total_correct / r.total_answers) * 100) : 0,
          }
        })
        .filter((s: any) => rFilter === "all" || s.region === rFilter)
        .slice(0, 20)
    } catch { return [] }
  }, [sessionRows, data, rFilter])

  const authors = useMemo(() => { try { return [...new Set(data.map(q => q.createdBy))].sort() } catch { return [] } }, [data])
  const allCategories = useMemo(() => { try { return [...new Set(data.map(q => q.category))].sort() } catch { return [] } }, [data])

  const [rankingCats, setRankingCats] = useState<string[]>([])
  const [rankingGroups, setRankingGroups] = useState<string[]>([])
  const [weeklyTab, setWeeklyTab] = useState<"region" | "group">("region")
  // Leaderboard rankings follow the shared period filter bar (All time /
  // Month / Week with ‹ › navigation) instead of a private week/month toggle
  const lbRange = useMemo(() => ({
    from: periodRange.from ? new Date(periodRange.from) : null,
    to: periodRange.to ? new Date(periodRange.to) : null,
  }), [periodRange])

  const toggleRankingCat = (cat: string) => setRankingCats(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat])
  const toggleRankingGroup = (g: string) => setRankingGroups(prev => prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g])

  const weeklyTop = useMemo(() => {
    try {
      let wq = data.filter(q => q.playerCount > 0 && (!lbRange.from || (q.playedDate && q.playedDate >= lbRange.from && (!lbRange.to || q.playedDate < lbRange.to))))
      if (rankingCats.length > 0) wq = wq.filter(q => rankingCats.includes(q.category))
      const byR: Record<string, Record<string, { realName: string; games: number; pts: number; c: number; t: number; nicknames: Set<string> }>> = { BR: {}, MY: {}, CN: {} }
      wq.forEach(q => {
        const r = q.region === "MY" ? "MY" : q.region === "CN" ? "CN" : "BR"
        q.stats.forEach((s: any) => {
          const key = s?.clientId || s?.realName || s?.username || s?.name || ""; if (!key) return
          const display = applyName(key, s?.realName || s?.username || s?.name || "")
          if (isExcluded(display)) return
          const nick = s?.username || s?.name || ""
          if (!byR[r][key]) byR[r][key] = { realName: display, games: 0, pts: 0, c: 0, t: 0, nicknames: new Set() }
          byR[r][key].realName = applyName(key, s?.realName || s?.username || s?.name || byR[r][key].realName)
          if (nick && nick !== display) byR[r][key].nicknames.add(nick)
          byR[r][key].games++; byR[r][key].pts += s?.points || 0
          ;(s?.answers || []).forEach((a: any) => { byR[r][key].t++; if (a?.isCorrect) byR[r][key].c++ })
        })
      })
      const result: Record<string, any[]> = {}
      for (const region of ["BR", "MY", "CN"]) {
        const nm: Record<string, string> = {}; const mg: typeof byR["BR"] = {}
        Object.entries(byR[region]).forEach(([key, val]) => {
          const norm = val.realName.toLowerCase().trim()
          if (nm[norm]) { const ek = nm[norm]; mg[ek].games += val.games; mg[ek].pts += val.pts; mg[ek].c += val.c; mg[ek].t += val.t; val.nicknames.forEach(n => mg[ek].nicknames.add(n)) }
          else { nm[norm] = key; mg[key] = { ...val, nicknames: new Set(val.nicknames) } }
        })
        result[region] = Object.entries(mg)
          .map(([, v]) => ({ name: v.realName, nicknames: Array.from(v.nicknames).slice(0, 2), games: v.games, totalPts: v.pts, avgPts: v.games > 0 ? Math.round(v.pts / v.games) : 0, acc: v.t > 0 ? Math.round(v.c / v.t * 100) : 0 }))
          .filter(p => p.games >= minGames).sort((a, b) => b.totalPts - a.totalPts || b.avgPts - a.avgPts).slice(0, 10)
      }
      return result
    } catch { return { BR: [], MY: [], CN: [] } }
  }, [data, rankingCats, nameCorrections, applyName, minGames, lbRange])

  const weeklyTopByGroup = useMemo(() => {
    try {
      let wq = data.filter(q => q.playerCount > 0 && (!lbRange.from || (q.playedDate && q.playedDate >= lbRange.from && (!lbRange.to || q.playedDate < lbRange.to))))
      if (rankingGroups.length > 0) wq = wq.filter(q => rankingGroups.includes(q.group))
      const byG: Record<string, Record<string, { realName: string; games: number; pts: number; c: number; t: number; nicknames: Set<string> }>> = { ATP: {}, ATD: {}, Others: {} }
      wq.forEach(q => {
        const g = q.group; if (!byG[g]) byG[g] = {}
        q.stats.forEach((s: any) => {
          const key = s?.clientId || s?.realName || s?.username || s?.name || ""; if (!key) return
          const display = applyName(key, s?.realName || s?.username || s?.name || "")
          if (isExcluded(display)) return
          const nick = s?.username || s?.name || ""
          if (!byG[g][key]) byG[g][key] = { realName: display, games: 0, pts: 0, c: 0, t: 0, nicknames: new Set() }
          byG[g][key].realName = applyName(key, s?.realName || s?.username || s?.name || byG[g][key].realName)
          if (nick && nick !== display) byG[g][key].nicknames.add(nick)
          byG[g][key].games++; byG[g][key].pts += s?.points || 0
          ;(s?.answers || []).forEach((a: any) => { byG[g][key].t++; if (a?.isCorrect) byG[g][key].c++ })
        })
      })
      const result: Record<string, any[]> = {}
      for (const g of ["ATP", "ATD", "Others"]) {
        const nm: Record<string, string> = {}; const mg: typeof byG["ATP"] = {}
        Object.entries(byG[g] || {}).forEach(([key, val]) => {
          const norm = val.realName.toLowerCase().trim()
          if (nm[norm]) { const ek = nm[norm]; mg[ek].games += val.games; mg[ek].pts += val.pts; mg[ek].c += val.c; mg[ek].t += val.t; val.nicknames.forEach(n => mg[ek].nicknames.add(n)) }
          else { nm[norm] = key; mg[key] = { ...val, nicknames: new Set(val.nicknames) } }
        })
        result[g] = Object.entries(mg)
          .map(([, v]) => ({ name: v.realName, nicknames: Array.from(v.nicknames).slice(0, 2), games: v.games, totalPts: v.pts, avgPts: v.games > 0 ? Math.round(v.pts / v.games) : 0, acc: v.t > 0 ? Math.round(v.c / v.t * 100) : 0 }))
          .filter(p => p.games >= minGames).sort((a, b) => b.totalPts - a.totalPts || b.avgPts - a.avgPts).slice(0, 10)
      }
      return result
    } catch { return { ATP: [], ATD: [], Others: [] } }
  }, [data, rankingGroups, nameCorrections, applyName, minGames, lbRange])

  // The report is already period-filtered server-side, so it is the single
  // source of truth for every period (all/month/week).
  const combinedRows = useMemo(() => {
    if (!soloReport?.ok) return []
    const soloMap = new Map(soloReport.playerStats.map(p => [p.real_name, p]))
    const teamMap = new Map(soloReport.teamStats.map(p => [p.real_name, p]))
    const allNames = Array.from(new Set([...soloMap.keys(), ...teamMap.keys()]))
    return allNames.map(name => ({
      name,
      solo_games: soloMap.get(name)?.total_attempts ?? 0,
      solo_acc: soloMap.get(name)?.avg_accuracy ?? 0,
      solo_correct: soloMap.get(name)?.total_correct ?? 0,
      team_games: teamMap.get(name)?.games_played ?? 0,
      team_acc: teamMap.get(name)?.avg_accuracy ?? 0,
      team_correct: teamMap.get(name)?.total_correct ?? 0,
    }))
  }, [soloReport])

  const maxCC = Math.max(...categories.map(c => c.count), 1)
  const maxGQ = Math.max(...Object.values(groupStats).map(g => g.q), 1)
  const rc = ["bg-amber-400", "bg-gray-400", "bg-amber-700", "bg-gray-300", "bg-gray-300"]

  const [participationDate, setParticipationDate] = useState<string>("")
  // Day was the only granularity. A manager asking "who is missing" thinks in
  // months, not in one specific Tuesday.
  const [participationMode, setParticipationMode] = useState<"day" | "month">("day")
  const [participationMonth, setParticipationMonth] = useState<string>("")
  // Off by default: with it on the list stops being "who played" and becomes
  // "everyone", which is a different question and a much longer list.
  const [participationShowAll, setParticipationShowAll] = useState(false)
  const [participationMeta, setParticipationMeta] = useState<{ sessions: number; roster: string[]; months: string[] }>({ sessions: 0, roster: [], months: [] })
  const [participationSort, setParticipationSort] = useState<"count" | "pts" | "name">("count")
  const [participationRegion, setParticipationRegion] = useState<"all" | "BR" | "MY" | "CN">("all")
  useEffect(() => { if (activeView === "participation") setParticipationRegion(rFilter as "all" | "BR" | "MY" | "CN") }, [rFilter, activeView])

  // Real per-session rows for the picked day, straight from the database —
  // the old version only saw each quiz's LAST session, hiding earlier games.
  const [dayRows, setDayRows] = useState<any[] | null>(null)
  const participationPeriod = participationMode === "day" ? participationDate : participationMonth
  useEffect(() => {
    if (!socket || !participationPeriod) { setDayRows(null); return }
    const args = participationMode === "day" ? { date: participationPeriod } : { month: participationPeriod }
    ;(socket as any).timeout(20000).emit("manager:getDayParticipation", args, (err: any, res: any) => {
      setDayRows(!err && res?.ok ? res.rows : [])
      if (!err && res?.ok) {
        setParticipationMeta({ sessions: res.sessions ?? 0, roster: res.roster ?? [], months: res.months ?? [] })
      }
    })
  }, [socket, participationPeriod, participationMode])

  const dayParticipation = useMemo(() => {
    if (!participationPeriod || !dayRows) return []
    const regionOf = new Map(data.map(q => [q.id, q.region]))
    const players: Record<string, { name: string; count: number; pts: number; c: number; t: number; quizzes: string[] }> = {}
    dayRows.forEach((r: any) => {
      const region = regionOf.get(r.quiz_id) || "BR"
      if (participationRegion !== "all" && region !== participationRegion) return
      const key = r.real_name || ""; if (!key) return
      const display = applyName(key, key)
      if (!players[key]) players[key] = { name: display, count: 0, pts: 0, c: 0, t: 0, quizzes: [] }
      players[key].count++; players[key].pts += r.points || 0
      players[key].c += r.correct || 0
      players[key].t += (r.correct || 0) + (r.incorrect || 0) + (r.unanswered || 0)
      if (!players[key].quizzes.includes(r.quiz_title)) players[key].quizzes.push(r.quiz_title)
    })
    const nameMap: Record<string, string> = {}; const merged: typeof players = {}
    Object.entries(players).forEach(([key, val]) => {
      const norm = val.name.toLowerCase().trim()
      if (nameMap[norm]) {
        const ek = nameMap[norm]; merged[ek].count += val.count; merged[ek].pts += val.pts; merged[ek].c += val.c; merged[ek].t += val.t
        val.quizzes.forEach(q => { if (!merged[ek].quizzes.includes(q)) merged[ek].quizzes.push(q) })
      } else { nameMap[norm] = key; merged[key] = { ...val, quizzes: [...val.quizzes] } }
    })
    // People who played nothing in the period. Only meaningful with no region
    // filter: someone who did not play has no quiz, therefore no region, and
    // would show up under every region tab as if they belonged to it.
    if (participationShowAll && participationRegion === "all") {
      const vistos = new Set(Object.values(merged).map(v => v.name.toLowerCase().trim()))
      participationMeta.roster.forEach(rn => {
        const display = applyName(rn, rn)
        if (vistos.has(display.toLowerCase().trim())) return
        vistos.add(display.toLowerCase().trim())
        merged["zero:" + rn] = { name: display, count: 0, pts: 0, c: 0, t: 0, quizzes: [] }
      })
    }
    const result = Object.values(merged).map(p => ({ ...p, avgPts: p.count > 0 ? Math.round(p.pts / p.count) : 0, acc: p.t > 0 ? Math.round(p.c / p.t * 100) : 0 }))
    if (participationSort === "count") result.sort((a, b) => b.count - a.count)
    else if (participationSort === "pts") result.sort((a, b) => b.pts - a.pts)
    else result.sort((a, b) => a.name.localeCompare(b.name))
    return result
  }, [data, dayRows, participationPeriod, participationSort, participationRegion, nameCorrections, applyName,
      participationShowAll, participationMeta])

  // ── RENDER ─────────────────────────────────────────────────────────────────

  const TH = ({ cls, children }: { cls: string; children: React.ReactNode }) => (
    <div className={clsx("shrink-0 text-xs font-semibold text-gray-400 uppercase tracking-wide select-none", cls)}>{children}</div>
  )

  // Clickable column header — click toggles high→low / low→high
  const SortableTH = ({ label, k, sort, onSort, cls, defaultDir = "desc" }: {
    label: string; k: string
    sort: { key: string; dir: "asc" | "desc" }
    onSort: (s: any) => void
    cls?: string; defaultDir?: "asc" | "desc"
  }) => (
    <button
      onClick={() => onSort(sort.key === k ? { key: k, dir: sort.dir === "desc" ? "asc" : "desc" } : { key: k, dir: defaultDir })}
      title="Click to sort"
      className={clsx("flex items-center gap-0.5 text-[10px] font-bold uppercase tracking-widest select-none transition-colors", cls,
        sort.key === k ? "text-primary" : "text-gray-400 hover:text-gray-600")}>
      <span>{label}</span>
      <span className="w-2 text-[8px]">{sort.key === k ? (sort.dir === "desc" ? "▼" : "▲") : ""}</span>
    </button>
  )

  const analyticsNav: { id: NavView; label: string; icon: React.ReactNode }[] = [
    { id: "overview",      label: "Overview",      icon: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg> },
    { id: "players",       label: "Top Players",   icon: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"><rect x="2" y="13" width="5" height="9" rx="1"/><rect x="9.5" y="8" width="5" height="14" rx="1"/><rect x="17" y="11" width="5" height="11" rx="1"/></svg> },
    { id: "leaderboard",   label: "Leaderboard",   icon: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg> },
    { id: "participation", label: "Participation", icon: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> },
    { id: "activity",      label: "Activity",      icon: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> },
    { id: "solo",          label: "Solo Games",    icon: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M12 14c-5 0-8 2-8 3v1h16v-1c0-1-3-3-8-3z"/><path d="M19 3l1.5 1.5L17 8l-1.5-1.5z" strokeWidth="1.4"/></svg> },
    { id: "team_games",    label: "Classic Games", icon: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg> },
    { id: "combined",      label: "All Players",   icon: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg> },
    { id: "question_bank", label: "Question Bank", icon: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/></svg> },
  ]
  const manageNav: { id: NavView; label: string; icon: React.ReactNode }[] = [
    { id: "quizzes", label: "My Quizzes",  icon: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg> },
    { id: "team",    label: "All Players", icon: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg> },
  ]

  return (
    <div className="flex" style={{ height: "100vh", overflow: "hidden", background: "#f8fafc", width: "100%" }}>

      {/* ═══ LEFT SIDEBAR — logo + labels ═══════════════════════════════════ */}
      <aside className="w-52 shrink-0 bg-white border-r border-gray-100 flex flex-col"
        style={{ height: "100vh", overflowY: "auto" }}>

        {/* Logo */}
        <div className="px-4 py-4 border-b border-gray-100 shrink-0 flex flex-col items-center gap-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/angeltreat-logo.png" alt="Angel TREAT" style={{ height: 22, width: "auto", maxWidth: "100%" }} />
          <Image src={logo} alt="Rahoot!" style={{ height: 30, width: "auto" }} className="drop-shadow-[0_2px_4px_rgba(0,0,0,0.15)]" />
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-3 px-2.5">
          <div className="mb-1 mt-0.5 px-2 pb-1">
            <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400">Analytics</span>
          </div>
          {analyticsNav.map(item => (
            <button key={item.id} onClick={() => setActiveView(item.id)}
              className={clsx(
                "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-all mb-0.5",
                activeView === item.id
                  ? "bg-primary/10 text-primary font-semibold"
                  : "font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-800"
              )}>
              {item.icon}
              <span className="truncate">{item.label}</span>
            </button>
          ))}

          <div className="mb-1 mt-4 px-2 pb-1">
            <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400">Manage</span>
          </div>
          {manageNav.map(item => (
            <button key={item.id} onClick={() => setActiveView(item.id)}
              className={clsx(
                "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-all mb-0.5",
                activeView === item.id
                  ? "bg-primary/10 text-primary font-semibold"
                  : "font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-800"
              )}>
              {item.icon}
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </nav>

        {/* Exit to player screen */}
        <div className="shrink-0 border-t border-gray-100 px-2.5 py-3">
          <Link
            href="/"
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            <span className="truncate">Exit to player</span>
          </Link>
          <p className="mt-1.5 text-center text-[10px] font-medium text-gray-300 select-none">Rahoot {APP_VERSION}</p>
        </div>

      </aside>

      {/* ═══ MAIN CONTENT ═══════════════════════════════════════════════════ */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* ── Inline filter bar ────────────────────────────────────────────── */}
        {activeView !== "team" && (
          <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-gray-100 bg-white flex-wrap">
            {/* Leaderboard shows all regions side by side and has no author concept,
                so it only gets the shared period controls */}
            {activeView !== "leaderboard" && (["all","BR","MY","CN"] as RFilter[]).map(r => {
              const cnt = r === "all" ? regionStats.BR.q + regionStats.MY.q + regionStats.CN.q : regionStats[r]?.q ?? 0
              return (
                <button key={r} onClick={() => setRFilter(r)} className={clsx("rounded-full px-2.5 py-1 text-[10px] font-semibold transition-colors", rFilter === r ? "bg-primary text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200")}>
                  {r === "all" ? `All (${cnt})` : `${r} (${cnt})`}
                </button>
              )
            })}
            {activeView !== "quizzes" && (<>
              {activeView !== "leaderboard" && <div className="w-px h-4 bg-gray-200 mx-0.5"/>}
              {/* All time */}
              <button
                onClick={() => { setPFilter("all"); setPOffset(0) }}
                className={clsx("rounded-full px-2.5 py-1 text-[10px] font-semibold transition-colors", pFilter === "all" ? "bg-primary text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200")}
              >
                All time
              </button>

              {/* Month nav */}
              <div className={clsx("flex items-center rounded-full overflow-hidden border transition-colors", pFilter === "month" ? "border-primary" : "border-gray-200")}>
                <button
                  onClick={() => { setPFilter("month"); setPOffset(p => p - 1) }}
                  className={clsx("px-1.5 py-1 text-[10px] font-bold transition-colors", pFilter === "month" ? "bg-primary text-white hover:bg-primary/80" : "bg-gray-100 text-gray-500 hover:bg-gray-200")}
                  style={{ minWidth: 20 }}
                >‹</button>
                <button
                  onClick={() => { setPFilter("month"); setPOffset(0) }}
                  className={clsx("px-2.5 py-1 text-[10px] font-semibold transition-colors", pFilter === "month" ? "bg-primary text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200")}
                  style={{ minWidth: 64 }}
                >
                  {pFilter === "month" ? pLabel : "Month"}
                </button>
                <button
                  onClick={() => { setPFilter("month"); setPOffset(p => Math.min(p + 1, 0)) }}
                  className={clsx("px-1.5 py-1 text-[10px] font-bold transition-colors", pFilter === "month" && pOffset < 0 ? "bg-primary text-white hover:bg-primary/80" : "bg-gray-100 text-gray-400 cursor-default")}
                  disabled={pFilter !== "month" || pOffset >= 0}
                  style={{ minWidth: 20 }}
                >›</button>
              </div>

              {/* Week nav */}
              <div className={clsx("flex items-center rounded-full overflow-hidden border transition-colors", pFilter === "week" ? "border-primary" : "border-gray-200")}>
                <button
                  onClick={() => { setPFilter("week"); setPOffset(p => p - 1) }}
                  className={clsx("px-1.5 py-1 text-[10px] font-bold transition-colors", pFilter === "week" ? "bg-primary text-white hover:bg-primary/80" : "bg-gray-100 text-gray-500 hover:bg-gray-200")}
                  style={{ minWidth: 20 }}
                >‹</button>
                <button
                  onClick={() => { setPFilter("week"); setPOffset(0) }}
                  className={clsx("px-2.5 py-1 text-[10px] font-semibold transition-colors", pFilter === "week" ? "bg-primary text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200")}
                  style={{ minWidth: 90 }}
                >
                  {pFilter === "week" ? pLabel : "Week"}
                </button>
                <button
                  onClick={() => { setPFilter("week"); setPOffset(p => Math.min(p + 1, 0)) }}
                  className={clsx("px-1.5 py-1 text-[10px] font-bold transition-colors", pFilter === "week" && pOffset < 0 ? "bg-primary text-white hover:bg-primary/80" : "bg-gray-100 text-gray-400 cursor-default")}
                  disabled={pFilter !== "week" || pOffset >= 0}
                  style={{ minWidth: 20 }}
                >›</button>
              </div>
              {activeView !== "leaderboard" && (<>
                <div className="w-px h-4 bg-gray-200 mx-0.5"/>
                <select value={aFilter} onChange={e => setAFilter(e.target.value)} className="rounded-lg bg-gray-50 border border-gray-200 px-2 py-1 text-[10px] font-semibold text-gray-600 outline-none cursor-pointer">
                  <option value="all">All authors</option>
                  {authors.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </>)}
            </>)}
          </div>
        )}
        {activeView === "quizzes" ? (
          <div className="flex-1 overflow-hidden">
            <SelectQuizz quizzList={localList} onSelect={onSelect || (() => {})} onListChange={handleListChange} regionFilter={rFilter} />
          </div>
        ) : activeView === "team" ? (
          <div className="flex-1 overflow-auto p-5">
            <ManagerPlayers quizzList={localList} regionFilter={rFilter} />
          </div>
        ) : null}
        <div className={clsx("flex-1 min-h-0 overflow-auto p-5 flex flex-col gap-5", (activeView === "quizzes" || activeView === "team") && "hidden")}>

          {/* ── OVERVIEW ──────────────────────────────────────────────────── */}
          {activeView === "overview" && (<>

            {/* KPI cards */}
            <div className="grid grid-cols-4 gap-4">
              {[
                { label: "Total Quizzes", val: metrics.total, sub1: `${metrics.questions} questions`, sub2: `${kpi.sessions} sessions played`, color: "bg-primary", iconColor: "#009edf", icon: <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 12h6M9 16h4"/> },
                { label: "Participations", val: kpi.participations.toLocaleString(), sub1: `${kpi.unique} unique players`, sub2: `${metrics.creators} content creators`, color: "bg-green-500", iconColor: "#22c55e", icon: <><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></> },
                { label: "Avg / Session", val: kpi.avgP, sub1: "players per session", sub2: `${metrics.avgD} min avg duration`, color: "bg-amber-400", iconColor: "#f59e0b", icon: <path d="M18 20V10M12 20V4M6 20v-6"/> },
              ].map((c, ci) => (
                <div key={ci} className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100 overflow-hidden relative">
                  <div className={clsx("absolute inset-y-0 left-0 w-1 rounded-l-2xl", c.color)} />
                  <div className="pl-2">
                    <div className="mb-5 flex items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: c.iconColor + "18" }}>
                        <svg width="20" height="20" fill="none" stroke={c.iconColor} strokeWidth="2" viewBox="0 0 24 24">{c.icon}</svg>
                      </div>
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-400 leading-tight">{c.label}</span>
                    </div>
                    <div className="text-3xl font-bold text-gray-900 leading-none tabular-nums">{c.val}</div>
                    <div className="mt-3 flex flex-col gap-1.5">
                      <div className="text-sm text-gray-400">{c.sub1}</div>
                      <div className="text-sm text-gray-400">{c.sub2}</div>
                    </div>
                  </div>
                </div>
              ))}
              {/* Accuracy card */}
              <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100 overflow-hidden relative">
                <div className="absolute inset-y-0 left-0 w-1 bg-red-400 rounded-l-2xl" />
                <div className="pl-2">
                  <div className="mb-5 flex items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-400/10">
                      <svg width="20" height="20" fill="none" stroke="#f87171" strokeWidth="2" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>
                    </div>
                    <span className="text-xs font-semibold uppercase tracking-wide text-gray-400 leading-tight">Overall Accuracy</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <AccRing v={kpi.acc} size={60} />
                    <div>
                      <div className="text-base font-semibold text-gray-700 leading-tight">{kpi.acc >= 65 ? "Good" : kpi.acc >= 50 ? "Getting there" : "Needs work"}</div>
                      <div className="text-sm text-gray-400 mt-1">weighted across all answers</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Evolution chart */}
            {(() => {
              // Determine data source and x-labels based on active filter
              type Bar = { label: string; players: number; quizzes: number; correct: number; wrong: number; total: number; acc: number }
              // Built from real per-day session aggregates (every session counts)
              const td: any[] = trend?.days ?? []
              const mkBar = (label: string, rows: any[]): Bar => {
                const correct = rows.reduce((a, r) => a + (r.correct || 0), 0)
                const total = rows.reduce((a, r) => a + (r.total || 0), 0)
                return {
                  label,
                  players: rows.reduce((a, r) => a + (r.players || 0), 0),
                  quizzes: rows.reduce((a, r) => a + (r.sessions || 0), 0),
                  correct, wrong: total - correct, total,
                  acc: total > 0 ? Math.round((correct / total) * 100) : 0,
                }
              }
              const fmtDay = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`
              let bars: Bar[] = []
              let subtitle = ""
              if (pFilter === "week") {
                const start = periodRange.from ? new Date(periodRange.from) : new Date()
                bars = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((nm, i) => {
                  const dt = new Date(start); dt.setDate(dt.getDate() + i)
                  const key = fmtDay(dt)
                  return mkBar(nm, td.filter(r => r.day === key))
                })
                subtitle = `Activity by weekday · ${pLabel}`
              } else if (pFilter === "month") {
                bars = [1, 2, 3, 4, 5].map(w => mkBar(`Wk ${w}`, td.filter(r => {
                  const dayOfMonth = Number((r.day || "").slice(8, 10))
                  return Math.floor((dayOfMonth - 1) / 7) + 1 === w
                }))).filter((b, i) => i < 4 || b.total > 0)
                subtitle = `Weekly breakdown · ${pLabel}`
              } else {
                const mn = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
                const months = [...new Set(td.map(r => (r.day || "").slice(0, 7)))].sort()
                bars = months.map(m => mkBar(`${mn[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`, td.filter(r => (r.day || "").startsWith(m))))
                subtitle = `Monthly activity · ${bars.length} month${bars.length !== 1 ? "s" : ""}`
              }
              const hasAny = bars.some(b => b.total > 0)
              const maxTotal = Math.max(...bars.map(b => b.total), 1)
              const VW = 600, VH = 220, PX = 40, PYT = 24, PYB = 36, GAP = pFilter === "all" && bars.length > 8 ? 3 : 6
              const n = bars.length
              const slotW = n > 0 ? (VW - 2 * PX) / n : 40
              const barW = Math.max(slotW - GAP, 4)
              const chartH = VH - PYT - PYB
              return (
                <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <h3 className="text-base font-semibold text-gray-800">Activity &amp; Accuracy Trend</h3>
                      <p className="text-sm text-gray-400 mt-0.5">{subtitle}</p>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-400">
                      <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-400"/>&nbsp;Correct</span>
                      <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-400"/>&nbsp;Wrong</span>
                      <span className="flex items-center gap-1.5"><span className="inline-block w-6 border-t-2 border-dashed border-amber-400"/>&nbsp;Accuracy %</span>
                    </div>
                  </div>
                  {!hasAny ? (
                    <div className="flex items-center justify-center h-36 text-sm text-gray-400">No activity in this period</div>
                  ) : (
                    <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full" style={{ height: VH }}>
                      {/* Grid lines */}
                      {[0.25, 0.5, 0.75, 1].map(f => {
                        const gy = PYT + (1 - f) * chartH
                        return <line key={f} x1={PX} y1={gy.toFixed(1)} x2={VW - PX} y2={gy.toFixed(1)} stroke="#f1f5f9" strokeWidth="1"/>
                      })}
                      {/* Stacked bars */}
                      {bars.map((b, i) => {
                        const bx = PX + i * slotW + GAP / 2
                        const totalH = Math.max((b.total / maxTotal) * chartH, b.total > 0 ? 3 : 0)
                        const correctH = b.total > 0 ? (b.correct / b.total) * totalH : 0
                        const wrongH = totalH - correctH
                        const barTop = VH - PYB - totalH
                        const hasData = b.total > 0
                        return (
                          <g key={b.label}>
                            {/* Wrong (red, bottom of stacked from top = bar bottom) */}
                            {hasData && wrongH > 0 && <rect x={bx.toFixed(1)} y={(VH - PYB - wrongH).toFixed(1)} width={barW.toFixed(1)} height={wrongH.toFixed(1)} rx="0" fill="#f87171" opacity="0.85"/>}
                            {/* Correct (green, stacked above wrong) */}
                            {hasData && correctH > 0 && <rect x={bx.toFixed(1)} y={barTop.toFixed(1)} width={barW.toFixed(1)} height={correctH.toFixed(1)} rx="0" fill="#4ade80" opacity="0.85"/>}
                            {/* Top cap rounded */}
                            {hasData && totalH >= 6 && <rect x={bx.toFixed(1)} y={barTop.toFixed(1)} width={barW.toFixed(1)} height={Math.min(totalH, 6).toFixed(1)} rx="3" fill={correctH > 0 ? "#4ade80" : "#f87171"} opacity="0.85"/>}
                            {/* Player count label above bar */}
                            {hasData && b.players > 0 && <text x={(bx + barW / 2).toFixed(1)} y={(barTop - 6).toFixed(1)} textAnchor="middle" fontSize="10" fill="#374151" fontWeight="600" fontFamily="inherit">{b.players}</text>}
                            {/* X-axis label */}
                            <text x={(bx + barW / 2).toFixed(1)} y={(VH - 8).toFixed(1)} textAnchor="middle" fontSize={bars.length > 10 ? "9" : "11"} fill={hasData ? "#374151" : "#d1d5db"} fontWeight={hasData ? "500" : "400"} fontFamily="inherit">{b.label}</text>
                            <title>{`${b.label}: ${b.players} players · ${b.quizzes} sessions · ${b.correct} correct · ${b.wrong} wrong · ${b.acc}% acc`}</title>
                          </g>
                        )
                      })}
                      {/* Accuracy % line (amber dashed, separate 0-100 scale) */}
                      {(() => {
                        const activeBars = bars.map((b, i) => ({ ...b, i })).filter(b => b.total > 0)
                        if (activeBars.length < 2) return null
                        const accPath = activeBars.map((b, idx) => {
                          const cx = PX + b.i * slotW + GAP / 2 + barW / 2
                          const cy = PYT + (1 - b.acc / 100) * chartH
                          return `${idx === 0 ? "M" : "L"}${cx.toFixed(1)},${cy.toFixed(1)}`
                        }).join(" ")
                        return (
                          <>
                            <path d={accPath} fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="5 3"/>
                            {activeBars.map((b, idx) => {
                              const cx = PX + b.i * slotW + GAP / 2 + barW / 2
                              const cy = PYT + (1 - b.acc / 100) * chartH
                              return (
                                <g key={`acc-${idx}`}>
                                  <circle cx={cx.toFixed(1)} cy={cy.toFixed(1)} r="3.5" fill="white" stroke="#fbbf24" strokeWidth="2"/>
                                  <text x={cx.toFixed(1)} y={(cy - 8).toFixed(1)} textAnchor="middle" fontSize="9" fill="#d97706" fontWeight="600" fontFamily="inherit">{b.acc}%</text>
                                </g>
                              )
                            })}
                          </>
                        )
                      })()}
                    </svg>
                  )}
                </div>
              )
            })()}

            {/* Weekly engagement — active players + retention */}
            {engagement && engagement.length > 1 && (() => {
              const maxActive = Math.max(...engagement.map((w: any) => w.active), 1)
              const VW = 600, VH = 200, PX = 36, PYT = 26, PYB = 30, GAP = engagement.length > 8 ? 4 : 8
              const chartH = VH - PYT - PYB
              const n = engagement.length
              const slotW = (VW - 2 * PX) / n
              const barW = Math.max(slotW - GAP, 4)
              const retColor = (r: number) => (r >= 70 ? "#16a34a" : r >= 40 ? "#f59e0b" : "#ef4444")
              const withRet = engagement.map((w: any, i: number) => ({ ...w, i })).filter((w: any) => w.retention != null)
              const retPath = withRet.map((w: any, idx: number) => {
                const cx = PX + w.i * slotW + GAP / 2 + barW / 2
                const cy = PYT + (1 - w.retention / 100) * chartH
                return `${idx === 0 ? "M" : "L"}${cx.toFixed(1)},${cy.toFixed(1)}`
              }).join(" ")
              return (
                <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
                  <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <h3 className="text-base font-semibold text-gray-800">Weekly Engagement</h3>
                      <p className="text-sm text-gray-400 mt-0.5">Active players per week · retention = % of previous week&apos;s players who came back</p>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-400">
                      <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-primary/70"/>&nbsp;Active players</span>
                      <span className="flex items-center gap-1.5"><span className="inline-block w-6 border-t-2 border-dashed border-green-500"/>&nbsp;Retention %</span>
                    </div>
                  </div>
                  <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full" style={{ height: VH }}>
                    <defs>
                      <linearGradient id="engBarGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#009edf" stopOpacity="0.9"/>
                        <stop offset="100%" stopColor="#009edf" stopOpacity="0.45"/>
                      </linearGradient>
                    </defs>
                    {/* Grid lines */}
                    {[0.25, 0.5, 0.75, 1].map(f => {
                      const gy = PYT + (1 - f) * chartH
                      return <line key={f} x1={PX} y1={gy.toFixed(1)} x2={VW - PX} y2={gy.toFixed(1)} stroke="#f1f5f9" strokeWidth="1"/>
                    })}
                    {/* Bars */}
                    {engagement.map((w: any, i: number) => {
                      const bx = PX + i * slotW + GAP / 2
                      const h = Math.max((w.active / maxActive) * chartH, w.active > 0 ? 3 : 0)
                      const barTop = VH - PYB - h
                      return (
                        <g key={w.week}>
                          {h > 0 && <rect x={bx.toFixed(1)} y={barTop.toFixed(1)} width={barW.toFixed(1)} height={h.toFixed(1)} rx="4" fill="url(#engBarGrad)"/>}
                          {w.active > 0 && <text x={(bx + barW / 2).toFixed(1)} y={(barTop - 5).toFixed(1)} textAnchor="middle" fontSize="10" fill="#374151" fontWeight="600" fontFamily="inherit">{w.active}</text>}
                          <text x={(bx + barW / 2).toFixed(1)} y={(VH - 8).toFixed(1)} textAnchor="middle" fontSize={n > 10 ? "9" : "10"} fill="#9ca3af" fontWeight="500" fontFamily="inherit">W{(w.week || "").split("-W")[1] || w.week}</text>
                          <title>{`${w.week}: ${w.active} active${w.retention != null ? ` · ${w.retention}% retention` : ""}`}</title>
                        </g>
                      )
                    })}
                    {/* Retention line (green dashed, 0-100 scale) */}
                    {withRet.length >= 2 && <path d={retPath} fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="5 3"/>}
                    {withRet.map((w: any, idx: number) => {
                      const cx = PX + w.i * slotW + GAP / 2 + barW / 2
                      const cy = PYT + (1 - w.retention / 100) * chartH
                      return (
                        <g key={`ret-${idx}`}>
                          <circle cx={cx.toFixed(1)} cy={cy.toFixed(1)} r="3.5" fill="white" stroke={retColor(w.retention)} strokeWidth="2"/>
                          <text x={cx.toFixed(1)} y={(cy - 7).toFixed(1)} textAnchor="middle" fontSize="9" fill={retColor(w.retention)} fontWeight="600" fontFamily="inherit">{w.retention}%</text>
                        </g>
                      )
                    })}
                  </svg>
                </div>
              )
            })()}

            {/* 3-col */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
                <h3 className="mb-5 text-base font-semibold text-gray-800">Accuracy by month</h3>
                <div className="flex flex-col gap-4">
                  {monthly.map(m => (
                    <div key={m.key}>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-sm text-gray-600">{m.label}</span>
                        <span className={clsx("text-sm font-bold", m.acc >= 65 ? "text-green-600" : m.acc >= 50 ? "text-primary" : "text-amber-600")}>{m.acc}%</span>
                      </div>
                      <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                        <div className={clsx("h-full rounded-full", m.acc >= 65 ? "bg-green-500" : m.acc >= 50 ? "bg-primary" : "bg-amber-500")} style={{ width: `${Math.max(m.acc, 2)}%` }}/>
                      </div>
                    </div>
                  ))}
                  {monthly.length === 0 && <p className="text-sm text-gray-400 text-center py-4">No data</p>}
                </div>
              </div>
              <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
                <h3 className="mb-5 text-base font-semibold text-gray-800">Top creators</h3>
                <div className="flex flex-col gap-4">
                  {topCreators.map((c, i) => (
                    <div key={c.name} className="flex items-start gap-3">
                      <div className={clsx("flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white mt-0.5", rc[i] || "bg-gray-300")}>{i + 1}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-700 leading-tight">{c.name}</div>
                        <div className="flex items-center gap-1.5 mt-1">
                          <Tag region={c.region}/>
                          <span className="text-xs text-gray-400">{c.quizzes} quiz{c.quizzes !== 1 ? "zes" : ""}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                  {topCreators.length === 0 && <p className="text-sm text-gray-400 text-center py-4">No data</p>}
                </div>
              </div>
              <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
                <h3 className="mb-5 text-base font-semibold text-gray-800">Categories</h3>
                <div className="flex flex-col gap-4">
                  {categories.slice(0, 6).map(c => (
                    <div key={c.name}>
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <span className="text-sm text-gray-600 leading-tight">{c.name}</span>
                        <span className="text-xs text-gray-400 shrink-0 mt-0.5">{c.played}/{c.count}</span>
                      </div>
                      <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${c.count / maxCC * 100}%` }}/>
                      </div>
                    </div>
                  ))}
                  {categories.length === 0 && <p className="text-sm text-gray-400 text-center py-4">No data</p>}
                </div>
              </div>
            </div>

            {/* By Region */}
            <div className="grid grid-cols-1 gap-4">
              <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
                <p className="mb-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">By Region</p>
                <div className="flex gap-4">
                  {(["BR","MY","CN"] as const).map(reg => {
                    const rs = regionStats[reg]
                    const acc = rs.t > 0 ? Math.round(rs.c / rs.t * 100) : 0
                    return (
                      <div key={reg} className="flex items-center gap-4 rounded-xl border border-gray-100 py-4 px-5 flex-1">
                        <AccRing v={acc} size={64}/>
                        <div>
                          <Tag region={reg}/>
                          <div className="text-2xl font-bold text-gray-900 mt-1.5">{acc}%</div>
                          <div className="text-xs text-gray-400 mt-1">{rs.q} quizzes · {rs.p} players</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* Performance row — Accuracy Breakdown | Player Tiers | Group Performance */}
            <div className="grid grid-cols-3 gap-4">
              {/* Panel A — Accuracy Breakdown */}
              <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
                <h3 className="mb-4 text-base font-semibold text-gray-800">Accuracy Breakdown</h3>
                {metrics.totalAnswers === 0 ? (
                  <div className="flex items-center justify-center py-8 text-sm text-gray-400">No data yet</div>
                ) : (() => {
                  const total = metrics.totalAnswers
                  const correct = metrics.totalCorrect
                  const incorrect = total - correct
                  const r = 50, sw = 10, circ = 2 * Math.PI * r
                  const correctArc = (correct / total) * circ
                  return (
                    <div className="flex flex-col items-center gap-4">
                      <svg width="120" height="120" viewBox="0 0 120 120">
                        <circle cx="60" cy="60" r={r} fill="none" stroke="#f1f5f9" strokeWidth={sw}/>
                        <circle cx="60" cy="60" r={r} fill="none" stroke="#22c55e" strokeWidth={sw}
                          strokeDasharray={`${correctArc.toFixed(2)} ${(circ - correctArc).toFixed(2)}`}
                          strokeLinecap="butt" style={{ transform: "rotate(-90deg)", transformOrigin: "60px 60px" }}/>
                        <circle cx="60" cy="60" r={r} fill="none" stroke="#ef4444" strokeWidth={sw}
                          strokeDasharray={`${(circ - correctArc).toFixed(2)} ${correctArc.toFixed(2)}`}
                          strokeDashoffset={(-correctArc).toFixed(2)}
                          strokeLinecap="butt" style={{ transform: "rotate(-90deg)", transformOrigin: "60px 60px" }}/>
                        <text x="60" y="55" textAnchor="middle" fontSize="14" fontWeight="700" fill="#374151" fontFamily="inherit">{Math.round(correct / total * 100)}%</text>
                        <text x="60" y="70" textAnchor="middle" fontSize="9" fill="#9ca3af" fontFamily="inherit">accuracy</text>
                      </svg>
                      <div className="flex flex-col items-center gap-1.5">
                        <span className="text-sm font-semibold" style={{ color: "#22c55e" }}>{correct.toLocaleString()} correct</span>
                        <span className="text-sm font-semibold" style={{ color: "#ef4444" }}>{incorrect.toLocaleString()} incorrect</span>
                      </div>
                    </div>
                  )
                })()}
              </div>

              {/* Panel B — Player Tiers */}
              <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
                <h3 className="mb-1 text-base font-semibold text-gray-800">Player Tiers</h3>
                <p className="mb-4 text-sm text-gray-400">Accuracy distribution</p>
                {(() => {
                  const tierData = [
                    { label: "≥ 65%", count: playerTiers.green, color: "#22c55e" },
                    { label: "50–64%", count: playerTiers.blue, color: "#009edf" },
                    { label: "35–49%", count: playerTiers.amber, color: "#f59e0b" },
                    { label: "< 35%", count: playerTiers.red, color: "#ef4444" },
                  ]
                  const maxTier = Math.max(...tierData.map(t => t.count), 1)
                  return (
                    <div className="flex flex-col gap-3">
                      {tierData.map(t => (
                        <div key={t.label} className="flex items-center gap-2">
                          <span className="w-14 shrink-0 text-xs font-semibold text-gray-500">{t.label}</span>
                          <div className="flex-1 h-2.5 rounded-full bg-gray-100 overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{ width: `${(t.count / maxTier) * 100}%`, background: t.color }}/>
                          </div>
                          <span className="w-6 shrink-0 text-right text-xs font-bold text-gray-600">{t.count}</span>
                        </div>
                      ))}
                      {(playerTiers.green + playerTiers.blue + playerTiers.amber + playerTiers.red) === 0 && (
                        <p className="text-sm text-gray-400 text-center py-4">No data yet</p>
                      )}
                    </div>
                  )
                })()}
              </div>

              {/* Panel C — Group Performance */}
              <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
                <p className="mb-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">Groups</p>
                <div className="grid grid-cols-3 gap-3">
                  {(["ATP","ATD","Others"] as const).map(g => {
                    const gs = groupStats[g] || { q: 0, p: 0, c: 0, t: 0 }
                    const acc = gs.t > 0 ? Math.round(gs.c / gs.t * 100) : 0
                    const col = GROUP_COLORS[g]
                    return (
                      <div key={g} className="flex flex-col items-center gap-2 rounded-xl border border-gray-100 py-4 px-2">
                        <AccRing v={acc} size={52}/>
                        <span className={clsx("text-[10px] font-bold rounded px-1.5 py-0.5", col.bg, col.text)}>{g}</span>
                        <div className="w-full px-1"><div className="h-1.5 rounded-full bg-gray-100 overflow-hidden"><div className={clsx("h-full rounded-full", col.bar)} style={{ width: `${maxGQ > 0 ? (gs.q / maxGQ) * 100 : 0}%` }}/></div></div>
                        <div className="text-[10px] text-gray-400">{gs.q} quizzes</div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* Hardest Questions — full width */}
            <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
              <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Hardest Questions</p>
                <div className="flex items-center gap-2">
                  <div className="flex rounded-lg overflow-hidden border border-gray-200">
                    {([[7, "7 days"], [30, "30 days"], [90, "90 days"], [0, "All time"]] as const).map(([d, label], i) => (
                      <button key={d} onClick={() => setDiffDays(d)}
                        className={clsx("px-2.5 py-1 text-[10px] font-semibold transition-colors", i > 0 ? "border-l border-gray-200" : "",
                          diffDays === d ? "bg-primary text-white" : "bg-white text-gray-500 hover:bg-gray-50")}>{label}</button>
                    ))}
                  </div>
                  <button onClick={() => setActiveView("question_bank")} className="text-[10px] font-semibold text-primary hover:text-primary/70 transition-colors">Question bank →</button>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                {(diffLoading || diffQuestions === null) && (
                  <div className="flex flex-col items-center justify-center py-6 gap-2">
                    <div className="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                    <p className="text-xs text-gray-400">Loading question data…</p>
                  </div>
                )}
                {!diffLoading && diffQuestions && diffQuestions.slice(0, 5).map((q, i) => {
                  const color = q.errorRate >= 70 ? "#ef4444" : q.errorRate >= 50 ? "#f59e0b" : "#009edf"
                  return (
                    <div key={i} className="rounded-lg border border-gray-100 px-3 py-2.5">
                      <div className="flex items-center gap-3 mb-1.5">
                        <AccRing v={100 - q.errorRate} size={40}/>
                        <span className="flex-1 min-w-0 text-sm text-gray-700 leading-snug line-clamp-2">{q.questionTitle}</span>
                        {q.lastAnswered && <span className="shrink-0 text-[10px] text-gray-400 tabular-nums">{(() => { try { return new Date(q.lastAnswered).toLocaleDateString("en-US", { month: "short", day: "numeric" }) } catch { return "" } })()}</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${q.errorRate}%`, background: color }}/></div>
                        <span className="text-[10px] font-bold tabular-nums" style={{ color }}>{q.errorRate}% error · {q.timesAnswered}×</span>
                      </div>
                    </div>
                  )
                })}
                {!diffLoading && diffQuestions !== null && diffQuestions.length === 0 && <p className="text-sm text-gray-400 text-center py-4">{diffDays > 0 ? `No sessions in the last ${diffDays} days — try a wider period` : "No data yet — play more sessions first"}</p>}
              </div>
            </div>
          </>)}

          {/* ── TOP PLAYERS ───────────────────────────────────────────────── */}
          {activeView === "players" && (
            <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
              <div className="mb-2 flex items-center justify-between flex-wrap gap-3">
                <h3 className="text-base font-semibold text-gray-800">{showBelow50 ? "Players below 50% accuracy" : "Top players"}</h3>
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex rounded-lg overflow-hidden border border-gray-200">
                    {(["avgPts", "avgCorrect", "games"] as const).map((m, mi) => (
                      <button key={m} onClick={() => setTopMetric(m)}
                        className={clsx("px-3 py-1.5 text-xs font-semibold transition-colors", mi > 0 ? "border-l border-gray-200" : "",
                          topMetric === m ? "bg-primary text-white" : "bg-white text-gray-500 hover:bg-gray-50")}>
                        {m === "avgPts" ? "Avg pts" : m === "avgCorrect" ? "Avg correct" : "Total games"}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => setShowBelow50(v => !v)}
                    className={clsx("rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                      showBelow50 ? "bg-red-500 text-white" : "bg-gray-100 text-gray-400 hover:bg-red-50 hover:text-red-500")}>
                    Below 50%
                  </button>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-400">Min games:</span>
                    {[1, 2, 3, 5].map(n => (
                      <button key={n} onClick={() => setMinGames(n)}
                        className={clsx("rounded-full px-2.5 py-1 text-xs font-semibold transition-colors",
                          minGames === n ? "bg-primary text-white" : "bg-gray-100 text-gray-400 hover:bg-gray-200")}>{n}+</button>
                    ))}
                  </div>
                </div>
              </div>
              <p className="mb-5 text-sm text-gray-400">
                {showBelow50 ? `${topPlayers.length} player${topPlayers.length !== 1 ? "s" : ""} with accuracy below 50% · at least 1 game` : `Sorted by ${topMetric === "avgPts" ? "avg points" : topMetric === "avgCorrect" ? "avg correct answers" : "total games played"} · Min ${minGames} ${minGames === 1 ? "game" : "games"}`}
              </p>
              <div className="flex items-center gap-3 border-b border-gray-100 pb-3 mb-1 px-2">
                <TH cls="w-8 text-center">#</TH>
                <TH cls="flex-1">Player</TH>
                <TH cls="w-16 text-center">Games</TH>
                <TH cls="w-20 text-center">{topMetric === "avgPts" ? "Avg pts" : topMetric === "avgCorrect" ? "Avg cor" : "Total pts"}</TH>
                <TH cls="w-36 text-right">Accuracy</TH>
              </div>
              {topPlayers.map((p, i) => (
                <div key={p.name + i} className={clsx("flex items-center gap-3 py-3 border-b border-gray-50 last:border-0 rounded-xl px-2", !showBelow50 && i < 3 ? "bg-amber-50/40" : "hover:bg-gray-50")}>
                  <div className="w-8 shrink-0 text-center">
                    {!showBelow50 && i < 3 ? <span className="text-base">{["🥇","🥈","🥉"][i]}</span> : <span className={clsx("inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white", rc[i] || "bg-gray-300")}>{i+1}</span>}
                  </div>
                  <span className="flex-1 min-w-0 text-sm font-medium text-gray-700 truncate">{p.name}</span>
                  <span className="w-16 shrink-0 text-center text-sm text-gray-500">{p.games}</span>
                  <span className="w-20 shrink-0 text-center text-sm font-bold text-gray-700">{topMetric === "avgPts" ? p.avgPts : topMetric === "avgCorrect" ? p.avgCorrect : p.totalPts}</span>
                  <div className="w-36 shrink-0 flex justify-end"><AccBar v={p.acc}/></div>
                </div>
              ))}
              {topPlayers.length === 0 && <p className="text-sm text-gray-400 text-center py-8">{showBelow50 ? "No players below 50% accuracy found" : `No players with ${minGames}+ games yet`}</p>}
            </div>
          )}

          {/* ── LEADERBOARD ───────────────────────────────────────────────── */}
          {activeView === "leaderboard" && (
            <div className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-6 pt-4 pb-3 border-b border-gray-100">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-gray-800">Leaderboard — Top 10</h3>
                    <p className="text-sm text-gray-400 mt-1">{pLabel}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="flex rounded-lg overflow-hidden border border-gray-200">
                      <button onClick={() => setWeeklyTab("region")} className={clsx("px-3 py-1.5 text-xs font-semibold transition-colors", weeklyTab === "region" ? "bg-primary text-white" : "bg-white text-gray-500 hover:bg-gray-50")}>By Region</button>
                      <button onClick={() => setWeeklyTab("group")} className={clsx("px-3 py-1.5 text-xs font-semibold transition-colors border-l border-gray-200", weeklyTab === "group" ? "bg-primary text-white" : "bg-white text-gray-500 hover:bg-gray-50")}>By Group</button>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-400">Min:</span>
                      {[1,2,3,5].map(n => <button key={n} onClick={() => setMinGames(n)} className={clsx("rounded-full px-2.5 py-1 text-xs font-semibold transition-colors", minGames === n ? "bg-primary text-white" : "bg-gray-100 text-gray-400 hover:bg-gray-200")}>{n}+</button>)}
                    </div>
                  </div>
                </div>
              </div>

              {weeklyTab === "region" && (
                <div className="p-4 flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => setRankingCats([])} className={clsx("rounded-full px-3 py-1.5 text-xs font-semibold transition-colors", rankingCats.length === 0 ? "bg-primary text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200")}>All categories</button>
                    {allCategories.map(cat => <button key={cat} onClick={() => toggleRankingCat(cat)} className={clsx("rounded-full px-3 py-1.5 text-xs font-semibold transition-colors", rankingCats.includes(cat) ? "bg-primary text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200")}>{cat}</button>)}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {(["BR", "MY", "CN"] as const).map(region => (
                      <div key={region} className="rounded-xl border border-gray-100 overflow-hidden" style={{ borderTop: `3px solid ${region === "BR" ? "#16a34a" : region === "MY" ? "#2563eb" : "#dc2626"}` }}>
                        <div className="px-4 py-2 flex items-center gap-2 bg-gray-50/60 border-b border-gray-100">
                          <Tag region={region}/><span className="text-sm font-semibold text-gray-700">Top 10</span><span className="ml-auto text-xs text-gray-400">Score · Avg</span>
                        </div>
                        {(weeklyTop[region] || []).length === 0 ? <div className="py-10 text-sm text-gray-400 text-center">No games in this period</div> : (
                          <div className="px-3 py-2">
                            <div className="flex items-center gap-2 pb-2 border-b border-gray-100 mb-1">
                              <TH cls="w-8 text-center">#</TH><TH cls="flex-1">Player</TH><TH cls="w-10 text-center">G</TH><TH cls="w-20 text-right">Score</TH><TH cls="w-14 text-right">Acc</TH>
                            </div>
                            {(weeklyTop[region] || []).map((p: any, i: number) => (
                              <div key={i} className={clsx("flex items-center gap-2 py-1.5 border-b border-gray-50 last:border-0 rounded-lg", i < 3 ? "bg-amber-50/50 px-1" : "px-1 hover:bg-gray-50")}>
                                <div className="w-8 shrink-0 text-center text-sm leading-none">{i < 3 ? ["🥇","🥈","🥉"][i] : <span className="text-xs text-gray-400 font-semibold">{i+1}</span>}</div>
                                <div className="flex-1 min-w-0">
                                  <div className="text-[13px] font-medium text-gray-700 truncate">{p.name}</div>
                                  {p.nicknames.length > 0 && <div className="text-xs text-gray-400 truncate">aka {p.nicknames[0]}</div>}
                                </div>
                                <div className="w-10 shrink-0 text-center text-sm text-gray-500">{p.games}</div>
                                <div className="w-20 shrink-0 text-right"><span className="text-[13px] font-bold text-gray-800 tabular-nums">{p.totalPts}</span><span className="block text-[10px] text-gray-400 tabular-nums">{p.avgPts}/game</span></div>
                                <div className="w-16 shrink-0 flex justify-end"><AccBadge v={p.acc}/></div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {weeklyTab === "group" && (
                <div className="p-4 flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => setRankingGroups([])} className={clsx("rounded-full px-3 py-1.5 text-xs font-semibold transition-colors", rankingGroups.length === 0 ? "bg-primary text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200")}>All groups</button>
                    {(["ATP","ATD","Others"] as const).map(g => <button key={g} onClick={() => toggleRankingGroup(g)} className={clsx("rounded-full px-3 py-1.5 text-xs font-semibold transition-colors", rankingGroups.includes(g) ? "bg-primary text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200")}>{g}</button>)}
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {(["ATP","ATD","Others"] as const).map(g => {
                      const col = GROUP_COLORS[g]
                      return (
                        <div key={g} className="rounded-xl border border-gray-100 overflow-hidden" style={{ borderTop: `3px solid ${col.border}` }}>
                          <div className="px-4 py-2 flex items-center gap-2 bg-gray-50/60 border-b border-gray-100">
                            <GroupTag group={g}/><span className="text-sm font-semibold text-gray-700">Top 10</span><span className="ml-auto text-xs text-gray-400">Pts</span>
                          </div>
                          {(weeklyTopByGroup[g] || []).length === 0 ? <div className="py-10 text-sm text-gray-400 text-center">No games in this period</div> : (
                            <div className="px-3 py-2">
                              <div className="flex items-center gap-2 pb-2 border-b border-gray-100 mb-1">
                                <TH cls="w-7 text-center">#</TH><TH cls="flex-1">Player</TH><TH cls="w-10 text-center">G</TH><TH cls="w-20 text-right">Score</TH><TH cls="w-14 text-right">Acc</TH>
                              </div>
                              {(weeklyTopByGroup[g] || []).map((p: any, i: number) => (
                                <div key={i} className={clsx("flex items-center gap-2 py-1.5 border-b border-gray-50 last:border-0 rounded-lg", i < 3 ? "bg-amber-50/50 px-1" : "px-1 hover:bg-gray-50")}>
                                  <div className="w-7 shrink-0 text-center text-sm leading-none">{i < 3 ? ["🥇","🥈","🥉"][i] : <span className="text-xs text-gray-400 font-semibold">{i+1}</span>}</div>
                                  <div className="flex-1 min-w-0">
                                    <div className="text-[13px] font-medium text-gray-700 truncate">{p.name}</div>
                                    {p.nicknames.length > 0 && <div className="text-xs text-gray-400 truncate">{p.nicknames[0]}</div>}
                                  </div>
                                  <div className="w-10 shrink-0 text-center text-sm text-gray-500">{p.games}</div><div className="w-20 shrink-0 text-right"><span className="text-[13px] font-bold text-gray-800 tabular-nums">{p.totalPts}</span><span className="block text-[10px] text-gray-400 tabular-nums">{p.avgPts}/game</span></div>
                                  <div className="w-14 shrink-0 flex justify-end"><AccBadge v={p.acc}/></div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── PARTICIPATION BY DAY ──────────────────────────────────────── */}
          {activeView === "participation" && (<div className="flex flex-col gap-5">
            <div className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-6 pt-4 pb-3 border-b border-gray-100">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-gray-800">Participation by {participationMode}</h3>
                    <p className="text-sm text-gray-400 mt-1">
                      {participationMode === "day"
                        ? "Who took part on a specific date, and how many times"
                        : "Who took part over the whole month, and how many sessions each played"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="flex rounded-lg overflow-hidden border border-gray-200">
                      {(["day","month"] as const).map((m, mi) => (
                        <button key={m} onClick={() => setParticipationMode(m)}
                          className={clsx("px-3 py-1.5 text-xs font-semibold transition-colors", mi > 0 ? "border-l border-gray-200" : "",
                            participationMode === m ? "bg-primary text-white" : "bg-white text-gray-500 hover:bg-gray-50")}>
                          {m === "day" ? "Day" : "Month"}
                        </button>
                      ))}
                    </div>

                    {participationMode === "day" ? (
                      <input type="date" value={participationDate} onChange={e => setParticipationDate(e.target.value)}
                        className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-600 outline-none focus:border-primary bg-white"/>
                    ) : (
                      <input type="month" value={participationMonth} onChange={e => setParticipationMonth(e.target.value)}
                        className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-600 outline-none focus:border-primary bg-white"/>
                    )}

                    <button onClick={() => setParticipationShowAll(v => !v)}
                      disabled={participationRegion !== "all"}
                      title={participationRegion !== "all"
                        ? "Only without a region filter: someone who did not play has no quiz, so no region either"
                        : "Include everyone who has ever signed in, even with zero sessions"}
                      className={clsx("px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors",
                        participationRegion !== "all" ? "border-gray-200 bg-white text-gray-300 cursor-not-allowed"
                        : participationShowAll ? "border-primary bg-primary text-white"
                        : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50")}>
                      Show all users
                    </button>

                    <div className="flex rounded-lg overflow-hidden border border-gray-200">
                      {(["count","pts","name"] as const).map((s, si) => (
                        <button key={s} onClick={() => setParticipationSort(s)}
                          className={clsx("px-3 py-1.5 text-xs font-semibold transition-colors", si > 0 ? "border-l border-gray-200" : "",
                            participationSort === s ? "bg-primary text-white" : "bg-white text-gray-500 hover:bg-gray-50")}>
                          {s === "count" ? "Sessions" : s === "pts" ? "Points" : "Name"}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              {!participationPeriod ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                  <svg width="40" height="40" fill="none" stroke="#d1d5db" strokeWidth="1.5" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                  <span className="text-sm font-medium text-gray-500">Pick a {participationMode} to view participation</span>
                  <span className="text-sm text-gray-400">See each player's session count and performance for that {participationMode}</span>
                  {participationMode === "month" && participationMeta.months.length > 0 && (
                    <div className="flex gap-1.5 flex-wrap justify-center mt-1">
                      {participationMeta.months.slice(0, 6).map(m => (
                        <button key={m} onClick={() => setParticipationMonth(m)}
                          className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-500 hover:bg-gray-50">{m}</button>
                      ))}
                    </div>
                  )}
                </div>
              ) : dayParticipation.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 gap-2">
                  <span className="text-sm font-medium text-gray-500">No sessions in this {participationMode}</span>
                  <span className="text-sm text-gray-400">Try another {participationMode} or change the region filter</span>
                </div>
              ) : (
                <div className="p-6">
                  <div className="mb-4 flex items-center gap-3">
                    <span className="text-sm font-semibold text-primary bg-primary/8 rounded-full px-3 py-1">{dayParticipation.length} player{dayParticipation.length !== 1 ? "s" : ""}</span>
                    <span className="text-sm text-gray-400">· {participationMeta.sessions} session{participationMeta.sessions !== 1 ? "s" : ""} held</span>
                    <span className="text-sm text-gray-400">· {dayParticipation.reduce((a, p) => a + p.count, 0)} entries</span>
                    {participationShowAll && (() => {
                      const zero = dayParticipation.filter(p => p.count === 0).length
                      return <span className={clsx("text-sm font-semibold rounded-full px-3 py-1", zero ? "text-red-600 bg-red-50" : "text-green-700 bg-green-50")}>
                        {zero} did not take part
                      </span>
                    })()}
                    {participationRegion !== "all" && <Tag region={participationRegion}/>}
                  </div>
                  <div className="flex items-center gap-3 border-b border-gray-100 pb-3 mb-1 px-2">
                    <TH cls="w-8 text-center">#</TH><TH cls="flex-1">Player</TH><TH cls="w-24 text-center">Sessions</TH><TH cls="w-20 text-center">Avg pts</TH><TH cls="w-36 text-right">Accuracy</TH>
                  </div>
                  <div style={{ maxHeight: "520px", overflowY: "auto" }}>
                    {dayParticipation.map((p, i) => (
                      <div key={i} className="flex items-center gap-3 py-3 border-b border-gray-50 last:border-0 rounded-xl px-2 hover:bg-gray-50">
                        <div className="w-8 shrink-0 text-center">
                          {i < 3 ? <span className="text-base">{["🥇","🥈","🥉"][i]}</span> : <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-xs font-bold text-gray-500">{i+1}</span>}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium text-gray-700 truncate">{p.name}</div>
                          {p.quizzes.length > 0 && <div className="text-xs text-gray-400 truncate mt-0.5">{p.quizzes.slice(0,2).join(" · ")}{p.quizzes.length > 2 ? ` +${p.quizzes.length-2}` : ""}</div>}
                        </div>
                        <div className="w-24 shrink-0 flex justify-center">
                          <span className={clsx("inline-flex items-center justify-center rounded-full px-3 py-0.5 text-sm font-bold",
                            p.count >= 3 ? "bg-green-100 text-green-700" : p.count >= 2 ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600")}>
                            {p.count}×
                          </span>
                        </div>
                        <div className="w-20 shrink-0 text-center text-sm font-bold text-gray-700">{p.avgPts}</div>
                        <div className="w-36 shrink-0 flex justify-end"><AccBar v={p.acc}/></div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Non-participants — LDAP-known players with no games in the period */}
            <div className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-6 pt-4 pb-3 border-b border-gray-100 flex items-center justify-between flex-wrap gap-3">
                <div>
                  <h3 className="text-base font-semibold text-gray-800">Didn&apos;t play — {pLabel}</h3>
                  <p className="text-sm text-gray-400 mt-1">Known players with no classic or solo activity in the selected period</p>
                </div>
                <div className="flex items-center gap-2">
                  {nonParticipants && (
                    <span className="rounded-full bg-red-50 px-3 py-1 text-sm font-semibold text-red-500">{nonParticipants.length} player{nonParticipants.length !== 1 ? "s" : ""}</span>
                  )}
                  <button
                    onClick={() => nonParticipants && downloadCsv("non-participants.csv", nonParticipants.map((r: any) => ({ player: r.real_name, last_classic: r.last_classic || "never", last_solo: r.last_solo || "never" })))}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-500 hover:text-primary hover:border-primary/40 transition-colors">
                    Export CSV
                  </button>
                </div>
              </div>
              <div className="p-6">
                {!nonParticipants ? (
                  <p className="text-sm text-gray-400 text-center py-6">Loading…</p>
                ) : nonParticipants.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-6">Everyone played in this period 🎉</p>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2" style={{ maxHeight: 320, overflowY: "auto" }}>
                    {nonParticipants.map((r: any) => {
                      const last = r.last_classic || r.last_solo
                      const ago = last ? (() => { try { const days = Math.floor((Date.now() - new Date(last).getTime()) / 86400000); return days === 0 ? "today" : `${days}d ago` } catch { return "" } })() : null
                      return (
                        <div key={r.real_name} className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2">
                          <span className="truncate text-[13px] font-medium text-gray-700">{r.real_name}</span>
                          <span className={clsx("shrink-0 text-[10px] font-semibold", ago ? "text-gray-400" : "text-red-400")}>{ago ? `last ${ago}` : "never played"}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>)}


          {/* ── SOLO GAMES ────────────────────────────────────────────────── */}
          {(activeView === "solo") && (
            <div className="flex flex-col gap-5">
              <div className="flex items-center justify-between">
                <div/>
                <button onClick={() => { setSoloReport(null); fetchSoloReport(periodRange) }}
                  disabled={soloLoading}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-400 hover:text-primary hover:bg-primary/5 transition-colors disabled:opacity-40">
                  <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
                  Refresh
                </button>
              </div>
              {soloLoading && <div className="text-center py-12 text-sm text-gray-400">Loading solo data…</div>}
              {soloReport && !soloReport.ok && <div className="rounded-2xl bg-red-50 px-6 py-4 text-sm text-red-600">Failed to load: {(soloReport as any).error}</div>}
              {soloReport && soloReport.ok && (() => {
                const qs = soloReport.quizStats
                const psAll = soloReport.playerStats
                const det = soloReport.detail
                const totalAttempts = qs.reduce((s, q) => s + q.total_attempts, 0)
                const uniquePlayers = psAll.length
                const avgAcc = psAll.length > 0 ? Math.round(psAll.reduce((s, p) => s + p.avg_accuracy, 0) / psAll.length) : 0
                const q2 = soloSearch.trim().toLowerCase()
                const dir = soloSort.dir === "asc" ? 1 : -1
                const ps = [...(q2 ? psAll.filter(p => (p.real_name || "").toLowerCase().includes(q2)) : psAll)].sort((a, b) => {
                  switch (soloSort.key) {
                    case "name":     return dir * a.real_name.localeCompare(b.real_name)
                    case "attempts": return dir * (a.total_attempts - b.total_attempts)
                    case "quizzes":  return dir * (a.quizzes_played - b.quizzes_played)
                    case "correct":  return dir * (a.total_correct - b.total_correct)
                    case "points":   return dir * ((a.best_points || 0) - (b.best_points || 0))
                    default:         return dir * ((a.avg_accuracy - b.avg_accuracy) || (a.total_correct - b.total_correct))
                  }
                })
                return (<>
                  {/* KPI cards */}
                  <div className="grid grid-cols-3 gap-4">
                    {[
                      { label: "Total Attempts", val: totalAttempts, icon: "#009edf", stroke: <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 12h6M9 16h4"/>, col: "bg-primary" },
                      { label: "Active Players", val: uniquePlayers, icon: "#22c55e", stroke: <><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></>, col: "bg-green-500" },
                      { label: "Avg Accuracy", val: `${avgAcc}%`, icon: "#f59e0b", stroke: <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>, col: "bg-amber-400" },
                    ].map((c, ci) => (
                      <div key={ci} className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100 relative overflow-hidden">
                        <div className={clsx("absolute inset-y-0 left-0 w-1 rounded-l-2xl", c.col)} />
                        <div className="pl-2">
                          <div className="mb-4 flex items-center gap-3">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: c.icon + "18" }}>
                              <svg width="20" height="20" fill="none" stroke={c.icon} strokeWidth="2" viewBox="0 0 24 24">{c.stroke}</svg>
                            </div>
                            <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">{c.label}</span>
                          </div>
                          <div className="text-3xl font-bold text-gray-900 tabular-nums">{c.val}</div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Quiz breakdown */}
                  <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
                    <h3 className="mb-4 text-base font-semibold text-gray-800">By Quiz</h3>
                    {qs.length === 0 ? (
                      <p className="text-sm text-gray-400 text-center py-8">No solo attempts yet</p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <div className="grid gap-3 px-3 pb-2 text-[10px] font-bold uppercase tracking-widest text-gray-400" style={{ gridTemplateColumns: "1fr 80px 80px 120px 100px" }}>
                          <span>Quiz</span><span className="text-center">Players</span><span className="text-center">Attempts</span><span>Accuracy</span><span>Last played</span>
                        </div>
                        {qs.map(q => {
                          const acc = Math.round(q.avg_accuracy || 0)
                          const color = acc >= 65 ? "#22c55e" : acc >= 50 ? "#009edf" : acc >= 35 ? "#f59e0b" : "#ef4444"
                          const ago = q.last_played ? (() => { try { const d = new Date(q.last_played); const diff = Date.now() - d.getTime(); const days = Math.floor(diff/86400000); return days === 0 ? "Today" : days === 1 ? "Yesterday" : `${days}d ago` } catch { return "" } })() : ""
                          return (
                            // A linha leva ao relatorio do quiz ja aberto na
                            // pratica solo. Esta tela responde "quanto se
                            // praticou"; o relatorio responde "o que erraram",
                            // pergunta por pergunta — e nao havia caminho de
                            // uma para a outra.
                            <div key={q.quiz_id}
                                 onClick={() => router.push(`/reports/${(q.quiz_id || "").replace(".json", "")}?session=solo:all`)}
                                 title="Abrir o relatório desta prática solo"
                                 className="grid gap-3 items-center rounded-xl px-3 py-3 hover:bg-gray-50 transition-colors cursor-pointer" style={{ gridTemplateColumns: "1fr 80px 80px 120px 100px" }}>
                              <span className="text-sm font-medium text-primary truncate" title={q.quiz_title}>{q.quiz_title}</span>
                              <span className="text-sm font-bold text-gray-700 text-center tabular-nums">{q.unique_players}</span>
                              <span className="text-sm font-bold text-gray-700 text-center tabular-nums">{q.total_attempts}</span>
                              <div className="flex items-center gap-2">
                                <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                                  <div className="h-full rounded-full" style={{ width: `${Math.max(acc,2)}%`, background: color }} />
                                </div>
                                <span className="text-xs font-bold w-10 text-right" style={{ color }}>{acc}%</span>
                              </div>
                              <span className="text-xs text-gray-400">{ago}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* Player breakdown */}
                  <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
                    <div className="mb-4 flex items-center justify-between flex-wrap gap-3">
                      <h3 className="text-base font-semibold text-gray-800">By Player</h3>
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          value={soloSearch}
                          onChange={e => setSoloSearch(e.target.value)}
                          placeholder="Search players..."
                          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 outline-none focus:border-primary bg-white w-44"
                        />
                        <button
                          onClick={() => downloadCsv("solo-players.csv", ps.map(p => ({ player: p.real_name, quizzes: p.quizzes_played, attempts: p.total_attempts, correct: p.total_correct, best_points: p.best_points ?? 0, accuracy_pct: Math.round(p.avg_accuracy || 0) })))}
                          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-500 hover:text-primary hover:border-primary/40 transition-colors">
                          Export CSV
                        </button>
                        {/* O export acima agrega por pessoa e responde "quem foi
                            bem". Este desce ate a PERGUNTA e responde "o que o
                            time erra", que e a leitura que muda o treinamento. */}
                        <button
                          onClick={() => {
                            ;(socket as any)?.timeout(20000).emit("manager:getSoloAnswers", {}, (err: any, r: any) => {
                              if (err || !r?.ok || !r.rows?.length) {
                                alert("No per-question data yet.")
                                return
                              }
                              downloadCsv("solo-answers.csv", r.rows)
                            })
                          }}
                          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-500 hover:text-primary hover:border-primary/40 transition-colors">
                          Export answers
                        </button>
                      </div>
                    </div>
                    {ps.length === 0 ? (
                      <p className="text-sm text-gray-400 text-center py-8">{q2 ? "No players match your search" : "No solo attempts yet"}</p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <div className="grid gap-3 px-3 pb-2" style={{ gridTemplateColumns: "1fr 60px 70px 60px 70px 110px 24px" }}>
                          <SortableTH label="Player" k="name" sort={soloSort} onSort={setSoloSort} defaultDir="asc" />
                          <SortableTH label="Quizzes" k="quizzes" sort={soloSort} onSort={setSoloSort} cls="justify-center" />
                          <SortableTH label="Attempts" k="attempts" sort={soloSort} onSort={setSoloSort} cls="justify-center" />
                          <SortableTH label="Correct" k="correct" sort={soloSort} onSort={setSoloSort} cls="justify-center" />
                          <SortableTH label="Best pts" k="points" sort={soloSort} onSort={setSoloSort} cls="justify-center" />
                          <SortableTH label="Accuracy" k="acc" sort={soloSort} onSort={setSoloSort} />
                          <span/>
                        </div>
                        {ps.map(p => {
                          const acc = Math.round(p.avg_accuracy || 0)
                          const color = acc >= 65 ? "#22c55e" : acc >= 50 ? "#009edf" : acc >= 35 ? "#f59e0b" : "#ef4444"
                          const isExp = soloExpandedPlayer === p.real_name
                          const pDetail = det.filter(d => d.real_name === p.real_name)
                          return (
                            <div key={p.real_name} className="rounded-xl overflow-hidden border border-transparent hover:border-gray-200 transition-all">
                              <div className="grid gap-3 items-center px-3 py-3 cursor-pointer hover:bg-gray-50"
                                style={{ gridTemplateColumns: "1fr 60px 70px 60px 70px 110px 24px" }}
                                onClick={() => { setSoloExpandedPlayer(isExp ? null : p.real_name); if (!isExp) fetchPlayerTrend(p.real_name) }}>
                                <span className="text-sm font-semibold text-gray-700 truncate">{p.real_name}</span>
                                <span className="text-sm text-gray-700 text-center tabular-nums">{p.quizzes_played}</span>
                                <span className="text-sm text-gray-700 text-center tabular-nums">{p.total_attempts}</span>
                                <span className="text-sm text-gray-700 text-center tabular-nums">{p.total_correct}</span>
                                <span className="text-sm font-bold text-gray-700 text-center tabular-nums">{p.best_points ?? 0}</span>
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                                    <div className="h-full rounded-full" style={{ width: `${Math.max(acc,2)}%`, background: color }} />
                                  </div>
                                  <span className="text-xs font-bold w-10 text-right" style={{ color }}>{acc}%</span>
                                </div>
                                <svg width="14" height="14" fill="none" stroke="#cbd5e1" strokeWidth="2.5" viewBox="0 0 24 24" className={clsx("shrink-0 transition-transform", isExp && "rotate-90")}><path d="M9 18l6-6-6-6"/></svg>
                              </div>
                              {isExp && pDetail.length > 0 && (
                                <div className="border-t border-gray-100 bg-gray-50 px-5 py-3 flex flex-col gap-1.5">
                                  <TrendSparkline rows={playerTrends[p.real_name]?.solo} label="attempts" />
                                  <div className="grid gap-3 pb-1.5 pt-1 text-[9px] font-bold uppercase tracking-widest text-gray-400" style={{ gridTemplateColumns: "1fr 60px 60px 90px" }}>
                                    <span>Quiz</span><span className="text-center">Tries</span><span className="text-center">Best score</span><span>Best accuracy</span>
                                  </div>
                                  {pDetail.map(d => {
                                    const da = Math.round(d.best_accuracy || 0)
                                    const dc = da >= 65 ? "#22c55e" : da >= 50 ? "#009edf" : da >= 35 ? "#f59e0b" : "#ef4444"
                                    return (
                                      <div key={d.quiz_id} className="grid gap-3 items-center rounded-lg px-3 py-2 bg-white border border-gray-100" style={{ gridTemplateColumns: "1fr 60px 60px 90px" }}>
                                        <span className="text-xs font-medium text-gray-600 truncate" title={d.quiz_title}>{d.quiz_title}</span>
                                        <span className="text-xs text-gray-500 text-center tabular-nums">{d.attempts}</span>
                                        <span className="text-xs font-bold text-gray-700 text-center tabular-nums">{d.best_points}</span>
                                        <span className="text-xs font-bold" style={{ color: dc }}>{da}%</span>
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </>)
              })()}
            </div>
          )}


          {/* ── TEAM GAMES ────────────────────────────────────────────────── */}
          {(activeView === "team_games") && (
            <div className="flex flex-col gap-5">
              <div className="flex items-center justify-between">
                <div/>
                <button onClick={() => { setSoloReport(null); fetchSoloReport(periodRange) }}
                  disabled={soloLoading}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-400 hover:text-primary hover:bg-primary/5 transition-colors disabled:opacity-40">
                  <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
                  Refresh
                </button>
              </div>
              {soloLoading && <div className="text-center py-12 text-sm text-gray-400">Loading classic data…</div>}
              {soloReport && !soloReport.ok && <div className="rounded-2xl bg-red-50 px-6 py-4 text-sm text-red-600">Failed to load: {(soloReport as any).error}</div>}
              {soloReport && soloReport.ok && (() => {
                const qs = soloReport.teamQuizStats ?? []
                const psAll = soloReport.teamStats ?? []
                const det = soloReport.teamDetail ?? []
                const totalSessions = qs.reduce((s, q) => s + q.total_sessions, 0)
                const uniquePlayers = psAll.length
                const avgAcc = psAll.length > 0 ? Math.round(psAll.reduce((s, p) => s + p.avg_accuracy, 0) / psAll.length) : 0
                const q2 = teamSearch.trim().toLowerCase()
                const dir = teamSort.dir === "asc" ? 1 : -1
                const ps = [...(q2 ? psAll.filter(p => (p.real_name || "").toLowerCase().includes(q2)) : psAll)].sort((a, b) => {
                  switch (teamSort.key) {
                    case "name":    return dir * a.real_name.localeCompare(b.real_name)
                    case "games":   return dir * (a.games_played - b.games_played)
                    case "rank":    return dir * (a.avg_rank - b.avg_rank)
                    case "correct": return dir * (a.total_correct - b.total_correct)
                    case "points":  return dir * ((a.best_points || 0) - (b.best_points || 0))
                    default:        return dir * ((a.avg_accuracy - b.avg_accuracy) || (a.total_correct - b.total_correct))
                  }
                })
                return (<>
                  {/* KPI cards */}
                  <div className="grid grid-cols-3 gap-4">
                    {[
                      { label: "Total Sessions", val: totalSessions, icon: "#009edf", stroke: <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 7a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>, col: "bg-primary" },
                      { label: "Active Players", val: uniquePlayers, icon: "#22c55e", stroke: <><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></>, col: "bg-green-500" },
                      { label: "Avg Accuracy", val: `${avgAcc}%`, icon: "#f59e0b", stroke: <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>, col: "bg-amber-400" },
                    ].map((c, ci) => (
                      <div key={ci} className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100 relative overflow-hidden">
                        <div className={clsx("absolute inset-y-0 left-0 w-1 rounded-l-2xl", c.col)} />
                        <div className="pl-2">
                          <div className="mb-4 flex items-center gap-3">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: c.icon + "18" }}>
                              <svg width="20" height="20" fill="none" stroke={c.icon} strokeWidth="2" viewBox="0 0 24 24">{c.stroke}</svg>
                            </div>
                            <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">{c.label}</span>
                          </div>
                          <div className="text-3xl font-bold text-gray-900 tabular-nums">{c.val}</div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Quiz breakdown */}
                  <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
                    <h3 className="mb-4 text-base font-semibold text-gray-800">By Quiz</h3>
                    {qs.length === 0 ? (
                      <p className="text-sm text-gray-400 text-center py-8">No classic sessions yet</p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <div className="grid gap-3 px-3 pb-2 text-[10px] font-bold uppercase tracking-widest text-gray-400" style={{ gridTemplateColumns: "1fr 80px 80px 120px 100px" }}>
                          <span>Quiz</span><span className="text-center">Players</span><span className="text-center">Sessions</span><span>Accuracy</span><span>Last played</span>
                        </div>
                        {qs.map(q => {
                          const acc = Math.round(q.avg_accuracy || 0)
                          const color = acc >= 65 ? "#22c55e" : acc >= 50 ? "#009edf" : acc >= 35 ? "#f59e0b" : "#ef4444"
                          const ago = q.last_played ? (() => { try { const d = new Date(q.last_played); const diff = Date.now() - d.getTime(); const days = Math.floor(diff/86400000); return days === 0 ? "Today" : days === 1 ? "Yesterday" : `${days}d ago` } catch { return "" } })() : ""
                          return (
                            <div key={q.quiz_id} className="grid gap-3 items-center rounded-xl px-3 py-3 hover:bg-gray-50 transition-colors" style={{ gridTemplateColumns: "1fr 80px 80px 120px 100px" }}>
                              <span className="text-sm font-medium text-gray-700 truncate" title={q.quiz_title}>{q.quiz_title}</span>
                              <span className="text-sm font-bold text-gray-700 text-center tabular-nums">{q.unique_players}</span>
                              <span className="text-sm font-bold text-gray-700 text-center tabular-nums">{q.total_sessions}</span>
                              <div className="flex items-center gap-2">
                                <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                                  <div className="h-full rounded-full" style={{ width: `${Math.max(acc,2)}%`, background: color }} />
                                </div>
                                <span className="text-xs font-bold w-10 text-right" style={{ color }}>{acc}%</span>
                              </div>
                              <span className="text-xs text-gray-400">{ago}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* Player breakdown */}
                  <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
                    <div className="mb-4 flex items-center justify-between flex-wrap gap-3">
                      <h3 className="text-base font-semibold text-gray-800">By Player</h3>
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          value={teamSearch}
                          onChange={e => setTeamSearch(e.target.value)}
                          placeholder="Search players..."
                          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 outline-none focus:border-primary bg-white w-44"
                        />
                        <button
                          onClick={() => downloadCsv("classic-players.csv", ps.map(p => ({ player: p.real_name, games: p.games_played, avg_rank: Math.round(p.avg_rank || 0), correct: p.total_correct, best_points: p.best_points ?? 0, accuracy_pct: Math.round(p.avg_accuracy || 0) })))}
                          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-500 hover:text-primary hover:border-primary/40 transition-colors">
                          Export CSV
                        </button>
                      </div>
                    </div>
                    {ps.length === 0 ? (
                      <p className="text-sm text-gray-400 text-center py-8">{q2 ? "No players match your search" : "No classic sessions yet"}</p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <div className="grid gap-3 px-3 pb-2" style={{ gridTemplateColumns: "1fr 60px 70px 60px 70px 110px 24px" }}>
                          <SortableTH label="Player" k="name" sort={teamSort} onSort={setTeamSort} defaultDir="asc" />
                          <SortableTH label="Games" k="games" sort={teamSort} onSort={setTeamSort} cls="justify-center" />
                          <SortableTH label="Avg rank" k="rank" sort={teamSort} onSort={setTeamSort} cls="justify-center" defaultDir="asc" />
                          <SortableTH label="Correct" k="correct" sort={teamSort} onSort={setTeamSort} cls="justify-center" />
                          <SortableTH label="Best pts" k="points" sort={teamSort} onSort={setTeamSort} cls="justify-center" />
                          <SortableTH label="Accuracy" k="acc" sort={teamSort} onSort={setTeamSort} />
                          <span/>
                        </div>
                        {ps.map(p => {
                          const acc = Math.round(p.avg_accuracy || 0)
                          const color = acc >= 65 ? "#22c55e" : acc >= 50 ? "#009edf" : acc >= 35 ? "#f59e0b" : "#ef4444"
                          const isExp = teamExpandedPlayer === p.real_name
                          const pDetail = det.filter(d => d.real_name === p.real_name)
                          return (
                            <div key={p.real_name} className="rounded-xl overflow-hidden border border-transparent hover:border-gray-200 transition-all">
                              <div className="grid gap-3 items-center px-3 py-3 cursor-pointer hover:bg-gray-50"
                                style={{ gridTemplateColumns: "1fr 60px 70px 60px 70px 110px 24px" }}
                                onClick={() => { setTeamExpandedPlayer(isExp ? null : p.real_name); if (!isExp) fetchPlayerTrend(p.real_name) }}>
                                <span className="text-sm font-semibold text-gray-700 truncate">{p.real_name}</span>
                                <span className="text-sm text-gray-700 text-center tabular-nums">{p.games_played}</span>
                                <span className="text-sm text-gray-700 text-center tabular-nums">#{Math.round(p.avg_rank)}</span>
                                <span className="text-sm text-gray-700 text-center tabular-nums">{p.total_correct}</span>
                                <span className="text-sm font-bold text-gray-700 text-center tabular-nums">{p.best_points ?? 0}</span>
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                                    <div className="h-full rounded-full" style={{ width: `${Math.max(acc,2)}%`, background: color }} />
                                  </div>
                                  <span className="text-xs font-bold w-10 text-right" style={{ color }}>{acc}%</span>
                                </div>
                                <svg width="14" height="14" fill="none" stroke="#cbd5e1" strokeWidth="2.5" viewBox="0 0 24 24" className={clsx("shrink-0 transition-transform", isExp && "rotate-90")}><path d="M9 18l6-6-6-6"/></svg>
                              </div>
                              {isExp && pDetail.length > 0 && (
                                <div className="border-t border-gray-100 bg-gray-50 px-5 py-3 flex flex-col gap-1.5">
                                  <TrendSparkline rows={playerTrends[p.real_name]?.classic} label="sessions" />
                                  <div className="grid gap-3 pb-1.5 pt-1 text-[9px] font-bold uppercase tracking-widest text-gray-400" style={{ gridTemplateColumns: "1fr 60px 60px 60px 90px" }}>
                                    <span>Quiz</span><span className="text-center">Sessions</span><span className="text-center">Best rank</span><span className="text-center">Correct</span><span>Accuracy</span>
                                  </div>
                                  {pDetail.map(d => {
                                    const da = Math.round(d.avg_accuracy || 0)
                                    const dc = da >= 65 ? "#22c55e" : da >= 50 ? "#009edf" : da >= 35 ? "#f59e0b" : "#ef4444"
                                    return (
                                      <div key={d.quiz_id} className="grid gap-3 items-center rounded-lg px-3 py-2 bg-white border border-gray-100" style={{ gridTemplateColumns: "1fr 60px 60px 60px 90px" }}>
                                        <span className="text-xs font-medium text-gray-600 truncate" title={d.quiz_title}>{d.quiz_title}</span>
                                        <span className="text-xs text-gray-500 text-center tabular-nums">{d.sessions}</span>
                                        <span className="text-xs font-bold text-gray-700 text-center">#{d.best_rank}</span>
                                        <span className="text-xs text-gray-700 text-center tabular-nums">{d.total_correct}</span>
                                        <span className="text-xs font-bold" style={{ color: dc }}>{da}%</span>
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </>)
              })()}
            </div>
          )}

          {/* ── COMBINED (All Players) ─────────────────────────────────────── */}
          {(activeView === "combined") && (
            <div className="flex flex-col gap-5">
              {soloLoading && <div className="text-center py-12 text-sm text-gray-400">Loading…</div>}
              {!soloLoading && (() => {
                const cq = combinedSearch.trim().toLowerCase()
                const rows = combinedRows
                  .filter(r => !cq || r.name.toLowerCase().includes(cq))
                  .filter(r => !combinedMinGames || (r.team_games + r.solo_games) >= 3)

                const cDir = combinedSort.dir === "asc" ? 1 : -1
                const sorted = [...rows].sort((a, b) => {
                  switch (combinedSort.key) {
                    case "name":       return cDir * a.name.localeCompare(b.name)
                    case "solo_acc":   return cDir * (a.solo_acc - b.solo_acc)
                    case "solo_games": return cDir * (a.solo_games - b.solo_games)
                    case "team_games": return cDir * (a.team_games - b.team_games)
                    default:           return cDir * (a.team_acc - b.team_acc)
                  }
                })

                return (
                  <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
                    <div className="mb-4 flex items-center justify-between flex-wrap gap-3">
                      <h3 className="text-base font-semibold text-gray-800">All Players — Classic &amp; Solo</h3>
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          value={combinedSearch}
                          onChange={e => setCombinedSearch(e.target.value)}
                          placeholder="Search players..."
                          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 outline-none focus:border-primary bg-white w-44"
                        />
                        <label className={clsx("flex cursor-pointer select-none items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors",
                          combinedMinGames ? "border-primary/40 bg-primary/5 text-primary" : "border-gray-200 bg-white text-gray-500 hover:text-gray-700")}
                          title="Hide players with fewer than 3 games — single-game 100% scores distort accuracy rankings">
                          <input type="checkbox" checked={combinedMinGames} onChange={e => setCombinedMinGames(e.target.checked)} className="h-3 w-3 accent-primary" />
                          ≥ 3 games
                        </label>
                        <button
                          onClick={() => downloadCsv("all-players.csv", sorted.map(r => ({ player: r.name, classic_games: r.team_games, classic_accuracy_pct: Math.round(r.team_acc), solo_attempts: r.solo_games, solo_accuracy_pct: Math.round(r.solo_acc) })))}
                          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-500 hover:text-primary hover:border-primary/40 transition-colors">
                          Export CSV
                        </button>
                      </div>
                    </div>

                    {sorted.length === 0 ? (
                      <p className="text-sm text-gray-400 text-center py-8">No data yet</p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <div className="grid gap-2 px-3 pb-2"
                          style={{ gridTemplateColumns: "1fr repeat(2, 130px) repeat(2, 80px)" }}>
                          <SortableTH label="Player" k="name" sort={combinedSort} onSort={setCombinedSort} defaultDir="asc" />
                          <SortableTH label="Classic accuracy" k="team_acc" sort={combinedSort} onSort={setCombinedSort} />
                          <SortableTH label="Solo accuracy" k="solo_acc" sort={combinedSort} onSort={setCombinedSort} />
                          <SortableTH label="Classic games" k="team_games" sort={combinedSort} onSort={setCombinedSort} cls="justify-center" />
                          <SortableTH label="Solo" k="solo_games" sort={combinedSort} onSort={setCombinedSort} cls="justify-center" />
                        </div>
                        {sorted.map(r => {
                          const ta = Math.round(r.team_acc), sa = Math.round(r.solo_acc)
                          const tc = ta >= 65 ? "#22c55e" : ta >= 50 ? "#009edf" : ta >= 35 ? "#f59e0b" : ta > 0 ? "#ef4444" : "#d1d5db"
                          const sc = sa >= 65 ? "#22c55e" : sa >= 50 ? "#009edf" : sa >= 35 ? "#f59e0b" : sa > 0 ? "#ef4444" : "#d1d5db"
                          return (
                            <div key={r.name} className="grid gap-2 items-center rounded-xl px-3 py-3 hover:bg-gray-50 transition-colors"
                              style={{ gridTemplateColumns: "1fr repeat(2, 130px) repeat(2, 80px)" }}>
                              <span className="text-sm font-semibold text-gray-700 truncate">{r.name}</span>
                              <div className="flex items-center gap-2">
                                {r.team_games > 0 ? (<>
                                  <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                                    <div className="h-full rounded-full" style={{ width: `${Math.max(ta,2)}%`, background: tc }} />
                                  </div>
                                  <span className="text-xs font-bold w-9 text-right" style={{ color: tc }}>{ta}%</span>
                                </>) : <span className="text-xs text-gray-300">—</span>}
                              </div>
                              <div className="flex items-center gap-2">
                                {r.solo_games > 0 ? (<>
                                  <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                                    <div className="h-full rounded-full" style={{ width: `${Math.max(sa,2)}%`, background: sc }} />
                                  </div>
                                  <span className="text-xs font-bold w-9 text-right" style={{ color: sc }}>{sa}%</span>
                                </>) : <span className="text-xs text-gray-300">—</span>}
                              </div>
                              <span className={clsx("text-sm tabular-nums text-center font-semibold", r.team_games > 0 ? "text-gray-700" : "text-gray-300")}>{r.team_games > 0 ? r.team_games : "—"}</span>
                              <span className={clsx("text-sm tabular-nums text-center font-semibold", r.solo_games > 0 ? "text-gray-700" : "text-gray-300")}>{r.solo_games > 0 ? r.solo_games : "—"}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
          )}

          {/* ── RECENT ACTIVITY ───────────────────────────────────────────── */}
          {activeView === "activity" && (
            <div className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100">
              <h3 className="mb-5 text-base font-semibold text-gray-800">Recent activity</h3>
              <div className="flex flex-col gap-2.5">
                {recent.map((s, i) => {
                  const cancelled = localCancelled[s.id] || []
                  const isExpanded = expandedSession === s.sessionId
                  return (
                    <div key={i} className="rounded-xl overflow-hidden border border-transparent hover:border-gray-200 transition-all bg-gray-50">
                      <div className="flex items-center gap-3 px-4 py-4">
                        <div className="flex flex-1 min-w-0 items-center gap-3 cursor-pointer" onClick={() => router.push(`/reports/${(s.id || "").replace(".json", "")}`)}>
                          <AccRing v={s.acc} size={48}/>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-semibold text-gray-700">{s.subject}</span>
                              <GroupTag group={s.group}/>
                              {cancelled.length > 0 && <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-xs font-bold text-red-600">{cancelled.length} cancelled</span>}
                            </div>
                            <div className="text-sm text-gray-400 mt-1">{s.lastPlayedAt?.split(",")[0]?.trim() || "--"} · {s.createdBy} · {s.playerCount} players</div>
                          </div>
                          <Tag region={s.region}/>
                          <svg width="14" height="14" fill="none" stroke="#cbd5e1" strokeWidth="2.5" viewBox="0 0 24 24" className="shrink-0"><path d="M9 18l6-6-6-6"/></svg>
                        </div>
                        <button onClick={() => setExpandedSession(isExpanded ? null : s.sessionId)}
                          className={clsx("shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                            cancelled.length > 0 ? "bg-red-100 text-red-700 hover:bg-red-200" : isExpanded ? "bg-primary/10 text-primary" : "bg-gray-200 text-gray-500 hover:bg-gray-300")}>
                          {isExpanded ? "▲ Close" : `Questions${cancelled.length > 0 ? ` (${cancelled.length}✕)` : ""}`}
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="border-t border-gray-100 bg-white px-5 py-4">
                          <p className="mb-3 text-sm text-gray-400">Flag questions as cancelled — data is kept but marked as invalid for scoring.</p>
                          {(s.questions || []).map((q: any, qi: number) => {
                            const isCancelled = cancelled.includes(qi)
                            return (
                              <div key={qi} className={clsx("flex items-center justify-between rounded-lg px-3 py-2.5 mb-1.5 last:mb-0", isCancelled ? "bg-red-50" : "hover:bg-gray-50")}>
                                <span className={clsx("flex-1 text-sm", isCancelled ? "line-through text-gray-400" : "text-gray-700")}>
                                  <span className="mr-2 font-bold text-gray-400">{qi+1}.</span>
                                  {q.question}
                                  {isCancelled && <span className="ml-2 rounded bg-red-200 px-1.5 py-0.5 text-xs font-bold text-red-700">CANCELLED</span>}
                                </span>
                                <button onClick={() => toggleCancelQuestion(s.id, qi)}
                                  className={clsx("ml-4 shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                                    isCancelled ? "bg-red-100 text-red-600 hover:bg-red-200" : "bg-gray-100 text-gray-500 hover:bg-red-50 hover:text-red-600")}>
                                  {isCancelled ? "Restore" : "Cancel Q"}
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
                {recent.length === 0 && <p className="text-sm text-gray-400 text-center py-12">No sessions played yet</p>}
              </div>
            </div>
          )}

          {/* ── QUESTION BANK ─────────────────────────────────────────────── */}
          {activeView === "question_bank" && (
            <div className="flex flex-col gap-5">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <h3 className="text-base font-semibold text-gray-800">Question Bank</h3>
                  <p className="text-sm text-gray-400 mt-1">Most-missed questions — select to build a review quiz</p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex rounded-lg overflow-hidden border border-gray-200">
                    {([[7, "7 days"], [30, "30 days"], [90, "90 days"], [0, "All time"]] as const).map(([d, label], i) => (
                      <button key={d} onClick={() => setDiffDays(d)}
                        className={clsx("px-3 py-1 text-xs font-semibold transition-colors", i > 0 ? "border-l border-gray-200" : "",
                          diffDays === d ? "bg-primary text-white" : "bg-white text-gray-500 hover:bg-gray-50")}>{label}</button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-400">Min error:</span>
                    {[0, 30, 50, 70].map(n => (
                      <button key={n} onClick={() => setBankMinError(n)}
                        className={clsx("rounded-full px-2.5 py-1 text-xs font-semibold transition-colors",
                          bankMinError === n ? "bg-primary text-white" : "bg-gray-100 text-gray-400 hover:bg-gray-200")}>{n}%+</button>
                    ))}
                  </div>
                  <button onClick={() => { setDiffQuestions(null); fetchDiffQuestions() }} disabled={diffLoading}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-400 hover:text-primary hover:bg-primary/5 transition-colors disabled:opacity-40">
                    <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
                    Refresh
                  </button>
                </div>
              </div>

              {diffLoading && <div className="text-center py-12 text-sm text-gray-400">Loading questions…</div>}

              {diffQuestions && (() => {
                const filtered_dq = diffQuestions.filter(q => q.errorRate >= bankMinError)
                const allSelected = filtered_dq.length > 0 && filtered_dq.every(q => bankSelected.has(q.questionTitle))
                return (
                  <div className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
                    {/* Save bar */}
                    {bankSelected.size > 0 && (
                      <div className="px-5 py-3 border-b border-gray-100 bg-primary/5 flex items-center gap-3 flex-wrap">
                        <span className="text-sm font-semibold text-primary">{bankSelected.size} question{bankSelected.size !== 1 ? "s" : ""} selected</span>
                        <input value={bankTitle} onChange={e => setBankTitle(e.target.value)}
                          className="flex-1 min-w-40 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 outline-none focus:border-primary"
                          placeholder="Nome do quiz" />
                        <button onClick={saveBankQuiz} disabled={bankSaving}
                          className="rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50 hover:bg-primary/90 transition-colors">
                          {bankSaving ? "Saving…" : "Create Quiz"}
                        </button>
                        <button onClick={() => setBankSelected(new Set())} className="text-sm text-gray-400 hover:text-gray-600 transition-colors">Clear</button>
                      </div>
                    )}
                    {bankSaved && (
                      <div className="px-5 py-2.5 bg-green-50 border-b border-green-100 text-sm text-green-700 font-medium flex items-center gap-2">
                        <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                        Quiz saved: <span className="font-bold">{bankSaved}</span>
                        <button onClick={() => setBankSaved(null)} className="ml-auto text-green-400 hover:text-green-600">✕</button>
                      </div>
                    )}
                    {/* Header */}
                    <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50/60 flex items-center gap-3">
                      <input type="checkbox" checked={allSelected} onChange={() => {
                        if (allSelected) setBankSelected(prev => { const n = new Set(prev); filtered_dq.forEach(q => n.delete(q.questionTitle)); return n })
                        else setBankSelected(prev => { const n = new Set(prev); filtered_dq.forEach(q => n.add(q.questionTitle)); return n })
                      }} className="w-4 h-4 rounded border-gray-300 accent-primary cursor-pointer" />
                      <span className="flex-1 text-[10px] font-bold uppercase tracking-widest text-gray-400">Question</span>
                      <span className="w-20 text-[10px] font-bold uppercase tracking-widest text-gray-400 text-center">Last seen</span>
                      <span className="w-20 text-[10px] font-bold uppercase tracking-widest text-gray-400 text-center">Answered</span>
                      <span className="w-16 text-[10px] font-bold uppercase tracking-widest text-gray-400 text-center">Errors</span>
                      <span className="w-24 text-[10px] font-bold uppercase tracking-widest text-gray-400 text-right">Error rate</span>
                    </div>

                    {filtered_dq.length === 0 ? (
                      <div className="py-16 text-center text-sm text-gray-400">No questions with {bankMinError}%+ error rate yet</div>
                    ) : (
                      <div style={{ maxHeight: "600px", overflowY: "auto" }}>
                        {filtered_dq.map((q, i) => {
                          const sel = bankSelected.has(q.questionTitle)
                          const color = q.errorRate >= 70 ? "#ef4444" : q.errorRate >= 50 ? "#f59e0b" : q.errorRate >= 30 ? "#009edf" : "#22c55e"
                          return (
                            <div key={i} onClick={() => setBankSelected(prev => { const n = new Set(prev); sel ? n.delete(q.questionTitle) : n.add(q.questionTitle); return n })}
                              className={clsx("flex items-center gap-3 px-4 py-3 border-b border-gray-50 last:border-0 cursor-pointer transition-colors", sel ? "bg-primary/5" : "hover:bg-gray-50")}>
                              <input type="checkbox" checked={sel} readOnly className="w-4 h-4 rounded border-gray-300 accent-primary pointer-events-none shrink-0" />
                              <span className="flex-1 min-w-0 text-sm text-gray-700 leading-snug">{q.questionTitle}</span>
                              <span className="w-20 shrink-0 text-center text-xs tabular-nums text-gray-400">{q.lastAnswered ? (() => { try { return new Date(q.lastAnswered).toLocaleDateString("en-US", { month: "short", day: "numeric" }) } catch { return "—" } })() : "—"}</span>
                              <span className="w-20 shrink-0 text-center text-sm tabular-nums text-gray-500">{q.timesAnswered}×</span>
                              <span className="w-16 shrink-0 text-center text-sm tabular-nums text-gray-500">{q.timesWrong}×</span>
                              <div className="w-24 shrink-0 flex items-center justify-end gap-1.5">
                                <div className="w-12 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                                  <div className="h-full rounded-full" style={{ width: `${q.errorRate}%`, background: color }} />
                                </div>
                                <span className="text-xs font-bold w-8 text-right tabular-nums" style={{ color }}>{q.errorRate}%</span>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
          )}

        </div>
      </div>


    </div>
  )
}

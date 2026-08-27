"use client"
import { abbreviateName } from "@rahoot/web/utils/abbreviateName"
import { STATUS } from "@rahoot/common/types/game/status"

import Button from "@rahoot/web/components/Button"
import Input from "@rahoot/web/components/Input"
import TierBadge from "@rahoot/web/components/profile/TierBadge"
import XpBar from "@rahoot/web/components/profile/XpBar"
import { useEvent, useSocket } from "@rahoot/web/contexts/socketProvider"
import { usePlayerStore } from "@rahoot/web/stores/player"
import { useSearchParams, useRouter } from "next/navigation"
import AvatarDisplay from "@rahoot/web/components/profile/AvatarDisplay"
import Link from "next/link"
import { KeyboardEvent, useCallback, useEffect, useRef, useState } from "react"

const STORAGE_KEY = "rahoot_v2_name"
const KEEP_KEY    = "rahoot_keep_logged"
const AVATAR_KEY  = "rahoot_avatar_cfg"
const FAV_3D_KEY  = "rahoot_avatar_3d_id"

type TierId = "bronze" | "silver" | "gold" | "platinum" | "mythic"

type ProfilePayload = {
  player: {
    realName: string
    username: string
    avatarKind?: "dicebear" | "3d"
    avatar3dId?: string | null
    avatar3d?: { id: string; icon: string; vrm: string; displayName: string } | null
  } | null
  progression: {
    xp: number
    level: number
    tier: TierId
    xpIntoLevel: number
    xpNeededForNext: number
    pct: number
    longestStreak: number
    gamesPlayed: number
    perfectGames: number
    totalCorrect: number
    totalAnswered: number
  } | null
  recentSessions: Array<{
    sessionId: string
    quizId: string
    quizTitle: string
    /** "classic" | "solo" | "team" — so o solo tem revisao por pergunta. */
    mode: string
    startedAt: string
    rank: number
    points: number
    correct: number
    incorrect: number
    unanswered: number
    xpGained: number
  }>
  monthly: { rank: number | null; points: number; games: number } | null
  weekly: { rank: number | null; points: number; games: number } | null
  modeStats?: {
    classic: { games: number; points: number; correct: number; answered: number }
    solo:    { games: number; points: number; correct: number; answered: number }
    team:    { games: number; points: number; correct: number; answered: number }
  }
  badges: Array<{ id: string; label: string; description: string; emoji: string; category: string; unlockedAt: string }>
  catalog: Array<{ id: string; label: string; description: string; emoji: string; category: string }>
}

function getStoredName(): string {
  try {
    const s = sessionStorage.getItem(STORAGE_KEY)
    if (s) return s
    if (localStorage.getItem(KEEP_KEY) === "1") return localStorage.getItem(STORAGE_KEY) || ""
    return ""
  } catch { return "" }
}
function saveStoredName(name: string, keep: boolean): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, name)
    if (keep) { localStorage.setItem(STORAGE_KEY, name); localStorage.setItem(KEEP_KEY, "1") }
    else       { localStorage.removeItem(STORAGE_KEY);    localStorage.removeItem(KEEP_KEY) }
  } catch {}
}
function clearStoredName(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(KEEP_KEY)
  } catch {}
}

type AvatarCfg = {
  seed?: string; skin?: string; hair?: string; hairColor?: string
  accessory?: string; hijabColor?: string; hijabExpr?: string; bsExpr?: string
  useAvatar?: boolean
}

const buildAvatarUrlFromCfg = (c: AvatarCfg): string => {
  if (c.useAvatar === false) return ""
  const seed = c.seed || "guest"
  const skin = c.skin || "f2d3b1"
  const hair = c.hair || "shortHair"
  const hairColor = c.hairColor || "2c1b18"
  const accessory = c.accessory || "none"
  if (accessory === "hijab") {
    const hijabColor = c.hijabColor || "1a3c5e"
    const expr = (c.hijabExpr || "smile")
    const map: Record<string, { eyes: string; mouth: string }> = {
      smile: { eyes: "happy", mouth: "smile" },
      default: { eyes: "default", mouth: "default" },
      serious: { eyes: "default", mouth: "serious" },
      wink: { eyes: "wink", mouth: "twinkle" },
      surprised: { eyes: "surprised", mouth: "disbelief" },
      shy: { eyes: "squint", mouth: "smile" },
      sad: { eyes: "cry", mouth: "sad" },
      cool: { eyes: "hearts", mouth: "twinkle" },
    }
    const e = map[expr] || map.smile
    return `/api/avatar?style=avataaars&seed=${encodeURIComponent(seed)}&skin=${skin}&hijabColor=${hijabColor}&mouth=${e.mouth}&eyes=${e.eyes}`
  }
  const bsExpr = c.bsExpr || "cheery"
  let url = `/api/avatar?style=bigSmile&seed=${encodeURIComponent(seed)}&skin=${skin}&hair=${hair}&hairColor=${hairColor}&eyes=${bsExpr}`
  if (accessory !== "none") url += `&acc=${accessory}`
  return url
}

const getStoredAvatarUrl = (): string => {
  try {
    const fav3d = localStorage.getItem(FAV_3D_KEY)
    if (fav3d) return `/api/avatar3d/r3/icons/${fav3d}.png`
    const raw = localStorage.getItem(AVATAR_KEY)
    if (!raw) return ""
    const cfg = JSON.parse(raw) as AvatarCfg
    return buildAvatarUrlFromCfg(cfg)
  } catch { return "" }
}

const PlayerHomeCard = () => {
  const { socket, isConnected } = useSocket()
  const { join, login, setStatus } = usePlayerStore()
  const router = useRouter()
  const pendingGameIdRef = useRef<string | null>(null)
  const searchParams = useSearchParams()
  const hasAutoJoinedRef = useRef(false)

  const [storedName, setStoredName] = useState<string | null>(null)  // null = loading
  const [registerName, setRegisterName] = useState("")
  const [profile, setProfile] = useState<ProfilePayload | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)

  // Revisao de uma tentativa solo. Fica no cartao mesmo, e nao numa pagina
  // propria: quem quer conferir o que errou esta olhando o proprio historico
  // naquele instante, e tirar a pessoa da tela para isso e perder o contexto.
  const [review, setReview] = useState<any>(null)
  const [reviewLoading, setReviewLoading] = useState<string | null>(null)
  const [pinMode, setPinMode] = useState(false)
  const [pin, setPin] = useState("")
  const [expanded, setExpanded] = useState(false)  // show recent games

  const [avatarUrl, setAvatarUrl] = useState("")
  const [ldapUser, setLdapUser]       = useState("")
  const [ldapPass, setLdapPass]       = useState("")
  const [keepLoggedIn, setKeepLoggedIn] = useState(false)
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError]     = useState("")

  // Load from localStorage on mount
  useEffect(() => {
    const n = getStoredName()
    setStoredName(n)
    setAvatarUrl(getStoredAvatarUrl())
  }, [])

  // Auto-join if ?pin=XXXXXX in URL (Moodle embed, direct link)
  useEffect(() => {
    const pinCode = searchParams.get("pin")
    if (!isConnected || !pinCode || hasAutoJoinedRef.current) return
    socket?.emit("player:join", pinCode)
    hasAutoJoinedRef.current = true
  }, [searchParams, isConnected, socket])

  // Fetch profile when socket is connected and we have a stored name
  useEffect(() => {
    if (!socket || !isConnected || !storedName) return
    setProfileLoading(true)
    ;(socket as any).emit("player:getProfile", { realName: storedName })
  }, [socket, isConnected, storedName])

  useEvent("game:successRoom" as any, (gId: string) => {
    const name = getStoredName()
    if (name) {
      const url = getStoredAvatarUrl()
      pendingGameIdRef.current = gId
      ;(socket as any)?.emit("player:login", {
        gameId: gId,
        data: { username: abbreviateName(name), realName: name, avatarUrl: url },
      })
    } else {
      join(gId)
    }
  })

  useEvent("game:successJoin" as any, (gId: string) => {
    if (!pendingGameIdRef.current) return
    const name = getStoredName()
    try { sessionStorage.removeItem("rahoot_streak") } catch {}
    join(pendingGameIdRef.current)
    login(abbreviateName(name || ""))
    setStatus(STATUS.WAIT as any, { text: "Waiting for the game to start..." } as any)
    pendingGameIdRef.current = null
    router.replace(`/game/${gId}`)
  })

  // Custom profile handler (not in typed events yet)
  useEffect(() => {
    if (!socket) return
    const handler = (data: ProfilePayload) => {
      setProfile(data)
      setProfileLoading(false)
    }
    ;(socket as any).on("player:profile", handler)
    return () => { (socket as any).off("player:profile", handler) }
  }, [socket])

  const handleRegister = useCallback(() => {
    const n = registerName.trim()
    if (!n) return
    saveStoredName(n, false)
    setStoredName(n)
  }, [registerName])

  const handleJoin = useCallback(() => {
    const code = pin.trim()
    if (!code) return
    socket?.emit("player:join", code)
  }, [pin, socket])

  const onEnter = (fn: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter") fn()
  }

  // ── Loading shell ─────────────────────────────────────────
  if (storedName === null) {
    return <div className="card-3d z-10 h-40 w-full max-w-sm rounded-2xl bg-white/60 animate-pulse" />
  }

  // ── First-time user: LDAP login ───────────────────────────
  if (!storedName) {
    const handleLdapAuth = () => {
      if (!ldapUser.trim() || !ldapPass.trim()) return
      if (!socket || !isConnected) { setAuthError("Not connected — please wait and try again."); return }
      setAuthLoading(true)
      setAuthError("")
      ;(socket as any).timeout(12000).emit("player:ldapAuth", { username: ldapUser.trim(), password: ldapPass },
        (err: any, result: any) => {
          setAuthLoading(false)
          if (err) { setAuthError("Request timed out. Check your connection."); return }
          if (result?.ok) {
            saveStoredName(result.fullName, keepLoggedIn)
            setStoredName(result.fullName)
            setAvatarUrl(getStoredAvatarUrl())
          } else {
            setAuthError(result?.error || "Authentication failed")
            setLdapPass("")
          }
        }
      )
    }
    return (
      <div className="card-3d z-10 flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-white p-6">
        <div>
          <h2 className="text-lg font-bold text-gray-800">Welcome!</h2>
          <p className="text-sm text-gray-400">Sign in with your network credentials.</p>
        </div>
        <div className="flex flex-col gap-2">
          <Input
            value={ldapUser}
            onChange={(e) => setLdapUser(e.target.value)}
            onKeyDown={onEnter(handleLdapAuth)}
            placeholder="Username"
            maxLength={40}
            autoFocus
            disabled={authLoading}
          />
          <input
            type="password"
            value={ldapPass}
            onChange={(e) => setLdapPass(e.target.value)}
            onKeyDown={onEnter(handleLdapAuth)}
            placeholder="Password"
            maxLength={80}
            disabled={authLoading}
            className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
          />
          <label className="flex cursor-pointer items-center gap-2 select-none">
            <input
              type="checkbox"
              checked={keepLoggedIn}
              onChange={e => setKeepLoggedIn(e.target.checked)}
              disabled={authLoading}
              className="h-4 w-4 rounded border-gray-300 text-primary accent-primary"
            />
            <span className="text-xs text-gray-500">Keep me signed in</span>
          </label>
        </div>
        {authError && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600">{authError}</p>
        )}
        <Button onClick={handleLdapAuth} disabled={authLoading}>
          {authLoading ? "Signing in…" : "Continue"}
        </Button>
      </div>
    )
  }

  // ── Returning user: full profile card ─────────────────────
  const prog = profile?.progression
  const tier: TierId = (prog?.tier as TierId) || "bronze"
  const level = prog?.level ?? 1
  const xpIntoLevel = prog?.xpIntoLevel ?? 0
  const xpNeededForNext = prog?.xpNeededForNext ?? 100
  const pct = prog?.pct ?? 0
  const gamesPlayed = prog?.gamesPlayed ?? 0
  const perfectGames = prog?.perfectGames ?? 0
  const longestStreak = prog?.longestStreak ?? 0
  const totalCorrect = prog?.totalCorrect ?? 0
  const accuracy = prog && prog.totalAnswered > 0
    ? Math.round((prog.totalCorrect / prog.totalAnswered) * 100)
    : 0

  const is3d = profile?.player?.avatarKind === "3d" && !!profile?.player?.avatar3dId
  const effectiveAvatarUrl = is3d
    ? (profile?.player?.avatar3d
        ? `/api/avatar3d/${profile.player.avatar3d.icon}`
        : `/api/avatar3d/r3/icons/${profile!.player!.avatar3dId}.png`)
    : avatarUrl

  const monthlyRank = profile?.monthly?.rank ?? null
  const weeklyRank = profile?.weekly?.rank ?? null

  const vrmPath = is3d ? (profile?.player?.avatar3d?.vrm ?? null) : null

  return (
    <div className="card-3d z-10 flex w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white">

      {/* ── Avatar stage (full-bleed, no padding) ───────────────────────────── */}
      <div
        className="relative shrink-0"
        style={{ height: 290, background: "linear-gradient(180deg, #eef4f8 0%, #f8fafc 60%, #ffffff 100%)" }}
      >
        {/* Radial glow behind avatar */}
        <div className="pointer-events-none absolute inset-0"
          style={{ background: "radial-gradient(ellipse 60% 55% at 50% 70%, rgba(0,158,223,0.09) 0%, transparent 100%)" }} />
        <AvatarDisplay
          is3d={is3d}
          vrmPath={vrmPath}
          avatarUrl={is3d ? undefined : avatarUrl}
          name={storedName}
        />
        {/* Not you? overlay */}
        <button
          onClick={() => { clearStoredName(); setStoredName(""); setProfile(null); setLdapUser(""); setLdapPass(""); setAuthError(""); setKeepLoggedIn(false) }}
          className="absolute right-3 top-3 rounded-full bg-white/75 px-2.5 py-1 text-[10px] font-semibold text-gray-400 shadow-sm backdrop-blur-sm transition-colors hover:bg-white hover:text-primary"
          title="Switch user"
        >
          Not you?
        </button>
      </div>

      {/* ── Profile content ─────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3.5 px-5 pb-5 pt-4">

        {/* Name + Tier + Edit avatar */}
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-bold text-gray-800">{abbreviateName(storedName)}</p>
            <div className="mt-0.5"><TierBadge tier={tier} level={level} size="sm" /></div>
          </div>
          <Link
            href="/avatar"
            className="btn-action flex shrink-0 items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-2 text-[11px] font-semibold text-primary hover:bg-primary/15"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
            </svg>
            Edit avatar
          </Link>
        </div>

        {/* XP bar */}
        <div className="rounded-xl bg-gradient-to-b from-gray-50 to-white p-3 ring-1 ring-gray-100">
          {profileLoading && !profile ? (
            <div className="h-6 w-full animate-pulse rounded bg-gray-100" />
          ) : (
            <XpBar level={level} tier={tier} xp={prog?.xp ?? 0} xpIntoLevel={xpIntoLevel} xpNeededForNext={xpNeededForNext} pct={pct} />
          )}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-4 gap-2">
          <Stat label="Games"    value={gamesPlayed} />
          <Stat label="Perfect"  value={perfectGames} highlight={perfectGames > 0} />
          <Stat label="Streak"   value={longestStreak} />
          <Stat label="Accuracy" value={`${accuracy}%`} />
        </div>

        {/* Per-mode breakdown */}
        {profile?.modeStats && (
          <div className="grid grid-cols-3 gap-2">
            <ModePill label="Classic" games={profile.modeStats.classic.games} points={profile.modeStats.classic.points} tone="primary" />
            <ModePill label="Solo"    games={profile.modeStats.solo.games}    points={profile.modeStats.solo.points}    tone="emerald" />
            <ModePill label="Team"    games={profile.modeStats.team.games}    points={profile.modeStats.team.points}    tone="gray" disabled />
          </div>
        )}

        {/* Rank strip */}
        <Link
          href="/ranking"
          className="flex items-center justify-between rounded-xl bg-primary/5 px-3 py-2.5 ring-1 ring-primary/10 transition hover:bg-primary/10 hover:ring-primary/30"
        >
          <div className="text-[11px] font-semibold text-primary/80">
            {weeklyRank ? <>Week: <span className="font-bold">#{weeklyRank}</span></> : <>No weekly ranking</>}
          </div>
          <div className="text-[11px] font-semibold text-primary/80">
            {monthlyRank ? <>Month: <span className="font-bold">#{monthlyRank}</span></> : <>No monthly ranking</>}
          </div>
          <div className="text-[11px] font-bold text-primary/70">Ranking →</div>
        </Link>

        {/* Badges shelf */}
        {profile && profile.catalog && profile.catalog.length > 0 && (
          <BadgeShelf earned={profile.badges} catalog={profile.catalog} />
        )}

        {/* Action: Enter PIN */}
        {!pinMode ? (
          <div className="flex flex-col gap-2.5">
            <Button onClick={() => setPinMode(true)}>
              <span className="flex items-center justify-center gap-2">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M8 5v14l11-7z"/>
                </svg>
                Join a game
              </span>
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setExpanded(e => !e)}
                className="btn-action flex items-center justify-center gap-1.5 rounded-lg bg-gray-100 px-3 py-2.5 text-[12px] font-semibold text-gray-600 hover:bg-gray-200"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
                {expanded ? "Hide history" : "History"}
              </button>
              <Link
                href="/ranking"
                className="btn-action flex items-center justify-center gap-1.5 rounded-lg bg-gray-100 px-3 py-2.5 text-[12px] font-semibold text-gray-600 hover:bg-gray-200"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 20V10M12 20V4M6 20v-6"/>
                </svg>
                Rankings
              </Link>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Input value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={onEnter(handleJoin)} placeholder="Game code" autoFocus />
            <div className="flex gap-2">
              <Button onClick={handleJoin} className="flex-1">Join</Button>
              <button
                onClick={() => { setPinMode(false); setPin("") }}
                className="rounded-lg px-3 py-2 text-xs font-semibold text-gray-400 hover:text-primary"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Expanded recent games */}
        {expanded && profile && profile.recentSessions.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-gray-100 pt-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Recent games</p>
            {profile.recentSessions.slice(0, 5).map(s => {
              const isSolo = s.mode === "solo"
              const linha = (
                <>
                  <span className="shrink-0 text-[10px] text-gray-400">{isSolo ? "solo" : `#${s.rank}`}</span>
                  <span className="flex-1 truncate text-left text-xs font-semibold text-gray-700">{s.quizTitle}</span>
                  {isSolo && <span className="shrink-0 text-[10px] font-semibold text-primary">Review</span>}
                  <span className="shrink-0 text-[10px] font-bold text-primary">+{s.xpGained} XP</span>
                  <span className="shrink-0 text-[10px] text-gray-400">{new Date(s.startedAt).toLocaleDateString("en-US")}</span>
                </>
              )
              if (!isSolo) {
                return <div key={s.sessionId} className="flex items-center gap-2 rounded-lg bg-gray-50 px-2.5 py-1.5">{linha}</div>
              }
              return (
                <button
                  key={s.sessionId}
                  onClick={() => {
                    if (review?.sessionId === s.sessionId) { setReview(null); return }
                    setReviewLoading(s.sessionId)
                    ;(socket as any)?.timeout(12000).emit(
                      "player:getSoloReview",
                      { sessionId: s.sessionId, realName: profile.player?.realName },
                      (err: any, r: any) => {
                        setReviewLoading(null)
                        if (err || !r?.ok) { setReview({ sessionId: s.sessionId, erro: true }); return }
                        setReview({ ...r, sessionId: s.sessionId })
                      },
                    )
                  }}
                  className="flex items-center gap-2 rounded-lg bg-gray-50 px-2.5 py-1.5 hover:bg-gray-100"
                >
                  {reviewLoading === s.sessionId
                    ? <span className="flex-1 text-left text-xs text-gray-400">Loading…</span>
                    : linha}
                </button>
              )
            })}

            {review && (
              <div className="mt-1 rounded-xl bg-white p-3 ring-1 ring-gray-100">
                {review.erro ? (
                  <p className="text-center text-xs text-gray-400">Could not load this attempt.</p>
                ) : (
                  <>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="truncate text-xs font-bold text-gray-700">{review.quizTitle}</p>
                      <span className="shrink-0 text-[10px] text-gray-400">
                        {review.correct}/{review.items.length} correct · try {review.attemptsUsed} of {review.maxAttempts}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {review.items.map((it: any) => (
                        <div key={it.questionIndex} className="rounded-lg bg-gray-50 px-2.5 py-1.5">
                          <div className="flex items-start gap-2">
                            <span className={`shrink-0 text-[11px] font-bold ${it.isCorrect ? "text-green-600" : "text-answer-red"}`}>
                              {it.isCorrect ? "✓" : "✗"}
                            </span>
                            <span className="flex-1 text-[11px] font-semibold text-gray-700">{it.questionTitle}</span>
                          </div>
                          <div className="mt-0.5 pl-5 text-[10px] text-gray-500">
                            You answered: <span className="font-semibold text-gray-700">{it.selectedAnswer}</span>
                            {!it.isCorrect && it.correctAnswer && (
                              <> · Correct: <span className="font-semibold text-green-700">{it.correctAnswer}</span></>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                    {/* Sem o gabarito, a tela diz POR QUE — senao parece defeito. */}
                    {!review.showsKey && (
                      <p className="mt-2 text-center text-[10px] text-gray-400">
                        {review.policy === "never"
                          ? "Correct answers are not shown for this quiz."
                          : `Correct answers appear after your last try (${review.attemptsUsed} of ${review.maxAttempts} used).`}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {expanded && profile && profile.recentSessions.length === 0 && (
          <p className="text-center text-xs text-gray-400">Nenhum jogo ainda.</p>
        )}

      </div>
    </div>
  )
}

function Stat({ label, value, highlight }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`flex flex-col items-center rounded-xl bg-gray-50 px-2 py-2 ring-1 ring-gray-100 ${highlight ? "bg-amber-50 ring-amber-200" : ""}`}>
      <span className="text-base font-bold tabular-nums text-gray-800">{value}</span>
      <span className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">{label}</span>
    </div>
  )
}

type BadgeEarned = { id: string; label: string; description: string; emoji: string; category: string; unlockedAt: string }
type BadgeCatalogItem = { id: string; label: string; description: string; emoji: string; category: string }

function BadgeShelf({ earned, catalog }: { earned: BadgeEarned[]; catalog: BadgeCatalogItem[] }) {
  const [showAll, setShowAll] = useState(false)
  const earnedIds = new Set(earned.map(b => b.id))
  // Show earned first (newest unlock first), then locked in catalog order.
  const ordered = [
    ...earned,
    ...catalog.filter(c => !earnedIds.has(c.id)).map(c => ({ ...c, unlockedAt: "" })),
  ]
  const visible = showAll ? ordered : ordered.slice(0, 8)

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-gray-100 bg-gray-50/60 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Achievements</span>
        <span className="text-[10px] font-bold tabular-nums text-primary">
          {earned.length} <span className="text-gray-400">/ {catalog.length}</span>
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {visible.map(b => {
          const unlocked = earnedIds.has(b.id)
          return (
            <div
              key={b.id}
              title={`${b.description}${unlocked ? "" : " (locked)"}`}
              className={`flex flex-col items-center gap-0.5 rounded-lg p-1.5 text-center transition-all ${
                unlocked
                  ? "bg-gradient-to-br from-amber-50 to-amber-100 shadow ring-1 ring-amber-200 hover:scale-105"
                  : "bg-gray-100 grayscale opacity-50"
              }`}
            >
              <span aria-hidden className="text-xl leading-none">{b.emoji}</span>
              <span className={`w-full truncate text-[9px] font-semibold leading-tight ${
                unlocked ? "text-amber-800" : "text-gray-400"
              }`}>{b.label}</span>
            </div>
          )
        })}
      </div>
      {ordered.length > 8 && (
        <button
          onClick={() => setShowAll(s => !s)}
          className="self-center text-[10px] font-semibold text-gray-400 hover:text-primary"
        >
          {showAll ? "Show less" : `View all (${ordered.length})`}
        </button>
      )}
    </div>
  )
}

export default PlayerHomeCard


function ModePill({ label, games, points, tone, disabled }: { label: string; games: number; points: number; tone: "primary" | "emerald" | "gray"; disabled?: boolean }) {
  const toneMap: Record<string, string> = {
    primary: "bg-primary/10 text-primary ring-primary/20",
    emerald: "bg-emerald-100 text-emerald-700 ring-emerald-200",
    gray:    "bg-gray-100 text-gray-400 ring-gray-200",
  }
  return (
    <div className={"rounded-xl px-2 py-1.5 text-center ring-1 " + toneMap[tone] + (disabled ? " opacity-60" : "")}>
      <div className="text-[9px] font-bold uppercase tracking-wider opacity-80">{label}</div>
      <div className="mt-0.5 flex items-baseline justify-center gap-1">
        <span className="text-sm font-extrabold">{games}</span>
        <span className="text-[9px] opacity-70">games</span>
      </div>
      <div className="text-[10px] font-semibold opacity-80">{points.toLocaleString("en-US")} pts</div>
    </div>
  )
}

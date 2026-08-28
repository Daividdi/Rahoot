"use client"

import { QuizzWithId } from "@rahoot/common/types/game"
import Button from "@rahoot/web/components/Button"
import clsx from "clsx"
import React, { useState, useEffect, useRef, useCallback } from "react"
import toast from "react-hot-toast"
import { useSocket } from "@rahoot/web/contexts/socketProvider"
import { useRouter, useSearchParams } from "next/navigation"

// Textarea que quebra linha e cresce com o conteúdo (auto-size), substituindo
// o input de uma linha que truncava textos longos no editor.
function AutoTextarea({ value, onChange, className, placeholder, style }: {
  value: string
  onChange: (_v: string) => void
  className?: string
  placeholder?: string
  style?: React.CSSProperties
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const resize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = el.scrollHeight + "px"
  }
  useEffect(() => { resize() }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onInput={resize}
      className={className}
      style={{ resize: "none", overflow: "hidden", display: "block", ...style }}
    />
  )
}

type Props = {
  quizzList: QuizzWithId[]
  onSelect: (_id: string, _mode?: "classic" | "team") => void
  onListChange?: (_list: any[]) => void
  regionFilter?: "all" | "BR" | "MY" | "CN"
}

const SHAPE_STYLES = [
  { color: "var(--color-answer-red)", shape: "triangle" as const },
  { color: "var(--color-answer-blue)", shape: "diamond" as const },
  { color: "var(--color-answer-yellow)", shape: "circle" as const },
  { color: "var(--color-answer-green)", shape: "square" as const },
]

const REGIONS = ["Brazil (BR)", "Malaysia (MY)", "China (CN)", "Global (All teams)"]
const CATEGORIES = ["General", "Tooth Anatomy", "Orthodontics", "Rule Refresh", "Weekly Review", "Quality Check", "Dental Anatomy", "Introduction", "Reinforcement", "Custom"]
const GROUPS = ["ATP", "ATD", "Others"]
const ANSWER_COLORS = ["bg-answer-red", "bg-answer-blue", "bg-answer-yellow", "bg-answer-green"]
const ANSWER_LABELS = ["A", "B", "C", "D"]

// ─── helpers ─────────────────────────────────────────────────────────────────

const ShapeIcon = ({ index }: { index: number }) => {
  const s = SHAPE_STYLES[index % SHAPE_STYLES.length]
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg shape-icon" style={{ background: s.color }}>
      {s.shape === "triangle" && <div className="h-0 w-0" style={{ borderLeft: "8px solid transparent", borderRight: "8px solid transparent", borderBottom: "14px solid white" }} />}
      {s.shape === "diamond" && <div className="h-3.5 w-3.5 rotate-45 bg-white" />}
      {s.shape === "circle" && <div className="h-4 w-4 rounded-full bg-white" />}
      {s.shape === "square" && <div className="h-3 w-3 bg-white" />}
    </div>
  )
}

const AccuracyBadge = ({ value }: { value: number }) => (
  <span className={clsx("inline-flex rounded px-2 py-0.5 text-[11px] font-semibold",
    value >= 70 ? "bg-green-100 text-green-800" : value >= 50 ? "bg-blue-100 text-blue-800" :
    value >= 35 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800"
  )}>{value}%</span>
)

const compressImage = (file: File, maxW = 800, maxH = 600, quality = 0.82): Promise<string> =>
  new Promise((res, rej) => {
    const reader = new FileReader()
    reader.onload = (ev) => {
      const img = new window.Image()
      img.onload = () => {
        let w = img.width, h = img.height
        if (w > h) { if (w > maxW) { h = Math.round(h * maxW / w); w = maxW } }
        else { if (h > maxH) { w = Math.round(w * maxH / h); h = maxH } }
        const c = document.createElement("canvas")
        c.width = w; c.height = h
        c.getContext("2d")?.drawImage(img, 0, 0, w, h)
        res(c.toDataURL("image/jpeg", quality))
      }
      img.onerror = rej
      img.src = ev.target?.result as string
    }
    reader.onerror = rej
    reader.readAsDataURL(file)
  })

const blankQuestion = () => ({
  question: "", answers: ["", "", "", ""], answerImages: [null, null, null, null] as (string | null)[],
  solution: 0 as number | number[], cooldown: 5, time: 15, image: "", multipleAnswers: false
})

const DRAFT_PREFIX = "rahoot_draft_"
const saveDraft = (key: string, data: any) => {
  try { localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ ...data, savedAt: Date.now() })) } catch {}
}
const loadDraft = (key: string) => {
  try { const s = localStorage.getItem(DRAFT_PREFIX + key); return s ? JSON.parse(s) : null } catch { return null }
}
const clearDraft = (key: string) => { try { localStorage.removeItem(DRAFT_PREFIX + key) } catch {} }

// ─── Download XLSX template ───────────────────────────────────────────────────
const downloadTemplate = async () => {
  const XLSX = await import("xlsx")
  const ws = XLSX.utils.aoa_to_sheet([
    ["question", "answer1", "answer2", "answer3", "answer4", "correct_answer (1-4)", "time_seconds", "cooldown_seconds"],
    ["What is 2 + 2?", "3", "4", "5", "6", "2", "15", "5"],
    ["Capital of Brazil?", "São Paulo", "Brasília", "Rio de Janeiro", "Salvador", "2", "20", "5"],
    ["What color is the sky?", "Red", "Green", "Blue", "Yellow", "3", "15", "5"],
  ])
  ws["!cols"] = [{ wch: 40 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 22 }, { wch: 16 }, { wch: 18 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "Questions")
  XLSX.writeFile(wb, "rahoot_question_template.xlsx")
}

// ─── Parse import file → questions ───────────────────────────────────────────
const parseImportFile = async (file: File): Promise<any[]> => {
  const name = file.name.toLowerCase()
  if (name.endsWith(".json")) {
    const text = await file.text()
    const parsed = JSON.parse(text)
    const arr = Array.isArray(parsed) ? parsed : parsed.questions || []
    return arr.map((q: any) => {
      const ans = [...(q.answers || ["", "", "", ""])]
      while (ans.length < 4) ans.push("")
      return { question: q.question || "", answers: ans, answerImages: [null, null, null, null], solution: Number(q.solution ?? 0), cooldown: Number(q.cooldown ?? 5), time: Number(q.time ?? 15), image: q.image || "" }
    })
  }
  // CSV or XLSX
  const XLSX = await import("xlsx")
  let wb: any
  if (name.endsWith(".csv")) {
    const text = await file.text()
    wb = XLSX.read(text, { type: "string" })
  } else {
    const buf = await file.arrayBuffer()
    wb = XLSX.read(buf, { type: "array" })
  }
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 })
  // Skip header row
  return rows.slice(1).filter((r: any[]) => r[0]).map((r: any[]) => ({
    question: String(r[0] || ""),
    answers: [String(r[1] || ""), String(r[2] || ""), String(r[3] || ""), String(r[4] || "")],
    answerImages: [null, null, null, null],
    solution: Math.max(0, Math.min(3, Number(r[5] || 1) - 1)),
    time: Number(r[6] || 15),
    cooldown: Number(r[7] || 5),
    image: "",
  }))
}

// ─── Parse full quiz import ───────────────────────────────────────────────────
const parseQuizImport = async (file: File): Promise<{ subject: string; questions: any[] } | null> => {
  const name = file.name.toLowerCase()
  if (name.endsWith(".json")) {
    const text = await file.text()
    const parsed = JSON.parse(text)
    if (parsed.subject && Array.isArray(parsed.questions)) return parsed
    if (Array.isArray(parsed)) return { subject: "Imported Quiz", questions: parsed }
    return null
  }
  const XLSX = await import("xlsx")
  let wb: any
  if (name.endsWith(".csv")) {
    wb = XLSX.read(await file.text(), { type: "string" })
  } else {
    wb = XLSX.read(await file.arrayBuffer(), { type: "array" })
  }
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 })
  const questions = rows.slice(1).filter((r: any[]) => r[0]).map((r: any[]) => ({
    question: String(r[0] || ""),
    answers: [String(r[1] || ""), String(r[2] || ""), String(r[3] || ""), String(r[4] || "")],
    answerImages: [null, null, null, null],
    solution: Math.max(0, Math.min(3, Number(r[5] || 1) - 1)),
    time: Number(r[6] || 15), cooldown: Number(r[7] || 5), image: "",
  }))
  return { subject: wb.SheetNames[0] !== "Sheet1" ? wb.SheetNames[0] : "Imported Quiz", questions }
}

// ─── Main component ───────────────────────────────────────────────────────────
const SelectQuizz = ({ quizzList, onSelect, onListChange, regionFilter = "all" }: Props) => {
  const [localList, setLocalList] = useState<any[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [sortBy, setSortBy] = useState("recent")
  const [gamesFilter, setGamesFilter] = useState("all")
  const [periodFilter, setPeriodFilter] = useState("all")
  const router = useRouter()

  useEffect(() => { setLocalList(quizzList) }, [quizzList])

  const [selected, setSelected] = useState<string | null>(null)

  // "Play again" no relatorio chega com ?quiz=<id> e ja deixa o quiz escolhido.
  // Antes aquele botao chamava router.back(), que voltava no historico do
  // navegador — quase sempre esta mesma lista, sem nada selecionado, e o
  // treinador tinha de procurar o quiz de novo.
  //
  // Deixa SELECIONADO, nao inicia: abrir sala ao vivo por link seria fácil
  // demais de disparar sem querer, e quem confirma o inicio continua sendo a
  // pessoa. Roda uma vez, quando a lista chega — depois disso a escolha e de
  // quem esta usando a tela.
  const params = useSearchParams()
  const jaPreSelecionou = useRef(false)
  useEffect(() => {
    if (jaPreSelecionou.current || !quizzList?.length) return
    const pedido = params?.get("quiz")
    if (!pedido) { jaPreSelecionou.current = true; return }
    const alvo = pedido.endsWith(".json") ? pedido : `${pedido}.json`
    const achou = quizzList.find((q: any) => q.id === alvo || q.id === pedido)
    if (achou) setSelected(achou.id)
    jaPreSelecionou.current = true
  }, [quizzList, params])
  const [isCreating, setIsCreating] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const { socket } = useSocket()
  const anySocket = socket as any

  // Editor state
  const [subject, setSubject] = useState("")
  const [createdBy, setCreatedBy] = useState("")
  const [region, setRegion] = useState(REGIONS[0])
  const [category, setCategory] = useState(CATEGORIES[0])
  const [group, setGroup] = useState(GROUPS[0])
  // Mirrors DEFAULT_MAX_ATTEMPTS in the socket package; a quiz that does not
  // say otherwise gets this many solo attempts per person.
  const [soloAttempts, setSoloAttempts] = useState<number>(3)
  // Politica de revisao do solo. Padrao "after_attempts": ver o gabarito
  // durante as tentativas transformaria a revisao em folha de respostas.
  const [soloReview, setSoloReview] = useState<string>("after_attempts")
  const [questions, setQuestions] = useState<any[]>([blankQuestion()])
  const [draftKey, setDraftKey] = useState("new")
  const [countdown, setCountdown] = useState(60)
  const [savePulse, setSavePulse] = useState(false)
  const countdownRef = useRef(60)
  const latestDraft = useRef<any>({})
  const questionsEndRef = useRef<HTMLDivElement>(null)

  // Import quiz modal
  const [importPreview, setImportPreview] = useState<{ subject: string; questions: any[] } | null>(null)
  const [importSubjectOverride, setImportSubjectOverride] = useState("")

  // Keep a ref to latest draft data so the interval can read it without stale closure
  useEffect(() => {
    latestDraft.current = { subject, createdBy, region, category, group, soloAttempts, soloReview, questions }
  }, [subject, createdBy, region, category, group, soloAttempts, soloReview, questions])

  // Reset countdown whenever content changes
  useEffect(() => {
    if (!isCreating) return
    countdownRef.current = 60
    setCountdown(60)
  }, [subject, createdBy, region, category, group, questions, isCreating])

  // 60-second auto-save ticker
  useEffect(() => {
    if (!isCreating) return
    const iv = setInterval(() => {
      countdownRef.current = Math.max(0, countdownRef.current - 1)
      setCountdown(countdownRef.current)
      if (countdownRef.current === 0) {
        saveDraft(draftKey, latestDraft.current)
        setSavePulse(true)
        setTimeout(() => setSavePulse(false), 2500)
        countdownRef.current = 60
        setCountdown(60)
      }
    }, 1000)
    return () => clearInterval(iv)
  }, [isCreating, draftKey])

  // ─ date parsing ─
  const parseDateStr = (dateStr: string): number => {
    if (!dateStr) return 0
    try {
      const [datePart, timePart] = dateStr.split(",").map((s: string) => s.trim())
      const parts = datePart.split("/")
      if (parts.length === 3) {
        let day: number, month: number, year: number
        if (Number(parts[2]) > 100) { day = Number(parts[0]); month = Number(parts[1]) - 1; year = Number(parts[2]) }
        else { month = Number(parts[0]) - 1; day = Number(parts[1]); year = Number(parts[2]) }
        const hours = timePart ? Number(timePart.split(":")[0]) : 0
        const mins = timePart ? Number(timePart.split(":")[1]) : 0
        return new Date(year, month, day, hours, mins).getTime()
      }
    } catch {}
    return 0
  }

  const filteredList = localList
    .filter((q) => {
      if (regionFilter !== "all") {
        const r = (q.region || "").toLowerCase()
        if (regionFilter === "BR" && !r.includes("br") && !r.includes("brazil")) return false
        if (regionFilter === "MY" && !r.includes("my") && !r.includes("malaysia")) return false
        if (regionFilter === "CN" && !r.includes("cn") && !r.includes("china")) return false
      }
      const matchesSearch = !searchQuery || q.subject?.toLowerCase().includes(searchQuery.toLowerCase()) || q.createdBy?.toLowerCase().includes(searchQuery.toLowerCase())
      if (!matchesSearch) return false
      if (periodFilter === "all") return true
      const ts = parseDateStr(q.lastPlayedAt || q.createdAt || "")
      if (!ts) return periodFilter === "never"
      const now = Date.now()
      if (periodFilter === "today") return now - ts < 86400000
      if (periodFilter === "week") return now - ts < 604800000
      if (periodFilter === "month") return now - ts < 2592000000
      if (periodFilter === "never") return !(q.lastSessionStats?.length > 0) && !(q.totalSoloAttempts > 0)
      return true
    })
    .filter((q) => {
      const g = q.totalGamesPlayed || 0
      if (gamesFilter === "all") return true
      if (gamesFilter === "0")   return g === 0
      if (gamesFilter === "1")   return g >= 1
      if (gamesFilter === "5")   return g >= 5
      if (gamesFilter === "10")  return g >= 10
      return true
    })
    .sort((a, b) => {
      if (sortBy === "players") {
        const pa = a.lastSessionStats?.length || 0
        const pb = b.lastSessionStats?.length || 0
        if (pa === 0 && pb === 0) return parseDateStr(b.createdAt || "") - parseDateStr(a.createdAt || "")
        if (pa === 0) return 1
        if (pb === 0) return -1
        return pb - pa
      }
      if (sortBy === "questions") return (b.questions?.length || 0) - (a.questions?.length || 0)
      // "recent" sort: played quizzes first (by lastPlayedAt desc), never-played at bottom (by createdAt desc)
      const playedA = !!(a.lastPlayedAt)
      const playedB = !!(b.lastPlayedAt)
      if (!playedA && !playedB) return parseDateStr(b.createdAt || "") - parseDateStr(a.createdAt || "")
      if (!playedA) return 1
      if (!playedB) return -1
      return parseDateStr(b.lastPlayedAt) - parseDateStr(a.lastPlayedAt)
    })

  const getQuizAccuracy = (quiz: any) => {
    const stats = quiz.lastSessionStats || []
    if (!stats.length) return -1
    let correct = 0, total = 0
    stats.forEach((p: any) => (p.answers || []).forEach((a: any) => { total++; if (a.isCorrect) correct++ }))
    return total > 0 ? Math.round((correct / total) * 100) : -1
  }

  // ─ editor open helpers ─
  const openEditor = (opts: { editId: string | null; subject: string; createdBy: string; region: string; category: string; group: string; soloAttempts: number; soloReview?: string; questions: any[] }) => {
    const key = opts.editId || "new"
    const draft = loadDraft(key)
    if (draft && draft.savedAt) {
      const ageMin = Math.round((Date.now() - draft.savedAt) / 60000)
      const label = ageMin < 2 ? "just now" : ageMin < 60 ? `${ageMin} min ago` : `${Math.round(ageMin / 60)}h ago`
      const restore = window.confirm(`Unsaved draft found (saved ${label}). Restore it?\n\nOK = restore draft\nCancel = start fresh`)
      if (restore) {
        setSubject(draft.subject || opts.subject)
        setCreatedBy(draft.createdBy || opts.createdBy)
        setRegion(draft.region || opts.region)
        setCategory(draft.category || opts.category)
        setGroup(draft.group || opts.group)
        setSoloAttempts(Number(draft.soloAttempts) > 0 ? Number(draft.soloAttempts) : opts.soloAttempts)
        setSoloReview(draft.soloReview || opts.soloReview || "after_attempts")
        setQuestions(draft.questions?.length ? draft.questions : opts.questions)
        setEditId(opts.editId); setDraftKey(key); setIsCreating(true)
        return
      } else { clearDraft(key) }
    }
    setEditId(opts.editId); setSubject(opts.subject); setCreatedBy(opts.createdBy)
    setRegion(opts.region); setCategory(opts.category); setGroup(opts.group)
    setSoloAttempts(opts.soloAttempts)
    setSoloReview(opts.soloReview || "after_attempts")
    setQuestions(opts.questions); setDraftKey(key); setIsCreating(true)
  }

  const openNewQuizz = () => openEditor({ editId: null, subject: "", createdBy: "", region: REGIONS[0], category: CATEGORIES[0], group: GROUPS[0], soloAttempts: 3, soloReview: "after_attempts", questions: [blankQuestion()] })

  const handleEdit = (quizz: any, e: React.MouseEvent) => {
    e.stopPropagation()
    const qs = JSON.parse(JSON.stringify(quizz.questions || [])).map((q: any) => {
      const a = [...(q.answers || [])]; while (a.length < 4) a.push("")
      const ai = [...(q.answerImages || [null, null, null, null])]; while (ai.length < 4) ai.push(null)
      return { ...q, answers: a, answerImages: ai }
    })
    openEditor({ editId: quizz.id, subject: quizz.subject, createdBy: quizz.createdBy || "", region: quizz.region || REGIONS[0], category: quizz.category || CATEGORIES[0], group: quizz.group || GROUPS[0], soloAttempts: Number(quizz.solo?.maxAttempts) > 0 ? Number(quizz.solo.maxAttempts) : 3, soloReview: quizz.solo?.review || "after_attempts", questions: qs })
  }

  const handleCopy = (quizz: any, e: React.MouseEvent) => {
    e.stopPropagation()
    const qs = JSON.parse(JSON.stringify(quizz.questions || [])).map((q: any) => {
      const a = [...(q.answers || [])]; while (a.length < 4) a.push("")
      const ai = [...(q.answerImages || [null, null, null, null])]; while (ai.length < 4) ai.push(null)
      return { ...q, answers: a, answerImages: ai }
    })
    openEditor({ editId: null, subject: quizz.subject + " (Copy)", createdBy: quizz.createdBy || "", region: quizz.region || REGIONS[0], category: quizz.category || CATEGORIES[0], group: quizz.group || GROUPS[0], soloAttempts: Number(quizz.solo?.maxAttempts) > 0 ? Number(quizz.solo.maxAttempts) : 3, soloReview: quizz.solo?.review || "after_attempts", questions: qs })
  }

  const handleSelect = (id: string) => () => setSelected(selected === id ? null : id)
  const handleSubmit = () => {
    if (!selected) return toast.error("Please select a quiz.")
    anySocket?.emit("manager:updateLastPlayed", selected)
    localStorage.setItem("active_quiz_id", selected)
    onSelect(selected)
  }
  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm("Permanently delete this quiz?")) {
      anySocket?.emit("manager:deleteQuiz", id)
      setLocalList((prev) => { const next = prev.filter((q) => q.id !== id); onListChange?.(next); return next })
      toast.success("Quiz deleted!")
    }
  }
  const handleGoToStats = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    router.push(`/reports/${id.replace(".json", "")}`)
  }

  const handleSaveQuiz = () => {
    if (!subject.trim()) return toast.error("The quiz needs a title!")
    if (!createdBy.trim()) return toast.error("Please provide the author's name!")
    if (questions.some((q) => !q.question.trim())) return toast.error("All questions must have text!")
    const existing = localList.find((q: any) => q.id === editId)
    const createdAt = editId && existing?.createdAt ? existing.createdAt : new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date())
    const filteredQs = questions.map((q) => {
      const imgs = q.answerImages || [null, null, null, null]
      const pairs = q.answers.map((a: string, i: number) => ({ text: a, img: imgs[i] ?? null }))
      const kept = pairs.filter((p: { text: string; img: string | null }) => p.text.trim() !== "" || p.img)
      return { ...q, answers: kept.map((p: { text: string; img: string | null }) => p.text), answerImages: kept.map((p: { text: string; img: string | null }) => p.img) }
    })
    const finalId = editId || (subject.toLowerCase().replace(/[^a-z0-9]/g, "-") + "-" + Date.now() + ".json")
    const newQuiz: any = { ...(existing || {}), id: finalId, subject, createdBy, createdAt, lastPlayedAt: existing?.lastPlayedAt || null, region, category, group, questions: filteredQs, solo: { ...(existing?.solo || {}), maxAttempts: soloAttempts, review: soloReview } }
    anySocket?.emit("manager:createQuiz", newQuiz)
    setLocalList((prev) => { const clean = prev.filter((q) => q.id !== finalId && q.id !== editId); const next = [...clean, newQuiz]; onListChange?.(next); return next })
    setSelected(finalId)
    clearDraft(draftKey)
    toast.success(editId ? "Quiz updated!" : "Quiz created!")
    setIsCreating(false)
  }

  // ─ question helpers ─
  const addQuestion = () => {
    setQuestions(prev => [...prev, blankQuestion()])
    setTimeout(() => questionsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50)
  }
  const updateQuestion = (i: number, f: string, v: any) => { const q = [...questions]; q[i] = { ...q[i], [f]: v }; setQuestions(q) }
  const updateAnswer = (qi: number, ai: number, v: string) => { const q = [...questions]; q[qi].answers[ai] = v; setQuestions(q) }
  const updateAnswerImage = (qi: number, ai: number, v: string | null) => {
    const q = [...questions]; const imgs = [...(q[qi].answerImages || [null, null, null, null])]; imgs[ai] = v; q[qi] = { ...q[qi], answerImages: imgs }; setQuestions(q)
  }
  const removeQuestion = (i: number) => { if (questions.length === 1) return toast.error("Must have at least one question!"); const q = [...questions]; q.splice(i, 1); setQuestions(q) }

  const handleQuestionImageUpload = (qIndex: number) => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    toast.loading("Uploading image...", { id: "qimg" })
    try { const b64 = await compressImage(file); updateQuestion(qIndex, "image", b64); toast.success("Image added!", { id: "qimg" }) }
    catch { toast.error("Image failed", { id: "qimg" }) }
    e.target.value = ""
  }

  const handleAnswerImageUpload = (qi: number, ai: number) => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    toast.loading("Uploading...", { id: "aimg" })
    try { const b64 = await compressImage(file, 400, 300, 0.75); updateAnswerImage(qi, ai, b64); toast.success("Image added!", { id: "aimg" }) }
    catch { toast.error("Failed", { id: "aimg" }) }
    e.target.value = ""
  }

  const handleImportQuestions = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    toast.loading("Parsing file...", { id: "import" })
    try {
      const parsed = await parseImportFile(file)
      if (!parsed.length) { toast.error("No valid questions found", { id: "import" }); return }
      setQuestions((prev) => [...prev.filter((q) => q.question.trim()), ...parsed])
      toast.success(`${parsed.length} questions imported!`, { id: "import" })
    } catch (err) { toast.error("Failed to parse file", { id: "import" }) }
    e.target.value = ""
  }

  const handleQuizImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    toast.loading("Reading file...", { id: "qimport" })
    try {
      const data = await parseQuizImport(file)
      if (!data) { toast.error("Invalid format", { id: "qimport" }); return }
      setImportPreview(data); setImportSubjectOverride(data.subject)
      toast.dismiss("qimport")
    } catch { toast.error("Failed to read file", { id: "qimport" }) }
    e.target.value = ""
  }

  const confirmQuizImport = () => {
    if (!importPreview) return
    openEditor({
      editId: null,
      subject: importSubjectOverride || importPreview.subject,
      createdBy: "", region: REGIONS[0], category: CATEGORIES[0], group: GROUPS[0], soloAttempts: 3,
      soloReview: "after_attempts",
      questions: importPreview.questions.map((q: any) => {
        const a = [...(q.answers || [])]; while (a.length < 4) a.push("")
        return { ...q, answers: a, answerImages: [null, null, null, null] }
      }),
    })
    setImportPreview(null)
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // EDITOR VIEW
  // ─────────────────────────────────────────────────────────────────────────────
  if (isCreating) {
    const pct = countdown / 60
    const r = 6, circ = 2 * Math.PI * r
    return (
      <div className="flex flex-col h-full">
        {/* Editor toolbar — stays fixed at top */}
        <div className="shrink-0 rounded-xl bg-white border border-gray-200 shadow-sm overflow-hidden mb-3">

          {/* Row 1: title + primary actions */}
          <div className="flex items-center gap-3 px-4 py-3">
            <button
              onClick={() => setIsCreating(false)}
              title="Back to list"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100 transition-colors"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-4 w-4"><path d="M15 18l-6-6 6-6"/></svg>
            </button>

            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">{editId ? "Editing" : "New Quiz"}</p>
              <p className="truncate text-sm font-bold text-gray-800">{subject || "Untitled Quiz"}</p>
            </div>

            <div
              className={"flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition-all duration-500 " + (savePulse ? "border-green-200 bg-green-50 text-green-700" : "border-gray-200 bg-gray-50 text-gray-400")}
              title={savePulse ? "Draft saved" : ("Next auto-save in " + countdown + "s")}
            >
              {savePulse ? (
                <>
                  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-3.5 w-3.5 shrink-0 text-green-600">
                    <path d="M2.5 7l3 3 6-6"/>
                  </svg>
                  Saved
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0 -rotate-90">
                    <circle cx="7" cy="7" r={r} fill="none" stroke="#e5e7eb" strokeWidth="2"/>
                    <circle cx="7" cy="7" r={r} fill="none" stroke="#009edf" strokeWidth="2"
                      strokeDasharray={circ}
                      strokeDashoffset={circ * pct}
                      strokeLinecap="round"
                      style={{ transition: "stroke-dashoffset 1s linear" }}
                    />
                  </svg>
                  <span>Auto-save {countdown}s</span>
                </>
              )}
            </div>

            <button
              onClick={() => setIsCreating(false)}
              className="hidden sm:block rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            >
              Cancel
            </button>
            <Button onClick={handleSaveQuiz} variant="accent" className="shrink-0 px-5 py-1.5 text-sm">
              {editId ? "Update" : "Save Quiz"}
            </Button>
          </div>

          {/* Row 2: secondary toolbar */}
          <div className="flex items-center gap-2 border-t border-gray-100 bg-gray-50 px-4 py-2">
            <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-gray-400">Questions</span>
            <button
              onClick={downloadTemplate}
              className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-gray-600 hover:border-primary hover:text-primary transition-colors"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5 shrink-0">
                <path d="M8 2v7M5 6l3 3 3-3M2 12h12"/>
              </svg>
              Download Template
            </button>
            <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-gray-600 hover:border-primary hover:text-primary transition-colors">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5 shrink-0">
                <path d="M8 10V3M5 6l3-3 3 3M2 12h12"/>
              </svg>
              Import Questions
              <input type="file" className="hidden" accept=".csv,.xlsx,.json" onChange={handleImportQuestions} />
            </label>
            <div className="ml-auto h-5 w-px bg-gray-200" />
            <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-gray-600 hover:border-primary hover:text-primary transition-colors">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5 shrink-0">
                <path d="M2 4h12M2 8h8M2 12h5M11 10v5M9 12l2 2 2-2"/>
              </svg>
              Import Full Quiz
              <input type="file" className="hidden" accept=".json,.csv,.xlsx" onChange={handleQuizImportFile} />
            </label>
          </div>
        </div>

        {/* Scrollable quiz content */}
        <div className="flex-1 overflow-y-auto min-h-0 flex flex-col gap-3 pb-4">

        {/* Quiz metadata */}
        <div className="rounded-xl bg-white border border-gray-100 shadow-sm p-3">
          <div className="flex gap-2 flex-wrap">
            <div className="flex-[3] min-w-[160px]">
              <label className="mb-0.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Quiz title</label>
              <input className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 placeholder:text-gray-400 focus:border-primary focus:bg-white outline-none" placeholder="e.g. Tooth Anatomy Review" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="flex-[2] min-w-[120px]">
              <label className="mb-0.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Author</label>
              <input className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 placeholder:text-gray-400 focus:border-primary focus:bg-white outline-none" placeholder="Your name" value={createdBy} onChange={(e) => setCreatedBy(e.target.value)} />
            </div>
            <div className="flex-[2] min-w-[110px]">
              <label className="mb-0.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Region</label>
              <select className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-primary cursor-pointer" value={region} onChange={(e) => setRegion(e.target.value)}>{REGIONS.map((r) => <option key={r}>{r}</option>)}</select>
            </div>
            <div className="flex-[2] min-w-[110px]">
              <label className="mb-0.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Category</label>
              <select className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-primary cursor-pointer" value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
            </div>
            <div className="flex-1 min-w-[80px]">
              <label className="mb-0.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400">Group</label>
              <select className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-primary cursor-pointer" value={group} onChange={(e) => setGroup(e.target.value)}>{GROUPS.map((g) => <option key={g}>{g}</option>)}</select>
            </div>
            <div className="flex-1 min-w-[92px]">
              <label className="mb-0.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400" title="How many times each person may take this quiz in solo mode. Live sessions are not affected.">Solo tries</label>
              <input type="number" min={1} max={99} className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-primary focus:bg-white" value={soloAttempts} onChange={(e) => setSoloAttempts(Math.min(99, Math.max(1, Number(e.target.value) || 1)))} />
            </div>
            <div className="flex-1 min-w-[150px]">
              <label className="mb-0.5 block text-[10px] font-bold uppercase tracking-widest text-gray-400" title="Whether a designer may see the correct answers when reviewing their own solo attempt. Live sessions are not affected.">Solo review</label>
              <select className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-primary cursor-pointer" value={soloReview} onChange={(e) => setSoloReview(e.target.value)}>
                <option value="after_attempts">Answers after last try</option>
                <option value="always">Answers right away</option>
                <option value="never">No answers, only right/wrong</option>
              </select>
            </div>
          </div>
        </div>

        {/* Questions */}
        <div className="flex flex-col gap-3">
          {questions.map((q: any, qi: number) => (
            <div key={qi} className="rounded-xl bg-white p-4 shadow-sm border border-gray-100">
              {/* Question header */}
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-primary">Question {qi + 1}</span>
                <div className="flex items-center gap-3">
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-primary transition-colors select-none">
                    <input
                      type="checkbox"
                      checked={!!q.multipleAnswers}
                      onChange={() => {
                        const isMulti = !q.multipleAnswers
                        const currentSol = q.solution
                        const newSol = isMulti
                          ? (Array.isArray(currentSol) ? currentSol : [currentSol])
                          : (Array.isArray(currentSol) ? (currentSol[0] ?? 0) : currentSol)
                        const updated = [...questions]
                        updated[qi] = { ...updated[qi], multipleAnswers: isMulti, solution: newSol }
                        setQuestions(updated)
                      }}
                      className="h-3.5 w-3.5 accent-primary cursor-pointer"
                    />
                    Multiple answers
                  </label>
                  <button onClick={() => removeQuestion(qi)} className="text-xs font-semibold text-red-400 hover:text-red-600">Remove</button>
                </div>
              </div>

              {/* Question text */}
              <AutoTextarea
                className="mb-3 w-full rounded-lg border-2 border-gray-200 bg-gray-50 px-3 py-2.5 text-sm font-medium leading-relaxed text-gray-800 placeholder:text-gray-400 outline-none transition-colors focus:border-primary focus:bg-white focus:ring-4 focus:ring-primary/10"
                placeholder="Type the question here..."
                value={q.question}
                onChange={(v) => updateQuestion(qi, "question", v)}
              />

              {/* Question image */}
              <div className="mb-3">
                {q.image ? (
                  <div className="relative rounded-xl overflow-hidden border border-gray-200 bg-gray-50 group">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={q.image} alt="" className="w-full object-contain max-h-56 rounded-xl ring-1 ring-inset ring-black/10" style={{ background: "#f8f9fa" }} />
                    <div className="absolute top-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <label className="cursor-pointer flex items-center gap-1 rounded-lg bg-black/60 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-primary transition-colors">
                        ✎ Change
                        <input type="file" className="hidden" accept="image/*" onChange={handleQuestionImageUpload(qi)} />
                      </label>
                      <button onClick={() => updateQuestion(qi, "image", "")} className="rounded-lg bg-red-500/80 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-red-600 transition-colors">✕ Remove</button>
                    </div>
                  </div>
                ) : (
                  <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 py-6 text-gray-400 hover:border-primary hover:bg-primary/5 hover:text-primary transition-colors">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8 opacity-50">
                      <rect x="3" y="3" width="18" height="18" rx="3"/>
                      <circle cx="8.5" cy="8.5" r="1.5"/>
                      <polyline points="21 15 16 10 5 21"/>
                    </svg>
                    <div className="text-center">
                      <div className="text-xs font-bold">Add question image</div>
                      <div className="text-[10px] opacity-60 mt-0.5">Click to upload · PNG, JPG, GIF</div>
                    </div>
                    <input type="file" className="hidden" accept="image/*" onChange={handleQuestionImageUpload(qi)} />
                  </label>
                )}
              </div>

              {/* Answer options */}
              <div className="mb-3 grid grid-cols-2 gap-2">
                {q.answers.map((a: string, ai: number) => (
                  <div key={ai} className={clsx("rounded-xl overflow-hidden flex min-h-20 items-stretch shadow-sm transition focus-within:shadow-md focus-within:brightness-[1.04]", ANSWER_COLORS[ai], (Array.isArray(q.solution) ? q.solution.includes(ai) : q.solution === ai) ? "ring-2 ring-green-400 ring-offset-1" : "")}>
                    {/* Color/image zone — stretches with the card height, with a soft divider */}
                    <div className="relative w-20 shrink-0 self-stretch bg-black/10 overflow-hidden group/img shadow-[inset_-1px_0_0_rgba(0,0,0,0.12)]">
                      {q.answerImages?.[ai] ? (
                        <>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={q.answerImages[ai]!} alt="" className="w-full h-full object-cover" />
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 opacity-0 group-hover/img:opacity-100 bg-black/40 transition-opacity">
                            <label className="cursor-pointer rounded bg-white/25 px-2 py-0.5 text-[9px] font-bold text-white hover:bg-white/40">
                              Change
                              <input type="file" className="hidden" accept="image/*" onChange={handleAnswerImageUpload(qi, ai)} />
                            </label>
                            <button type="button" onClick={(e) => { e.stopPropagation(); updateAnswerImage(qi, ai, null) }} className="rounded bg-red-500/80 px-2 py-0.5 text-[9px] font-bold text-white hover:bg-red-600">Remove</button>
                          </div>
                        </>
                      ) : (
                        <label className="flex h-full w-full cursor-pointer items-center justify-center hover:bg-black/10 transition-colors">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-6 w-6 text-white/40 group-hover/img:text-white/60">
                            <rect x="3" y="3" width="18" height="18" rx="3"/>
                            <circle cx="8.5" cy="8.5" r="1.5"/>
                            <polyline points="21 15 16 10 5 21"/>
                          </svg>
                          <input type="file" className="hidden" accept="image/*" onChange={handleAnswerImageUpload(qi, ai)} />
                        </label>
                      )}
                    </div>
                    {/* Text area */}
                    <div className="flex flex-1 items-center gap-2.5 px-3.5 py-2.5 min-w-0">
                      {q.multipleAnswers ? (
                        <input
                          type="checkbox"
                          checked={Array.isArray(q.solution) && q.solution.includes(ai)}
                          onChange={() => {
                            const sols: number[] = Array.isArray(q.solution) ? q.solution : [q.solution]
                            const next = sols.includes(ai) ? sols.filter(s => s !== ai) : [...sols, ai]
                            updateQuestion(qi, "solution", next)
                          }}
                          className="h-4 w-4 cursor-pointer accent-green-400 shrink-0"
                        />
                      ) : (
                        <input type="radio" name={`sol-${qi}`} checked={q.solution === ai} onChange={() => updateQuestion(qi, "solution", ai)} className="h-4 w-4 cursor-pointer accent-green-400 shrink-0" />
                      )}
                      {q.answerImages?.[ai] ? (
                        <span className="flex-1 text-sm font-semibold text-white/50 italic min-w-0 truncate">
                          {a || "Image answer"}
                        </span>
                      ) : (
                        <AutoTextarea
                          className="flex-1 bg-transparent text-[15px] font-semibold leading-relaxed text-white placeholder:text-white/60 placeholder:font-medium focus:outline-none min-w-0 [text-shadow:0_1px_1px_rgba(0,0,0,0.12)]"
                          placeholder={`Answer ${ANSWER_LABELS[ai]}`}
                          value={a}
                          onChange={(v) => updateAnswer(qi, ai, v)}
                        />
                      )}
                      {(Array.isArray(q.solution) ? q.solution.includes(ai) : q.solution === ai) && <span className="flex h-5 w-5 shrink-0 items-center justify-center self-center rounded-full bg-green-400 text-[11px] font-bold text-white shadow-sm ring-2 ring-white/40">✓</span>}
                    </div>
                  </div>
                ))}
              </div>

              {/* Time + Cooldown */}
              <div className="flex gap-4">
                <label className="flex items-center gap-1 text-xs font-semibold text-gray-400">
                  Time (sec) <input type="number" className="w-14 rounded-lg border-2 border-gray-200 p-1 text-center text-sm font-semibold text-gray-800 focus:border-primary outline-none" value={q.time} onChange={(e) => updateQuestion(qi, "time", Number(e.target.value))} />
                </label>
                <label className="flex items-center gap-1 text-xs font-semibold text-gray-400">
                  Cooldown <input type="number" className="w-14 rounded-lg border-2 border-gray-200 p-1 text-center text-sm font-semibold text-gray-800 focus:border-primary outline-none" value={q.cooldown} onChange={(e) => updateQuestion(qi, "cooldown", Number(e.target.value))} />
                </label>
              </div>
            </div>
          ))}
        </div>

        <button
          className="rounded-xl border-2 border-dashed border-gray-300 bg-white p-3 text-sm font-semibold text-gray-400 hover:border-primary hover:text-primary transition-colors"
          onClick={addQuestion}
        >+ Add New Question</button>
        <div ref={questionsEndRef} />

        </div>{/* end scroll wrapper */}
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // LIST VIEW
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* Import quiz modal */}
      {importPreview && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 flex flex-col gap-4 shadow-2xl">
            <h3 className="text-base font-bold text-gray-800">Import Quiz</h3>
            <p className="text-sm text-gray-500">{importPreview.questions.length} questions found. Give it a title:</p>
            <input
              className="w-full rounded-lg border-2 border-gray-200 bg-gray-50 p-2.5 text-sm font-semibold text-gray-800 focus:border-primary outline-none"
              value={importSubjectOverride}
              onChange={(e) => setImportSubjectOverride(e.target.value)}
              placeholder="Quiz title"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setImportPreview(null)} className="rounded-lg px-4 py-2 text-sm font-semibold text-gray-400 hover:text-gray-600">Cancel</button>
              <Button onClick={confirmQuizImport} variant="accent">Import & Edit</Button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto min-h-0 px-5 pt-4 pb-2">
      {/* Controls */}
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <input type="text" className="flex-1 min-w-[140px] rounded-lg border-2 border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-800 placeholder:text-gray-400 outline-none focus:border-primary" placeholder="Search quizzes..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
        <select value={periodFilter} onChange={(e) => setPeriodFilter(e.target.value)} className="rounded-lg border-2 border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 outline-none">
          <option value="all">All time</option>
          <option value="today">Today</option>
          <option value="week">This week</option>
          <option value="month">This month</option>
          <option value="never">Never played</option>
        </select>
        <select value={gamesFilter} onChange={(e) => setGamesFilter(e.target.value)} className="rounded-lg border-2 border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 outline-none">
          <option value="all">All sessions</option>
          <option value="0">0 sessions</option>
          <option value="1">1+ sessions</option>
          <option value="5">5+ sessions</option>
          <option value="10">10+ sessions</option>
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="rounded-lg border-2 border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 outline-none">
          <option value="recent">Sort: Most recent</option>
          <option value="players">Sort: Most played</option>
          <option value="questions">Sort: Most questions</option>
        </select>
        <Button variant="accent" onClick={openNewQuizz}>+ New Quiz</Button>
      </div>

      {/* List */}
      <div className="flex flex-col gap-2">
        {filteredList.map((quizz, index) => {
          const acc = getQuizAccuracy(quizz)
          const playerCount = quizz.lastSessionStats?.length || 0
          // Solo e classico sao contados separados de proposito: "sessions"
          // aqui sempre quis dizer jogo com turma, e somar tentativas
          // individuais distorceria essa leitura. Mas o quiz precisava parar de
          // dizer "Never played" quando ha dezenas de tentativas solo — foi o
          // que fez a equipe da Malasia concluir que o solo nao gravava nada.
          const soloCount = quizz.totalSoloAttempts || 0
          const quandoJogou = quizz.lastPlayedAt
            || (quizz.lastSoloAt ? new Date(quizz.lastSoloAt).toLocaleDateString("en-US") + " (solo)" : "")
          const isSelected = selected === quizz.id
          return (
            <div key={quizz.id}
              className={clsx("flex items-center gap-3 rounded-xl p-3 cursor-pointer transition-all", isSelected ? "bg-accent/10 border-2 border-accent" : "bg-white border-2 border-transparent hover:bg-gray-50")}
              onClick={handleSelect(quizz.id)}
            >
              <ShapeIcon index={index} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <div className="truncate text-sm font-semibold text-gray-800">{quizz.subject}</div>
                  {quizz.group && (
                    <span className={clsx("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold", quizz.group === "ATP" ? "bg-purple-100 text-purple-700" : quizz.group === "ATD" ? "bg-orange-100 text-orange-700" : "bg-gray-100 text-gray-500")}>{quizz.group}</span>
                  )}
                </div>
                <div className="text-[11px] text-gray-400">{quizz.createdBy || "System"} · {quizz.questions?.length || 0} questions</div>
                <div className="text-[11px] font-medium text-primary">{quandoJogou || "Never played"}</div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <div className="text-center"><div className="text-sm font-semibold text-gray-700">{playerCount}</div><div className="text-[10px] text-gray-400">Players</div></div>
                <div className="text-center"><div className="text-sm font-semibold text-gray-700">{quizz.totalGamesPlayed || 0}</div><div className="text-[10px] text-gray-400">Sessions</div></div>
                <div className="text-center" title="Individual solo attempts"><div className={clsx("text-sm font-semibold", soloCount ? "text-primary" : "text-gray-700")}>{soloCount}</div><div className="text-[10px] text-gray-400">Solo</div></div>
                {acc >= 0 ? <AccuracyBadge value={acc} /> : <span className="rounded bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-400">--</span>}
              </div>
              <div className="flex gap-1 shrink-0">
                <button onClick={(e) => handleEdit(quizz, e)} className="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-100 text-[11px] hover:bg-gray-200" title="Edit">&#9998;</button>
                <button onClick={(e) => handleCopy(quizz, e)} className="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-100 text-[11px] hover:bg-gray-200" title="Copy">&#128203;</button>
                <button onClick={(e) => handleGoToStats(quizz.id, e)} className="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-100 text-[11px] hover:bg-gray-200" title="Stats">&#128202;</button>
                <button onClick={(e) => handleDelete(quizz.id, e)} className="flex h-7 w-7 items-center justify-center rounded-lg bg-red-50 text-[11px] text-answer-red hover:bg-red-100" title="Delete">&#128465;</button>
              </div>
            </div>
          )
        })}
      </div>

      </div>{/* end scrollable */}
      {/* Mode picker — always visible, outside scroll area */}
      <div className="shrink-0 px-5 pb-4 pt-3 bg-[#f8fafc] border-t border-gray-100 shadow-[0_-2px_12px_rgba(0,0,0,0.06)]">
        {!selected && (
          <p className="mb-2 text-center text-xs font-medium text-gray-400">&#9650; Select a quiz above to start playing</p>
        )}
        <div className={"grid gap-3 sm:grid-cols-3" + (!selected ? " pointer-events-none opacity-50" : "")}>
            {/* Classic */}
            <div className="flex flex-col rounded-xl border-2 border-accent bg-white overflow-hidden shadow-sm">
              <div className="bg-accent/8 px-4 py-3 border-b border-accent/15 flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-base">🏆</div>
                <span className="text-sm font-bold text-gray-800">Classic</span>
              </div>
              <div className="p-4 flex flex-col flex-1">
                <p className="text-[11px] text-gray-500 leading-snug flex-1">Live multiplayer with a PIN. Players join in real-time; podium at the end.</p>
                <Button onClick={handleSubmit} className="mt-3 py-2 text-sm">Start live session</Button>
              </div>
            </div>

            {/* Solo */}
            <SoloCard selected={selected} selectedQuiz={localList.find((q: any) => q.id === selected) || null} />

            {/* Team vs Team */}
            <div className="flex flex-col rounded-xl border-2 border-orange-300 bg-white overflow-hidden shadow-sm">
              <div className="bg-orange-50 px-4 py-3 border-b border-orange-200 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-100 text-base">⚔️</div>
                  <span className="text-sm font-bold text-gray-800">Team vs Team</span>
                </div>
                <span className="rounded-full bg-orange-200 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-orange-700">New</span>
              </div>
              <div className="p-4 flex flex-col flex-1">
                <p className="text-[11px] text-gray-500 leading-snug flex-1">Players pick Team A or B. Scores balanced by team size — fairer with unequal groups.</p>
                <Button onClick={() => selected && onSelect(selected, "team")} className="mt-3 py-2 text-sm bg-orange-500 hover:bg-orange-600">Start Team vs Team</Button>
              </div>
            </div>
        </div>
      </div>
    </div>
  )
}

function SoloCard({ selected, selectedQuiz }: { selected: string | null; selectedQuiz: any | null }) {
  const [copied, setCopied] = React.useState(false)
  const soloEnabled = selectedQuiz?.solo?.enabled !== false
  const url = typeof window !== "undefined" ? window.location.origin + "/solo/" + encodeURIComponent(selected || "") : ""
  const handleCopy = async () => {
    if (!soloEnabled) return
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url)
      } else {
        const ta = document.createElement("textarea")
        ta.value = url
        ta.style.cssText = "position:fixed;opacity:0;top:0;left:0"
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        document.execCommand("copy")
        document.body.removeChild(ta)
      }
      setCopied(true)
      toast.success("Link copied — paste into Moodle")
      setTimeout(() => setCopied(false), 1800)
    } catch {
      toast.error("Could not copy link")
    }
  }
  return (
    <div className={"flex flex-col rounded-xl border-2 bg-white overflow-hidden shadow-sm " + (soloEnabled ? "border-primary/40" : "border-gray-200 opacity-55")}>
      <div className={"px-4 py-3 border-b flex items-center justify-between gap-2 " + (soloEnabled ? "bg-primary/8 border-primary/15" : "bg-gray-50 border-gray-200")}>
        <div className="flex items-center gap-2.5">
          <div className={"flex h-8 w-8 items-center justify-center rounded-lg text-base " + (soloEnabled ? "bg-primary/15" : "bg-gray-100")}><svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
          <span className="text-sm font-bold text-gray-800">Solo</span>
        </div>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-primary">Moodle</span>
      </div>
      <div className="p-4 flex flex-col flex-1">
        <p className="text-[11px] text-gray-500 leading-snug flex-1">Individual play. Students answer on their own; final score + answer review (no podium).</p>
        {soloEnabled ? (
          <>
            <div className="mt-2 truncate rounded-md bg-gray-50 px-2 py-1 text-[10px] font-mono text-gray-500" title={url}>{url}</div>
            <button
              onClick={handleCopy}
              className={"mt-2 rounded-lg py-2 text-sm font-semibold transition " + (copied ? "bg-emerald-500 text-white" : "bg-primary text-white hover:brightness-110")}
            >
              {copied ? "\u2713 Copied" : "Copy Moodle link"}
            </button>
          </>
        ) : (
          <button disabled className="mt-3 rounded-lg bg-gray-100 py-2 text-sm font-semibold text-gray-400 cursor-not-allowed">Solo disabled for this quiz</button>
        )}
      </div>
    </div>
  )
}

export default SelectQuizz

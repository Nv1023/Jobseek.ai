import { useState, useEffect, useRef } from 'react'
import type { ReactNode, PointerEvent as ReactPointerEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2, SkipForward, Eye, ExternalLink, MapPin, Star,
  PartyPopper, ListChecks, FileText, Loader2, ListX,
} from 'lucide-react'
import { api } from '../api'
import type { Job } from '../types'
import JobDetailDrawer from './JobDetailDrawer'
import { relativeIST } from '../utils/time'

function careerUrl(job: Job): string {
  if (job.job_url_direct && job.job_url_direct.length > 10) return job.job_url_direct
  return job.job_url
}

function suggestedResume(job: Job): string | null {
  const fb = job.ats_feedback as any
  return fb?.suggested_resume || null
}

/** First preference: Tamil Nadu (any city), Bengaluru, or Remote. Everything else is "Other Jobs". */
function isFirstPreference(job: Job): boolean {
  const loc = (job.location || '').toLowerCase()
  const isTamilNadu =
    loc.includes('chennai') ||
    loc.includes('tamil nadu') ||
    // Guard the bare "TN" abbreviation with an India mention so it can't match
    // US "TN" (Tennessee) listings from the remote-America search pass.
    (/\btn\b/.test(loc) && loc.includes('india'))
  const isBengaluru = loc.includes('bengaluru') || loc.includes('bangalore')
  const isRemote = job.is_remote || loc.includes('remote')
  return isTamilNadu || isBengaluru || isRemote
}

function locationRank(job: Job): 0 | 1 {
  return isFirstPreference(job) ? 0 : 1
}

const GROUP_META = [
  { rank: 0 as const, label: 'First Preference — Tamil Nadu, Bengaluru & Remote', icon: Star },
  { rank: 1 as const, label: 'Other Jobs', icon: MapPin },
]

// ── Swipe-to-action card ────────────────────────────────────────────────────
// Right-to-left swipe → Skip, left-to-right swipe → Applied. A purple (indigo)
// panel underneath the card fades in as you drag, past a small deadzone so
// ordinary taps on inner buttons/links still work normally.

const SWIPE_DEADZONE = 6
const SWIPE_THRESHOLD = 88

interface SwipeableJobCardProps {
  onSkip: () => void
  onApplied: () => void
  onExited: () => void
  children: ReactNode
}

function SwipeableJobCard({ onSkip, onApplied, onExited, children }: SwipeableJobCardProps) {
  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [exiting, setExiting] = useState<'left' | 'right' | null>(null)
  const startXRef = useRef(0)
  const widthRef = useRef(320)
  const pointerDownRef = useRef(false)
  const cardRef = useRef<HTMLDivElement>(null)

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (exiting) return
    startXRef.current = e.clientX
    widthRef.current = cardRef.current?.offsetWidth || 320
    pointerDownRef.current = true
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pointerDownRef.current || exiting) return
    const delta = e.clientX - startXRef.current
    if (!dragging) {
      if (Math.abs(delta) < SWIPE_DEADZONE) return
      setDragging(true)
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    setDragX(delta)
  }

  function commit(direction: 'left' | 'right') {
    setDragging(false)
    setExiting(direction)
    setDragX(direction === 'left' ? -widthRef.current * 1.4 : widthRef.current * 1.4)
    if (direction === 'left') onSkip()
    else onApplied()
    setTimeout(onExited, 260)
  }

  function handlePointerUp() {
    pointerDownRef.current = false
    if (!dragging || exiting) return
    setDragging(false)
    if (dragX <= -SWIPE_THRESHOLD) { commit('left'); return }
    if (dragX >= SWIPE_THRESHOLD) { commit('right'); return }
    setDragX(0)
  }

  const progress = Math.min(1, Math.abs(dragX) / SWIPE_THRESHOLD)

  return (
    <div className="relative rounded-xl overflow-hidden">
      {dragX !== 0 && (
        <div
          className={`absolute inset-0 flex items-center rounded-xl bg-indigo-600 ${
            dragX < 0 ? 'justify-end pr-6' : 'justify-start pl-6'
          }`}
          style={{ opacity: exiting ? 1 : 0.3 + progress * 0.7 }}
        >
          <div className="flex items-center gap-2 text-white font-bold text-sm">
            {dragX < 0
              ? <><span>Skip</span><SkipForward size={18} /></>
              : <><CheckCircle2 size={18} /><span>Applied</span></>}
          </div>
        </div>
      )}
      <div
        ref={cardRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          transform: `translateX(${dragX}px)`,
          transition: dragging ? 'none' : 'transform 0.25s ease, opacity 0.25s ease',
          opacity: exiting ? 0 : 1,
          touchAction: 'pan-y',
        }}
        className="relative select-none"
      >
        {children}
      </div>
    </div>
  )
}

export default function ApplyToday() {
  const qc = useQueryClient()
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())

  // Everything still awaiting action, resume already matched — ready to apply.
  const { data: todo, isLoading } = useQuery({
    queryKey: ['jobs', 'todo', 'pending'],
    queryFn: () => api.listJobs({
      application_status: 'not_applied',
      processing_status: 'processed',
      sort_by: 'ats_score',
      sort_dir: 'desc',
      page: 1,
      page_size: 100,
    }),
    refetchInterval: 10000,
  })

  // Total ever-ready jobs (regardless of status) — distinguishes "nothing scraped yet"
  // from "you cleared today's list".
  const { data: readyTotal } = useQuery({
    queryKey: ['jobs', 'todo', 'ready-total'],
    queryFn: () => api.listJobs({ processing_status: 'processed', page: 1, page_size: 1 }),
    refetchInterval: 15000,
  })

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.updateJobStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  })

  const rawJobs = todo?.items || []
  const jobs = rawJobs.filter((j) => !hiddenIds.has(j.id))
  const totalReady = readyTotal?.total ?? 0

  // Bulk-skip everything currently in the list. The list is a live query on
  // (not_applied, processed) — nothing is snapshotted, so as soon as the next
  // pipeline run matches new jobs they show up here again automatically.
  const clearAllMutation = useMutation({
    mutationFn: async () => {
      await Promise.all(jobs.map((j) => api.updateJobStatus(j.id, 'skipped')))
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  })

  function handleClearAll() {
    if (jobs.length === 0 || clearAllMutation.isPending) return
    const ok = window.confirm(
      `Skip all ${jobs.length} job${jobs.length === 1 ? '' : 's'} in today's list? ` +
      `New jobs from the next pipeline run will still show up here.`
    )
    if (!ok) return
    clearAllMutation.mutate()
  }

  // Keep hiddenIds from growing forever — once the server confirms a job left
  // the pending list, we no longer need to hide it locally.
  useEffect(() => {
    setHiddenIds((prev) => {
      if (prev.size === 0) return prev
      const next = new Set([...prev].filter((id) => rawJobs.some((j) => j.id === id)))
      return next.size === prev.size ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todo])

  const groups = GROUP_META
    .map((g) => ({ ...g, jobs: jobs.filter((j) => locationRank(j) === g.rank) }))
    .filter((g) => g.jobs.length > 0)

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 flex items-center gap-2">
            <ListChecks size={22} className="text-indigo-600 flex-shrink-0" /> Apply Today
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Swipe a card left to skip, right to mark applied.
          </p>
        </div>

        {jobs.length > 0 && (
          <button
            onClick={handleClearAll}
            disabled={clearAllMutation.isPending}
            title="Skip every job in today's list"
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700 disabled:opacity-50 transition-colors flex-shrink-0"
          >
            {clearAllMutation.isPending
              ? <Loader2 size={14} className="animate-spin" />
              : <ListX size={14} />}
            {clearAllMutation.isPending ? 'Clearing…' : 'Clear All'}
          </button>
        )}
      </div>

      {clearAllMutation.isError && (
        <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">
          {(clearAllMutation.error as Error).message}
        </p>
      )}

      {isLoading && (
        <div className="text-center py-16 text-slate-400 text-sm">Loading…</div>
      )}

      {!isLoading && totalReady === 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 sm:p-10 text-center">
          <p className="text-4xl mb-3">🗂️</p>
          <p className="text-base font-semibold text-slate-800">Nothing ready to apply yet</p>
          <p className="text-sm text-slate-500 mt-1">
            Run the pipeline from the Dashboard to discover jobs and match resumes.
          </p>
        </div>
      )}

      {!isLoading && totalReady > 0 && jobs.length === 0 && (
        <div className="bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-2xl p-8 sm:p-10 text-center text-white">
          <PartyPopper size={40} className="mx-auto mb-3" />
          <p className="text-lg sm:text-xl font-bold">Hurray! You've cleared today's list 🎉</p>
          <p className="text-sm text-emerald-50 mt-1.5">
            Great work today — let's hope for the best on the ones you applied to! Check back after the next
            pipeline run for new matches.
          </p>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="flex items-center gap-2 mb-2.5">
                <group.icon size={14} className="text-indigo-500 flex-shrink-0" />
                <h2 className="text-sm font-semibold text-slate-700">{group.label}</h2>
                <span className="text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full">
                  {group.jobs.length}
                </span>
              </div>

              <div className="space-y-2.5">
                {group.jobs.map((job) => {
                  const resume = suggestedResume(job)
                  const url = careerUrl(job)
                  const busy = statusMutation.isPending && statusMutation.variables?.id === job.id

                  return (
                    <SwipeableJobCard
                      key={job.id}
                      onSkip={() => statusMutation.mutate({ id: job.id, status: 'skipped' })}
                      onApplied={() => statusMutation.mutate({ id: job.id, status: 'applied' })}
                      onExited={() => setHiddenIds((prev) => new Set(prev).add(job.id))}
                    >
                      <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                        {/* Job info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-semibold text-slate-900 text-sm truncate">{job.company || '—'}</p>
                            {job.ats_score !== null && (
                              <span className={`text-xs font-bold px-2 py-0.5 rounded-full flex-shrink-0 ${
                                job.ats_score >= 70 ? 'bg-emerald-100 text-emerald-700' :
                                job.ats_score >= 50 ? 'bg-blue-100 text-blue-700' :
                                'bg-amber-100 text-amber-700'
                              }`}>{job.ats_score}%</span>
                            )}
                          </div>
                          <p className="text-xs text-slate-500 truncate mt-0.5">{job.title}</p>
                          <div className="flex items-center gap-x-2 gap-y-1 mt-1.5 text-xs text-slate-400 flex-wrap">
                            <span className="truncate max-w-[220px]">{job.location || 'Location unknown'}</span>
                            {job.date_posted && <span className="whitespace-nowrap">· {relativeIST(job.date_posted)}</span>}
                            {resume && <span className="text-slate-500 truncate">· {resume}</span>}
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap sm:justify-end">
                          <button
                            onClick={() => setSelectedJob(job)}
                            title="View job details & JD"
                            className="p-2 rounded-lg hover:bg-indigo-50 text-slate-400 hover:text-indigo-600 transition-colors"
                          >
                            <Eye size={15} />
                          </button>
                          {resume && (
                            <a
                              href={api.resumeDownloadUrl(job.id)}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Download tailored resume"
                              className="p-2 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 transition-colors"
                            >
                              <FileText size={15} />
                            </a>
                          )}
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open career page"
                            className="p-2 rounded-lg hover:bg-indigo-50 text-slate-400 hover:text-indigo-600 transition-colors"
                          >
                            <ExternalLink size={15} />
                          </a>
                          <button
                            onClick={() => statusMutation.mutate({ id: job.id, status: 'skipped' })}
                            disabled={busy}
                            title="Skip — don't apply to this one"
                            className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                          >
                            <SkipForward size={13} /> Skip
                          </button>
                          <button
                            onClick={() => statusMutation.mutate({ id: job.id, status: 'applied' })}
                            disabled={busy}
                            title="Mark as applied"
                            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white transition-colors"
                          >
                            {busy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                            Applied
                          </button>
                        </div>
                      </div>
                    </SwipeableJobCard>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedJob && (
        <JobDetailDrawer job={selectedJob} onClose={() => setSelectedJob(null)} />
      )}
    </div>
  )
}

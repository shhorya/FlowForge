'use client'
import { useEffect, useMemo, useState } from 'react'
import { animate, motion, type Variants } from 'framer-motion'
import { Activity, Archive, ArrowRight, GitBranch, Layers3, LayoutGrid, Play, Plus, Settings2, Sparkles } from 'lucide-react'
import { api, type Workflow } from '@/lib/api'
import { useStore, type View } from '@/lib/store'
import { PageHead, StatusChip, ago, fmtDur } from './shared'

const box: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.07 } } }
const item: Variants = { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' } } }

function CountUp({ to, suffix = '' }: { to: number; suffix?: string }) {
  const [v, setV] = useState(0)
  useEffect(() => { const c = animate(0, to, { duration: 0.9, ease: 'easeOut', onUpdate: setV }); return () => c.stop() }, [to])
  return <>{Math.round(v)}{suffix}</>
}

const TILES: { v: View; icon: React.ElementType; t: string; d: string; ai?: boolean }[] = [
  { v: 'Editor', icon: GitBranch, t: 'Visual editor', d: 'Drag, drop and wire nodes. Branch, merge, retry and route errors on a live canvas.' },
  { v: 'Editor', icon: Sparkles, t: 'Plain-English builder', d: 'Describe a workflow and watch the graph build itself, validated by the engine.', ai: true },
  { v: 'Templates', icon: LayoutGrid, t: 'Templates', d: 'Four runnable workflows: webhooks, parallel steps, switch routing, schedules.' },
  { v: 'Workflows', icon: Layers3, t: 'Workflows', d: 'Run, activate, duplicate or export everything you have built.' },
  { v: 'Runs', icon: Activity, t: 'Runs & replay', d: 'Scrub any execution node by node, inspect data, resume from failure.' },
  { v: 'Outbox', icon: Archive, t: 'Outbox & data', d: 'See the emails and records your workflows produced.' },
  { v: 'Settings', icon: Settings2, t: 'Settings', d: 'Point the UI at any backend, set an API key, switch theme.' },
]
const STATUSES = ['success', 'failed', 'running', 'cancelled', 'timed_out']

function HeroGraph() {
  const N = (x: number, y: number, label: string, fill: string, ink: string, d: number, r = 14) =>
    <g key={label} className="hero-node" style={{ animationDelay: `${d}s` }}><rect x={x} y={y} width={92} height={44} rx={r} fill={fill} /><text x={x + 46} y={y + 27} textAnchor="middle" fontSize="11" fontWeight="700" fill={ink}>{label}</text></g>
  return <svg viewBox="0 0 502 190" className="hero-svg" aria-hidden="true">
    <path className="hero-edge" d="M102 95 H140" /><path className="hero-edge" d="M232 95 C250 95 250 45 270 45" /><path className="hero-edge" d="M232 95 C250 95 250 145 270 145" />
    <path className="hero-edge" d="M362 45 C382 45 382 95 400 95" /><path className="hero-edge" d="M362 145 C382 145 382 95 400 95" />
    {N(10, 73, 'Webhook', '#c8f54a', '#0e0f13', 0)}{N(140, 73, 'Total ≥ 100?', '#4f5bff', '#fff', 0.3, 22)}
    {N(270, 23, 'Email', '#fff', '#0e0f13', 0.6)}{N(270, 123, 'Save', '#fff', '#0e0f13', 0.9)}{N(400, 73, 'Merge', '#fff', '#0e0f13', 1.2)}
  </svg>
}

export default function Dashboard() {
  const { workflows, runs, stats, templates, setView, newWorkflow, instantiateTemplate, refresh, refreshRuns, toast } = useStore()
  const [busy, setBusy] = useState('')
  useEffect(() => { refreshRuns(); const t = setInterval(refreshRuns, 5000); return () => clearInterval(t) }, []) // eslint-disable-line
  const names = useMemo(() => Object.fromEntries(workflows.map((w) => [w.id, w.name])), [workflows])
  const by = useMemo(() => { const m: Record<string, number> = {}; runs.forEach((r) => { m[r.status] = (m[r.status] || 0) + 1 }); return m }, [runs])
  const recent = runs.slice(0, 14).reverse()
  const maxD = Math.max(1, ...recent.map((r) => r.duration_ms || 0))
  const timed = runs.filter((r) => r.duration_ms != null)
  const avg = timed.length ? timed.reduce((s, r) => s + (r.duration_ms || 0), 0) / timed.length : null
  const rate = stats?.success_rate ?? null
  const cards: { k: string; v: number | null; s: string; icon: React.ElementType }[] = [
    { k: 'Workflows', v: workflows.length, s: '', icon: Layers3 }, { k: 'Total runs', v: stats?.runs ?? runs.length, s: '', icon: Activity },
    { k: 'Success rate', v: rate == null ? null : rate * 100, s: '%', icon: Sparkles }, { k: 'Avg duration', v: avg, s: 'ms', icon: GitBranch },
  ]

  const demo = async () => { setBusy('demo'); await instantiateTemplate('order-router'); setBusy(''); setTimeout(() => useStore.getState().startRun(), 500) }
  const seed = async () => {
    setBusy('seed')
    try {
      const have = new Set(workflows.map((w) => w.name)), made: Workflow[] = []
      for (const t of templates) if (!have.has(t.name)) made.push(await api.useTemplate(t.id))
      const order = [...made, ...workflows].find((w) => w.name.startsWith('Order router'))
      const base = templates.find((t) => t.id === 'order-router')?.sample_payload ?? {}
      if (order) for (const qty of [3, 1, 5, 2]) { await api.run(order.id, { ...base, qty }, false); await new Promise((r) => setTimeout(r, 250)) }
      await refresh(); setTimeout(refreshRuns, 1500); toast('ok', 'Demo data loaded: templates added and sample runs executed')
    } catch (e) { toast('err', (e as Error).message) } finally { setBusy('') }
  }
  const open = (t: (typeof TILES)[number]) => { setView(t.v); if (t.ai) toast('info', 'Describe a workflow in the bar at the top of the canvas') }

  return <motion.div className="page" variants={box} initial="hidden" animate="show">
    <motion.div variants={item}><PageHead title="Dashboard" sub="Your automation workspace at a glance.">
      <button className="top-btn" onClick={seed} disabled={!!busy}>{busy === 'seed' ? 'Loading…' : 'Load demo data'}</button>
      <button className="run-btn" onClick={newWorkflow}><Plus size={14} /> New workflow</button></PageHead></motion.div>

    <motion.div className="dash-hero" variants={item}>
      <div><div className="panel-kicker">LIVE DEMO</div><h2>Build it. Run it. Watch the data flow.</h2>
        <p>One click loads the Order router template and executes it: webhook, branch, parallel email and save, merge. Every node lights up live with its real input and output.</p>
        <div className="dash-cta"><button className="run-btn" onClick={demo} disabled={!!busy}><Play size={14} fill="currentColor" /> {busy === 'demo' ? 'Preparing…' : 'Run live demo'}</button>
          <button className="top-btn" onClick={() => setView('Templates')}>Browse templates <ArrowRight size={13} /></button></div></div>
      <HeroGraph /></motion.div>

    <motion.div className="stat-grid" variants={item}>{cards.map((c) => <div className="stat-card" key={c.k}><span><c.icon size={14} /> {c.k}</span><b>{c.v == null ? '—' : <CountUp to={c.v} suffix={c.s} />}</b></div>)}</motion.div>

    <motion.div className="dash-grid" variants={item}>
      <div className="panel-card"><h3>Reliability</h3>
        <div className="donut-wrap"><div className="donut"><svg width="120" height="120" viewBox="0 0 120 120"><g transform="rotate(-90 60 60)"><circle cx="60" cy="60" r="48" fill="none" stroke="var(--soft)" strokeWidth="12" />
          <motion.circle cx="60" cy="60" r="48" fill="none" stroke="#12b76a" strokeWidth="12" strokeLinecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: rate ?? 0 }} transition={{ duration: 1, ease: 'easeOut' }} /></g></svg>
          <div className="donut-num">{rate == null ? '—' : `${Math.round(rate * 100)}%`}</div></div>
          <div className="grow">{runs.length === 0 ? <div className="empty-mini">No runs yet.</div> : STATUSES.filter((s) => by[s]).map((s) => <div className="sbar" key={s}><span>{s.replace('_', ' ')}</span>
            <div className="sbar-track"><motion.div className={`sbar-fill c-${s}`} initial={{ width: 0 }} animate={{ width: `${(by[s] / runs.length) * 100}%` }} transition={{ duration: 0.8, ease: 'easeOut' }} /></div><b>{by[s]}</b></div>)}</div></div></div>
      <div className="panel-card"><h3>Recent run durations</h3>
        {!recent.length ? <div className="empty-mini">Press <b>Run live demo</b> or <b>Load demo data</b> to see activity.</div>
          : <div className="bars">{recent.map((r, i) => <motion.div key={r.id} className={`bar c-${r.status}`} title={`${names[r.workflow_id] || r.workflow_id} · ${r.status} · ${fmtDur(r.duration_ms)}`} onClick={() => setView('Runs')}
            initial={{ height: 0 }} animate={{ height: `${Math.max(6, ((r.duration_ms || 0) / maxD) * 100)}%` }} transition={{ delay: i * 0.03, duration: 0.5, ease: 'easeOut' }} />)}</div>}</div>
    </motion.div>

    <motion.div className="panel-card" variants={item}><h3>Latest executions</h3>
      {!runs.length ? <div className="empty-mini">Nothing has run yet.</div> : runs.slice(0, 6).map((r) => <button key={r.id} className="run-row" onClick={() => setView('Runs')}>
        <StatusChip status={r.status} /><span className="grow">{names[r.workflow_id] || r.workflow_id}</span><span className="muted">{r.trigger_type}</span><span className="mono">{fmtDur(r.duration_ms)}</span><span className="muted">{ago(r.started_at)}</span><ArrowRight size={13} /></button>)}</motion.div>

    <motion.div className="tile-grid" variants={box}>{TILES.map((t) => <motion.button key={t.t} className="feat-tile" variants={item} whileTap={{ scale: 0.98 }} onClick={() => open(t)}>
      <div className="tile-icon"><t.icon size={16} /></div><h4>{t.t}</h4><p>{t.d}</p><span className="go">Open <ArrowRight size={12} /></span></motion.button>)}</motion.div>
  </motion.div>
}
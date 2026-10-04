'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { Pause, Play, RotateCcw, Square, Zap } from 'lucide-react'
import { api, type FlowEvent, type Run, type RunSummary } from '@/lib/api'
import { fromGraph } from '@/lib/graph'
import { useStore, type NodeState } from '@/lib/store'
import { JsonTree, LogLines, Timeline } from '../editor/Drawer'
import { nodeTypes, RunStateContext } from '../editor/FlowNodes'
import { Empty, PageHead, StatusChip, ago, fmtDur } from './shared'

const FILTERS = ['all', 'success', 'failed', 'running', 'cancelled', 'timed_out']

export default function RunsView() {
  const { runs, workflows, refreshRuns } = useStore()
  const [f, setF] = useState('all'), [wf, setWf] = useState('all'), [sel, setSel] = useState<string | null>(null)
  useEffect(() => { refreshRuns(); const t = setInterval(refreshRuns, 4000); return () => clearInterval(t) }, []) // eslint-disable-line
  const names = useMemo(() => Object.fromEntries(workflows.map((w) => [w.id, w.name])), [workflows])
  const rows = runs.filter((r) => (f === 'all' || r.status === f) && (wf === 'all' || r.workflow_id === wf))
  return <div className="page"><PageHead title="Runs" sub="Every execution is persisted with the input and output of each node. Open one to replay it.">
    <select className="select-input" value={wf} onChange={(e) => setWf(e.target.value)} aria-label="Filter by workflow"><option value="all">All workflows</option>{workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></PageHead>
    <div className="filter-chips">{FILTERS.map((x) => <button key={x} className={f === x ? 'on' : ''} onClick={() => setF(x)}>{x.replace('_', ' ')}{x !== 'all' && <i>{runs.filter((r) => r.status === x).length}</i>}</button>)}</div>
    <div className={`runs-layout ${sel ? 'with-detail' : ''}`}>
      <div className="table-wrap">{!rows.length ? <Empty title="No runs match" text="Run a workflow from the editor and it will show up here." /> :
        <table className="ff-table clickable"><thead><tr><th>Status</th><th>Workflow</th><th>Trigger</th><th>Duration</th><th>Started</th></tr></thead><tbody>
          {rows.map((r) => <tr key={r.id} className={sel === r.id ? 'sel' : ''} onClick={() => setSel(r.id)}><td><StatusChip status={r.status} />{r.dry_run && <span className="dry-tag">dry</span>}</td><td>{names[r.workflow_id] || r.workflow_id}</td><td>{r.trigger_type}{r.resumed_from ? ' · resumed' : ''}</td><td>{fmtDur(r.duration_ms)}</td><td>{ago(r.started_at)}</td></tr>)}</tbody></table>}</div>
      {sel && <ReactFlowProvider><RunDetail key={sel} id={sel} onClose={() => setSel(null)} onOpen={setSel} /></ReactFlowProvider>}
    </div></div>
}

function stateAt(run: Run, events: FlowEvent[], t: number): (id: string) => NodeState | undefined {
  const t0 = events.length ? new Date(events[0].ts).getTime() : 0, info: Record<string, any> = {}
  events.forEach((e) => {
    if (!e.node_id) return; const at = new Date(e.ts).getTime() - t0; const i = (info[e.node_id] ||= {})
    if (e.type === 'node_started') i.start = at; else if (e.type === 'node_succeeded' || e.type === 'node_failed') i.end = at
    else if (e.type === 'node_skipped') i.skip = at; else if (e.type === 'node_reused') i.reuse = at
    else if (e.type === 'node_retry') i.retry = Math.max(i.retry || 0, e.data.attempt)
  })
  return (id) => {
    const i = info[id], fin = run.nodes[id]; if (!i) return undefined
    if (i.skip !== undefined) return t >= i.skip ? { status: 'skipped' } : undefined
    if (i.reuse !== undefined) return t >= i.reuse ? { status: 'success', reused: true } : undefined
    if (i.start === undefined || t < i.start) return undefined
    if (i.end === undefined || t < i.end) return { status: i.retry ? 'retrying' : 'running', retry: i.retry }
    return { status: fin?.status === 'failed' ? 'failed' : 'success', duration_ms: fin?.duration_ms, attempts: fin?.attempts, handles: fin?.handles }
  }
}

function RunDetail({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const specs = useStore((s) => s.specs), refreshRuns = useStore((s) => s.refreshRuns), toast = useStore((s) => s.toast)
  const rf = useReactFlow()
  const [run, setRun] = useState<Run | null>(null), [events, setEvents] = useState<FlowEvent[]>([]), [t, setT] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false), [pick, setPick] = useState<string | null>(null), [err, setErr] = useState('')
  const raf = useRef<number>(0)
  const load = async () => { try { const [r, e] = await Promise.all([api.runDetail(id), api.runEvents(id)]); setRun(r); setEvents(e) } catch (x) { setErr((x as Error).message) } }
  useEffect(() => { load() }, [id]) // eslint-disable-line
  useEffect(() => { if (run?.status !== 'running') return; const i = setInterval(load, 1000); return () => clearInterval(i) }, [run?.status]) // eslint-disable-line
  const total = useMemo(() => (events.length > 1 ? new Date(events[events.length - 1].ts).getTime() - new Date(events[0].ts).getTime() : 1), [events])
  const live = run?.status === 'running'
  const cur = live || t === null ? total : t
  const getState = useMemo(() => (run ? stateAt(run, events, cur) : () => undefined), [run, events, cur])
  const { nodes, edges } = useMemo(() => (run ? fromGraph(run.graph, specs) : { nodes: [], edges: [] }), [run, specs])
  useEffect(() => { if (nodes.length) setTimeout(() => rf.fitView({ padding: 0.2 }), 60) }, [nodes.length]) // eslint-disable-line
  useEffect(() => {
    if (!playing) return; const start = performance.now(), from = t !== null && t < total ? t : 0, dur = Math.min(Math.max(total, 1200), 5000)
    const step = (now: number) => { const k = Math.min((now - start) / dur, 1); setT(from + (total - from) * k); if (k < 1) raf.current = requestAnimationFrame(step); else setPlaying(false) }
    raf.current = requestAnimationFrame(step); return () => cancelAnimationFrame(raf.current)
  }, [playing]) // eslint-disable-line
  const styled = useMemo(() => edges.map((e) => { const a = getState(e.source), b = getState(e.target); const skip = a?.status === 'skipped' || b?.status === 'skipped'; const taken = !!a && !!b && !skip && (a.status === 'success' || a.status === 'failed'); return { ...e, animated: taken && b?.status === 'running', style: { stroke: skip ? '#d3d9e6' : taken ? '#4f5bff' : undefined, strokeWidth: taken ? 2 : 1.3, opacity: skip ? 0.4 : 1 } } }), [edges, getState])
  const act = async (fn: () => Promise<{ run_id: string }>, msg: string) => { try { const r = await fn(); toast('ok', msg); refreshRuns(); onOpen(r.run_id) } catch (e) { toast('err', (e as Error).message) } }
  if (err) return <aside className="run-detail"><div className="issue-box">{err}</div></aside>
  if (!run) return <aside className="run-detail"><div className="empty-mini">Loading run…</div></aside>
  const labels = Object.fromEntries(nodes.map((n) => [n.id, n.data.label])), pn = pick ? run.nodes[pick] : null
  const canResume = ['failed', 'cancelled', 'timed_out'].includes(run.status)
  return <aside className="run-detail">
    <div className="rd-head"><div><div className="panel-kicker">RUN {run.id}</div><h2><StatusChip status={run.status} /> {fmtDur(run.duration_ms)}</h2><div className="hint">{run.trigger_type} trigger · v{run.workflow_version}{run.dry_run ? ' · dry run' : ''}{run.resumed_from ? ` · resumed from ${run.resumed_from}` : ''}</div></div><button className="icon-btn" onClick={onClose} aria-label="Close">✕</button></div>
    {run.error && <div className="issue-box">{run.error}</div>}
    <div className="rd-actions">
      {canResume && <button className="run-btn" onClick={() => act(() => api.resume(run.id), 'Resuming: finished nodes are reused')}><RotateCcw size={13} /> Resume from failure</button>}
      <button className="top-btn" onClick={() => act(() => api.replay(run.id), 'Replaying with the same input')}><Play size={12} /> Replay</button>
      <button className="top-btn" onClick={() => act(() => api.replay(run.id, true), 'Dry-run replay started')}><Zap size={12} /> Dry replay</button>
      {live && <button className="top-btn danger" onClick={async () => { try { await api.cancel(run.id) } catch (e) { toast('err', (e as Error).message) } }}><Square size={12} /> Cancel</button>}</div>
    <div className="scrub"><button className="icon-btn" aria-label={playing ? 'Pause' : 'Play replay'} onClick={() => setPlaying(!playing)} disabled={live}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
      <input type="range" min={0} max={Math.max(total, 1)} step={1} value={cur} disabled={live} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)) }} aria-label="Replay position" /><span className="mono">{Math.round(cur)} / {total}ms</span></div>
    <div className="rd-canvas"><RunStateContext.Provider value={getState}>
      <ReactFlow nodes={nodes} edges={styled} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} elementsSelectable fitView minZoom={0.2} onNodeClick={(_, n) => setPick(n.id)} proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} color="#C9D1E3" gap={22} size={1.2} /></ReactFlow></RunStateContext.Provider></div>
    {pn ? <div className="rd-data"><div className="data-title">{labels[pick!]} <span className="muted">· {pn.status} · {pn.attempts} attempt(s)</span></div>{pn.error && <div className="issue-box">{pn.error}</div>}<JsonTree name="input" value={pn.input ?? null} open /><JsonTree name="output" value={pn.output ?? null} open /></div>
      : <div className="hint">Click a node to inspect its input and output. Drag the slider to replay the execution.</div>}
    <div className="rd-sec">Timeline</div><Timeline events={events} /><div className="rd-sec">Log</div><div className="rd-log"><LogLines events={events} labels={labels} /></div>
  </aside>
}

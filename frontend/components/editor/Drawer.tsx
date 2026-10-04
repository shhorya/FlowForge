'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Square, X } from 'lucide-react'
import type { FlowEvent, Json } from '@/lib/api'
import { useStore } from '@/lib/store'

export function JsonTree({ value, name, open = false, depth = 0 }: { value: Json; name?: string; open?: boolean; depth?: number }) {
  const [o, setO] = useState(open || depth < 1)
  const isObj = value !== null && typeof value === 'object'
  const entries = isObj ? Object.entries(value) : []
  return <div className="json-node" style={{ paddingLeft: depth ? 16 : 0 }}>
    <div className="json-tree" onClick={() => isObj && setO(!o)} style={{ cursor: isObj ? 'pointer' : 'default' }}>
      {isObj ? (o ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <span style={{ width: 12 }} />}
      {name !== undefined && <span className="json-key">{name}</span>}
      {isObj ? <span className="json-muted">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
        : <span className={typeof value === 'string' ? 'json-value' : 'json-num'}>{typeof value === 'string' ? `"${value.length > 300 ? value.slice(0, 300) + '…' : value}"` : String(value)}</span>}
    </div>
    {isObj && o && entries.map(([k, v]) => <JsonTree key={k} name={k} value={v} depth={depth + 1} />)}
  </div>
}

export const ts = (e: FlowEvent) => e.ts.slice(11, 23)
const ms = (t: string) => new Date(t).getTime()

export function buildTimeline(events: FlowEvent[]) {
  if (!events.length) return { total: 0, bars: [] as { id: string; label: string; start: number; end: number; status: string; tries: number }[] }
  const t0 = ms(events[0].ts), bars: Record<string, any> = {}
  events.forEach((e) => {
    const id = e.node_id; if (!id) return
    const at = ms(e.ts) - t0
    if (e.type === 'node_started') bars[id] = { id, label: e.data.label || id, start: at, end: at, status: 'running', tries: 1 }
    else if (e.type === 'node_retry' && bars[id]) bars[id].tries = (e.data.attempt || 1) + 1
    else if ((e.type === 'node_succeeded' || e.type === 'node_failed') && bars[id]) { bars[id].end = at; bars[id].status = e.type === 'node_succeeded' ? 'success' : 'failed' }
  })
  const last = ms(events[events.length - 1].ts) - t0
  return { total: Math.max(last, 1), bars: Object.values(bars).map((b: any) => (b.status === 'running' ? { ...b, end: last } : b)) as any[] }
}

export function Timeline({ events }: { events: FlowEvent[] }) {
  const { total, bars } = useMemo(() => buildTimeline(events), [events])
  if (!bars.length) return <div className="empty-mini">Run the workflow to see the execution waterfall.</div>
  return <div className="timeline">{bars.map((b) => <div className="timeline-row" key={b.id}>
    <span title={b.label}>{b.label}</span>
    <div className="timeline-track"><div className={`timeline-bar ${b.status === 'failed' ? 'red' : b.status === 'running' ? 'lime' : 'indigo'}`} style={{ left: `${(b.start / total) * 100}%`, width: `${Math.max(((b.end - b.start) / total) * 100, 1.2)}%` }} /></div>
    <b>{b.end - b.start}ms{b.tries > 1 ? ` · ×${b.tries}` : ''}</b></div>)}</div>
}

export function LogLines({ events, labels }: { events: FlowEvent[]; labels: Record<string, string> }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }) }, [events.length])
  const lines = events.map((e) => {
    const n = e.node_id ? labels[e.node_id] || e.node_id : ''
    switch (e.type) {
      case 'run_started': return { k: 'info', tag: 'RUN', msg: `Run started${e.data.dry_run ? ' (dry run)' : ''}${e.data.resumed_from ? ` · resumed from ${e.data.resumed_from}` : ''}` }
      case 'node_started': return { k: 'info', tag: 'START', msg: n }
      case 'node_succeeded': return { k: 'ok', tag: 'OK', msg: `${n} finished in ${e.data.duration_ms}ms${e.data.attempts > 1 ? ` after ${e.data.attempts} attempts` : ''}${(e.data.handles || []).some((h: string) => h !== 'out') ? ` → ${e.data.handles.join(', ')}` : ''}` }
      case 'node_failed': return { k: 'err', tag: 'FAIL', msg: `${n}: ${e.data.error}` }
      case 'node_retry': return { k: 'warn', tag: 'RETRY', msg: `${n} attempt ${e.data.attempt} failed (${e.data.error}); retrying in ${e.data.retry_in}s` }
      case 'node_skipped': return { k: 'mute', tag: 'SKIP', msg: `${n} skipped (branch not taken)` }
      case 'node_reused': return { k: 'mute', tag: 'CACHE', msg: `${n} reused from previous run` }
      case 'node_error_routed': return { k: 'warn', tag: 'ROUTE', msg: `${n} failed → error branch: ${e.data.error}` }
      case 'log': return { k: e.data.level === 'error' ? 'err' : 'info', tag: 'LOG', msg: `${n}: ${e.data.message}` }
      case 'run_finished': return { k: e.data.status === 'success' ? 'ok' : 'err', tag: e.data.status?.toUpperCase(), msg: `Run ${e.data.status} in ${e.data.duration_ms}ms${e.data.error ? ' · ' + e.data.error : ''}` }
      default: return { k: 'mute', tag: e.type, msg: '' }
    }
  })
  if (!lines.length) return <div className="empty-mini">No run yet. Press <b>Run now</b> (or enable Dry run to skip side-effects).</div>
  return <div className="logs" ref={ref}>{events.map((e, i) => <div className="log-line" key={e.id}><span className="log-time">{ts(e)}</span><span className={`log-tag tag-${lines[i].k}`}>{lines[i].tag}</span><span>{lines[i].msg}</span></div>)}</div>
}

export default function Drawer() {
  const { run, drawerTab, drawerOpen, selectedId, nodes, payload } = useStore()
  const { set, setPayload, clearRun, cancelRun } = useStore.getState()
  const labels = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n.data.label])), [nodes])
  const sel = selectedId ? run?.nodes[selectedId] : undefined
  let payloadBad = false; try { JSON.parse(payload || '{}') } catch { payloadBad = true }
  const tabs = ['Logs', 'Data', 'Timeline', 'Payload'] as const
  return <section className={`bottom-drawer ${drawerOpen ? '' : 'collapsed'}`}>
    <div className="drawer-tabs">{tabs.map((t) => <button key={t} onClick={() => set({ drawerTab: t, drawerOpen: true })} className={drawerTab === t ? 'drawer-active' : ''}>{t}{t === 'Logs' && !!run?.events.length && <span className="log-count">{run.events.length}</span>}</button>)}
      <div className="drawer-spacer" />
      {run && <span className={`run-pill rp-${run.status}`}>{run.status === 'running' ? 'running…' : run.status}{run.dry ? ' · dry' : ''}</span>}
      {run?.status === 'running' && <button className="mini-btn" onClick={cancelRun}><Square size={11} /> Cancel</button>}
      {run && run.status !== 'running' && <button className="icon-btn" aria-label="Clear run" onClick={clearRun}><X size={14} /></button>}
      <button className="icon-btn" aria-label="Toggle drawer" onClick={() => set({ drawerOpen: !drawerOpen })}><ChevronDown size={15} style={{ transform: drawerOpen ? undefined : 'rotate(180deg)' }} /></button></div>
    {drawerOpen && <div className="drawer-content">
      {drawerTab === 'Logs' && <LogLines events={run?.events || []} labels={labels} />}
      {drawerTab === 'Data' && (sel && (sel.input !== undefined || sel.output !== undefined || sel.error)
        ? <div className="data-view"><div className="data-title">{labels[selectedId!]}</div>{sel.error && <div className="issue-box">{sel.error}</div>}<JsonTree name="input" value={sel.input ?? null} open /><JsonTree name="output" value={sel.output ?? null} open /></div>
        : run?.detail ? <div className="data-view"><div className="data-title">Run output</div><JsonTree name="output" value={run.detail.output ?? null} open /><div className="hint">Click a node on the canvas to inspect its input and output.</div></div>
          : <div className="empty-mini">Run the workflow, then click any node to inspect the data that flowed through it.</div>)}
      {drawerTab === 'Timeline' && <Timeline events={run?.events || []} />}
      {drawerTab === 'Payload' && <div className="payload-view"><div className="hint">JSON sent to the trigger. For webhook workflows this becomes <b>trigger.body</b>.</div><textarea className={`json-area ${payloadBad ? 'bad' : ''}`} rows={5} spellCheck={false} value={payload} onChange={(e) => setPayload(e.target.value)} />{payloadBad && <div className="hint err">Invalid JSON</div>}</div>}
    </div>}
  </section>
}

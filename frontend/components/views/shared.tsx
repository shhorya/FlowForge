'use client'
import { useMemo } from 'react'
import { Zap } from 'lucide-react'
import type { Graph, RunStatus } from '@/lib/api'
import { fromGraph, layoutTopDown, isDecision } from '@/lib/graph'
import { useStore } from '@/lib/store'

export const ago = (iso?: string | null) => {
  if (!iso) return '—'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  return s < 60 ? `${Math.floor(s)}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
}
export const fmtDur = (ms?: number | null) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`)

export function StatusChip({ status }: { status?: RunStatus | string | null }) {
  if (!status) return <span className="schip s-none">no runs</span>
  return <span className={`schip s-${status}`}><span className="status-dot" />{status.replace('_', ' ')}</span>
}

export function MiniGraph({ graph, relayout }: { graph: Graph; relayout?: boolean }) {
  const specs = useStore((s) => s.specs)
  const g = useMemo(() => {
    const { nodes, edges } = fromGraph(graph, specs)
    const ns = relayout || nodes.some((n) => !graph.nodes.find((x) => x.id === n.id)?.position) ? layoutTopDown(nodes, edges) : nodes
    if (!ns.length) return null
    const xs = ns.map((n) => n.position.x), ys = ns.map((n) => n.position.y)
    const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0 + 190, h = Math.max(...ys) - y0 + 80
    const p = Object.fromEntries(ns.map((n) => [n.id, { x: n.position.x - x0 + 10, y: n.position.y - y0 + 10, t: n.data.specType }]))
    return { w: w + 20, h: h + 20, p, edges }
  }, [graph, specs, relayout])
  if (!g) return <div className="mini-empty"><Zap size={18} /></div>
  return <svg viewBox={`0 0 ${g.w} ${g.h}`} className="mini-graph" preserveAspectRatio="xMidYMid meet">
    {g.edges.map((e, i) => { const a = g.p[e.source], b = g.p[e.target]; if (!a || !b) return null; const x1 = a.x + 85, y1 = a.y + 56, x2 = b.x + 85, y2 = b.y, my = (y1 + y2) / 2
      return <path key={i} d={`M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`} fill="none" stroke="#b7c0d3" strokeWidth={3} /> })}
    {Object.values(g.p).map((n, i) => <rect key={i} x={n.x} y={n.y} width={170} height={56} rx={isDecision(n.t) ? 28 : 16} fill={n.t.startsWith('trigger') ? '#c8f54a' : isDecision(n.t) ? '#4f5bff' : '#ffffff'} stroke="#d6dcea" strokeWidth={2} />)}
  </svg>
}

export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return <div className="page-head"><div><div className="panel-kicker">FLOWFORGE</div><h1>{title}</h1>{sub && <p>{sub}</p>}</div><div className="page-actions">{children}</div></div>
}
export const Empty = ({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) => <div className="empty-state"><div className="ce-icon"><Zap size={20} /></div><h3>{title}</h3><p>{text}</p>{children}</div>

import type { Edge, Node } from '@xyflow/react'
import {
  Activity, ArrowDown, Braces, Clock3, Database, FileJson, Filter, Globe2, GitBranch, GitFork, Layers3, ListFilter,
  MousePointer2, Send, Sparkles, Terminal, Timer, Webhook, Zap,
} from 'lucide-react'
import type { FieldSpec, Graph, GraphEdge, GraphNode, NodeSpec } from './api'

export type FFData = { specType: string; label: string; config: Record<string, any>; settings: Record<string, any> }
export type FFNode = Node<FFData>
export type FFEdge = Edge

export const ICONS: Record<string, React.ElementType> = {
  'trigger.manual': MousePointer2, 'trigger.webhook': Webhook, 'trigger.cron': Timer, 'action.http': Globe2, 'action.email': Send,
  'action.db': Database, 'action.log': Terminal, 'action.delay': Clock3, 'action.ai': Sparkles, 'action.subworkflow': Layers3,
  'logic.if': GitFork, 'logic.switch': GitBranch, 'logic.merge': ArrowDown, 'transform.set': FileJson, 'transform.map': ListFilter,
  'transform.filter': Filter, 'transform.aggregate': Activity, 'transform.json': Braces,
}
export const iconFor = (t: string): React.ElementType => ICONS[t] ?? Zap
export const isDecision = (t: string) => t === 'logic.if' || t === 'logic.switch'
export const isTrigger = (t: string) => t.startsWith('trigger.')

/** Output handles of a node, derived from its type + config (mirrors the backend). */
export function handlesOf(specType: string, config: Record<string, any>): string[] {
  if (specType === 'logic.if') return ['true', 'false']
  if (specType === 'logic.switch') return [...((config.cases as any[]) || []).map((c) => c?.handle).filter(Boolean), 'default']
  return ['out']
}

export function defaultsFor(spec?: NodeSpec): Record<string, any> {
  const out: Record<string, any> = {}
  spec?.config.forEach((f: FieldSpec) => { if (f.default !== null && f.default !== undefined) out[f.name] = JSON.parse(JSON.stringify(f.default)) })
  return out
}

const short = (v: any, n = 34) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : s }
export function summary(t: string, c: Record<string, any>): string {
  switch (t) {
    case 'trigger.webhook': return 'POST /hooks/…'
    case 'trigger.cron': return c.every_seconds ? `every ${c.every_seconds}s` : c.cron || 'set a schedule'
    case 'action.http': return `${c.method || 'GET'} ${short(c.url || '…')}`
    case 'action.email': return `to ${short(c.to || '…')}`
    case 'action.db': return `${c.operation || 'insert'} · ${c.collection || '…'}`
    case 'action.log': return short(c.message || '…')
    case 'action.delay': return `${c.seconds ?? 1}s`
    case 'action.ai': return short(c.prompt || '…')
    case 'logic.if': return short(c.condition || '…', 28)
    case 'logic.switch': return `${((c.cases as any[]) || []).length} cases`
    case 'transform.set': return `${Object.keys(c.fields || {}).length} fields`
    case 'transform.aggregate': return `${c.op || 'count'}${c.field ? ' · ' + c.field : ''}`
    case 'transform.filter': return short(c.condition || '…')
    case 'transform.map': return short(c.expression || '…')
    default: return ''
  }
}

export function fromGraph(g: Graph, specs: Record<string, NodeSpec>): { nodes: FFNode[]; edges: FFEdge[] } {
  const nodes: FFNode[] = (g.nodes || []).map((n: GraphNode, i) => ({
    id: n.id, type: isDecision(n.type) ? 'decision' : 'flowNode', position: n.position ?? { x: (i % 4) * 260, y: Math.floor(i / 4) * 170 },
    data: { specType: n.type, label: n.data?.label || specs[n.type]?.label || n.id, config: n.data?.config || {}, settings: n.data?.settings || {} },
  }))
  const edges: FFEdge[] = (g.edges || []).map((e: GraphEdge, i) => ({
    id: e.id || `e${i}-${e.source}-${e.sourceHandle || 'out'}-${e.target}`, source: e.source, target: e.target,
    sourceHandle: e.sourceHandle && e.sourceHandle !== 'out' ? e.sourceHandle : undefined, type: 'smoothstep',
    label: e.sourceHandle && e.sourceHandle !== 'out' ? e.sourceHandle : undefined,
  }))
  return { nodes, edges }
}

export function toGraph(nodes: FFNode[], edges: FFEdge[]): Graph {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.data.specType, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: { label: n.data.label, config: n.data.config, settings: n.data.settings } })),
    edges: edges.map((e) => ({ source: e.source, target: e.target, ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}) })),
  }
}

/** Layered top-down layout (longest-path depth, barycentre ordering). */
export function layoutTopDown(nodes: FFNode[], edges: FFEdge[]): FFNode[] {
  const depth: Record<string, number> = {}, parents: Record<string, string[]> = {}
  nodes.forEach((n) => { depth[n.id] = 0; parents[n.id] = [] })
  edges.forEach((e) => parents[e.target]?.push(e.source))
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false
    edges.forEach((e) => { if (depth[e.target] < depth[e.source] + 1) { depth[e.target] = depth[e.source] + 1; changed = true } })
    if (!changed) break
  }
  const levels: Record<number, string[]> = {}
  nodes.forEach((n) => (levels[depth[n.id]] ||= []).push(n.id))
  const x: Record<string, number> = {}
  Object.keys(levels).map(Number).sort((a, b) => a - b).forEach((d) => {
    const ids = levels[d]
    const bary = (id: string) => { const p = parents[id].filter((q) => x[q] !== undefined); return p.length ? p.reduce((s, q) => s + x[q], 0) / p.length : 0 }
    ids.sort((a, b) => bary(a) - bary(b))
    ids.forEach((id, i) => { x[id] = (i - (ids.length - 1) / 2) * 290 })
  })
  return nodes.map((n) => ({ ...n, position: { x: x[n.id] + 400, y: depth[n.id] * 180 + 60 } }))
}

export const nextId = (specType: string, existing: FFNode[]) => {
  const base = specType.split('.')[1]
  let i = existing.filter((n) => n.data.specType === specType).length + 1
  while (existing.some((n) => n.id === `${base}_${i}`)) i++
  return `${base}_${i}`
}

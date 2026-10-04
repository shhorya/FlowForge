import { create } from 'zustand'
import { addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type EdgeChange, type NodeChange } from '@xyflow/react'
import { api, ApiError, defaultApiUrl, setApi, streamRun, type FlowEvent, type Json, type NodeSpec, type Run, type RunSummary, type Template, type Validation, type Workflow } from './api'
import { defaultsFor, fromGraph, layoutTopDown, nextId, toGraph, type FFEdge, type FFNode } from './graph'

export type NodeState = { status: 'running' | 'success' | 'failed' | 'skipped' | 'retrying' | 'cancelled'; duration_ms?: number | null; attempts?: number; error?: string | null; reused?: boolean; handles?: string[] | null; input?: Json; output?: Json; retry?: number }
export type LiveRun = { id: string; status: string; nodes: Record<string, NodeState>; events: FlowEvent[]; startedAt: number; dry: boolean; detail?: Run }
export type View = 'Dashboard' | 'Editor' | 'Workflows' | 'Runs' | 'Templates' | 'Outbox' | 'Settings'
export type Toast = { id: number; kind: 'ok' | 'err' | 'info'; msg: string }
type Snap = { nodes: FFNode[]; edges: FFEdge[] }

export function applyEvent(run: LiveRun, ev: FlowEvent): LiveRun {
  const nodes = { ...run.nodes }, id = ev.node_id
  let status = run.status
  const cur = id ? nodes[id] : undefined
  switch (ev.type) {
    case 'node_started': if (id) nodes[id] = { ...cur, status: 'running', input: undefined, retry: cur?.retry }; break
    case 'node_retry': if (id) nodes[id] = { ...cur!, status: 'retrying', retry: ev.data.attempt, error: ev.data.error }; break
    case 'node_succeeded': if (id) nodes[id] = { ...cur!, status: 'success', duration_ms: ev.data.duration_ms, attempts: ev.data.attempts, handles: ev.data.handles, error: null }; break
    case 'node_failed': if (id) nodes[id] = { ...cur!, status: 'failed', error: ev.data.error, attempts: ev.data.attempts, duration_ms: ev.data.duration_ms }; break
    case 'node_skipped': if (id) nodes[id] = { status: 'skipped' }; break
    case 'node_reused': if (id) nodes[id] = { status: 'success', reused: true }; break
    case 'run_finished': status = ev.data.status; break
  }
  return { ...run, nodes, status, events: [...run.events, ev] }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e))
let toastId = 1, lastCommit = 0

type S = {
  ready: boolean; online: boolean | null; connError: string; apiUrl: string; apiKey: string; dark: boolean
  view: View; catalog: NodeSpec[]; specs: Record<string, NodeSpec>; workflows: Workflow[]; templates: Template[]; runs: RunSummary[]
  stats: { success_rate: number | null; runs: number } | null
  wf: Workflow | null; nodes: FFNode[]; edges: FFEdge[]; dirty: boolean; saving: boolean; savedAt: number | null
  selectedId: string | null; validation: Validation | null; payload: string; dry: boolean
  drawerTab: 'Logs' | 'Data' | 'Timeline' | 'Payload'; paletteOpen: boolean; inspectorOpen: boolean; drawerOpen: boolean
  run: LiveRun | null; stopStream: (() => void) | null; aiBusy: boolean; fitTick: number; paletteCmd: boolean
  past: Snap[]; future: Snap[]; toasts: Toast[]
  init: () => Promise<void>; setView: (v: View) => void; toast: (kind: Toast['kind'], msg: string) => void; dismissToast: (id: number) => void
  setConnection: (url: string, key: string) => Promise<void>; toggleDark: () => void
  refresh: () => Promise<void>; refreshRuns: () => Promise<void>
  openWorkflow: (w: Workflow, o?: { layout?: boolean; payload?: Json }) => void; newWorkflow: () => Promise<Workflow | null>
  instantiateTemplate: (id: string) => Promise<void>; deleteWorkflow: (id: string) => Promise<void>; duplicateWorkflow: (id: string) => Promise<void>
  setName: (n: string) => void; saveNow: () => Promise<void>; activate: (on: boolean, id?: string) => Promise<void>; validate: () => Promise<Validation | null>
  onNodesChange: (c: NodeChange<FFNode>[]) => void; onEdgesChange: (c: EdgeChange<FFEdge>[]) => void; onConnect: (c: Connection) => void
  commit: (force?: boolean) => void; undo: () => void; redo: () => void
  select: (id: string | null) => void; addNode: (specType: string, pos: { x: number; y: number }) => void
  updateNode: (id: string, patch: { label?: string; config?: Record<string, Json>; settings?: Record<string, Json> }) => void
  deleteNode: (id: string) => void; duplicateNode: (id: string) => void; autoLayout: () => void
  setPayload: (p: string) => void; setDry: (d: boolean) => void; set: (p: Partial<S>) => void
  startRun: () => Promise<void>; attachRun: (id: string, dry: boolean) => void; cancelRun: () => Promise<void>; clearRun: () => void
  generate: (prompt: string) => Promise<void>
}

export const useStore = create<S>()((set, get) => ({
  ready: false, online: null, connError: '', apiUrl: defaultApiUrl, apiKey: '', dark: false, view: 'Dashboard', catalog: [], specs: {}, workflows: [], templates: [], runs: [], stats: null,
  wf: null, nodes: [], edges: [], dirty: false, saving: false, savedAt: null, selectedId: null, validation: null, payload: '{}', dry: false,
  drawerTab: 'Logs', paletteOpen: true, inspectorOpen: true, drawerOpen: true, run: null, stopStream: null, aiBusy: false, fitTick: 0, paletteCmd: false,
  past: [], future: [], toasts: [],
  set: (p) => set(p as any),

  toast: (kind, msg) => { const id = toastId++; set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, msg }] })); setTimeout(() => get().dismissToast(id), kind === 'err' ? 7000 : 3800) },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setView: (view) => set({ view }),
  toggleDark: () => { const dark = !get().dark; try { localStorage.setItem('ff.dark', dark ? '1' : '0') } catch {} set({ dark }) },

  init: async () => {
    let url = defaultApiUrl, key = '', dark = false
    try { url = localStorage.getItem('ff.url') || url; key = localStorage.getItem('ff.key') || ''; dark = localStorage.getItem('ff.dark') === '1' } catch {}
    set({ apiUrl: url, apiKey: key, dark }); setApi(url, key)
    try {
      const [catalog, workflows, templates] = await Promise.all([api.nodes(), api.workflows(), api.templates()])
      set({ catalog, specs: Object.fromEntries(catalog.map((c) => [c.type, c])), workflows, templates, online: true, connError: '', ready: true })
      get().refreshRuns(); api.stats().then((stats) => set({ stats })).catch(() => {})
      if (workflows.length && !get().wf) { get().openWorkflow(workflows[0]); set({ view: 'Dashboard' }) }
    } catch (e) { set({ online: false, connError: errMsg(e), ready: true }) }
  },
  setConnection: async (url, key) => { try { localStorage.setItem('ff.url', url); localStorage.setItem('ff.key', key) } catch {} set({ ready: false }); await get().init() },
  refresh: async () => { try { set({ workflows: await api.workflows() }) } catch (e) { get().toast('err', errMsg(e)) } },
  refreshRuns: async () => { try { const [runs, stats] = await Promise.all([api.runs(), api.stats()]); set({ runs, stats }) } catch {} },

  openWorkflow: (w, o) => {
    get().stopStream?.()
    let nodes: FFNode[], edges: FFEdge[]
    ;({ nodes, edges } = fromGraph(w.graph, get().specs))
    if (o?.layout) nodes = layoutTopDown(nodes, edges)
    let payload = '{}'
    try { payload = localStorage.getItem('ff.payload.' + w.id) || (o?.payload !== undefined ? JSON.stringify(o.payload, null, 2) : '{}') } catch {}
    set({ wf: w, nodes, edges, dirty: !!o?.layout, selectedId: null, validation: w.validation, run: null, stopStream: null, past: [], future: [], payload, view: 'Editor', fitTick: get().fitTick + 1 })
  },
  newWorkflow: async () => {
    try { const w = await api.createWorkflow('Untitled workflow', { nodes: [], edges: [] }); get().openWorkflow(w); get().refresh(); return w } catch (e) { get().toast('err', errMsg(e)); return null }
  },
  instantiateTemplate: async (id) => {
    try { const t = get().templates.find((x) => x.id === id); const w = await api.useTemplate(id); get().openWorkflow(w, { layout: true, payload: t?.sample_payload }); get().refresh(); get().toast('ok', 'Template added to your workspace') } catch (e) { get().toast('err', errMsg(e)) }
  },
  deleteWorkflow: async (id) => {
    try { await api.remove(id); if (get().wf?.id === id) set({ wf: null, nodes: [], edges: [], run: null }); await get().refresh(); get().toast('ok', 'Workflow deleted') } catch (e) { get().toast('err', errMsg(e)) }
  },
  duplicateWorkflow: async (id) => { try { await api.duplicate(id); await get().refresh(); get().toast('ok', 'Workflow duplicated') } catch (e) { get().toast('err', errMsg(e)) } },

  setName: (n) => set((s) => (s.wf ? { wf: { ...s.wf, name: n }, dirty: true } : {})),
  saveNow: async () => {
    const { wf, nodes, edges, saving } = get(); if (!wf || saving) return
    set({ saving: true })
    const snapN = nodes, snapE = edges
    try {
      const w = await api.saveWorkflow(wf.id, { name: wf.name, graph: toGraph(nodes, edges) })
      set((s) => ({ wf: { ...s.wf!, version: w.version, updated_at: w.updated_at, webhook_path: w.webhook_path, validation: w.validation }, validation: w.validation, dirty: get().nodes !== snapN || get().edges !== snapE, savedAt: Date.now() }))
      get().refresh()
    } catch (e) { get().toast('err', 'Save failed: ' + errMsg(e)) } finally { set({ saving: false }) }
  },
  activate: async (on, id) => {
    const wid = id || get().wf?.id; if (!wid) return
    try { const w = await api.activate(wid, on); set((s) => ({ wf: s.wf?.id === wid ? { ...s.wf, active: w.active } : s.wf })); get().refresh(); get().toast('ok', on ? 'Workflow activated: schedules are live' : 'Workflow paused') } catch (e) { get().toast('err', errMsg(e)) }
  },
  validate: async () => {
    const { nodes, edges } = get()
    try { const v = await api.validate(toGraph(nodes, edges)); set({ validation: v }); get().toast(v.valid ? 'ok' : 'err', v.valid ? (v.warnings.length ? `Valid · ${v.warnings.length} warning(s)` : 'Workflow is valid') : `${v.errors.length} problem(s): ${v.errors[0]}`); return v } catch (e) { get().toast('err', errMsg(e)); return null }
  },

  commit: (force) => {
    const now = Date.now(); if (!force && now - lastCommit < 900) return
    lastCommit = now; const { nodes, edges } = get()
    set((s) => ({ past: [...s.past.slice(-49), { nodes, edges }], future: [] }))
  },
  undo: () => { const { past, nodes, edges } = get(); const p = past[past.length - 1]; if (!p) return; set((s) => ({ past: s.past.slice(0, -1), future: [{ nodes, edges }, ...s.future], nodes: p.nodes, edges: p.edges, dirty: true })) },
  redo: () => { const { future, nodes, edges } = get(); const f = future[0]; if (!f) return; set((s) => ({ future: s.future.slice(1), past: [...s.past, { nodes, edges }], nodes: f.nodes, edges: f.edges, dirty: true })) },

  onNodesChange: (changes) => {
    const structural = changes.some((c) => c.type !== 'select' && c.type !== 'dimensions')
    if (changes.some((c) => c.type === 'remove')) get().commit(true)
    set((s) => ({ nodes: applyNodeChanges(changes, s.nodes), dirty: s.dirty || structural }))
    const sel = changes.find((c) => c.type === 'select' && (c as any).selected) as any
    if (sel) set({ selectedId: sel.id })
  },
  onEdgesChange: (changes) => {
    if (changes.some((c) => c.type === 'remove')) get().commit(true)
    set((s) => ({ edges: applyEdgeChanges(changes, s.edges), dirty: s.dirty || changes.some((c) => c.type !== 'select') }))
  },
  onConnect: (c) => {
    get().commit(true)
    const label = c.sourceHandle && c.sourceHandle !== 'out' ? c.sourceHandle : undefined
    set((s) => ({ edges: addEdge({ ...c, id: `e${Date.now()}-${c.source}-${c.sourceHandle || 'out'}-${c.target}`, type: 'smoothstep', label, sourceHandle: c.sourceHandle || undefined } as FFEdge, s.edges), dirty: true }))
  },
  select: (id) => set({ selectedId: id, ...(id ? { inspectorOpen: true } : {}) }),

  addNode: (specType, pos) => {
    get().commit(true)
    const { specs, nodes } = get(); const spec = specs[specType]; if (!spec) return
    const id = nextId(specType, nodes)
    const node: FFNode = { id, type: specType === 'logic.if' || specType === 'logic.switch' ? 'decision' : 'flowNode', position: pos, data: { specType, label: spec.label, config: defaultsFor(spec), settings: {} } }
    set((s) => ({ nodes: [...s.nodes.map((n) => ({ ...n, selected: false })), { ...node, selected: true }], selectedId: id, inspectorOpen: true, dirty: true }))
  },
  updateNode: (id, patch) => {
    get().commit()
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...(patch.label !== undefined ? { label: patch.label } : {}), ...(patch.config ? { config: patch.config } : {}), ...(patch.settings ? { settings: patch.settings } : {}) } } : n)), dirty: true }))
  },
  deleteNode: (id) => { get().commit(true); set((s) => ({ nodes: s.nodes.filter((n) => n.id !== id), edges: s.edges.filter((e) => e.source !== id && e.target !== id), selectedId: s.selectedId === id ? null : s.selectedId, dirty: true })) },
  duplicateNode: (id) => {
    const { nodes } = get(); const n = nodes.find((x) => x.id === id); if (!n) return
    get().commit(true); const nid = nextId(n.data.specType, nodes)
    set((s) => ({ nodes: [...s.nodes.map((x) => ({ ...x, selected: false })), { ...n, id: nid, selected: true, position: { x: n.position.x + 40, y: n.position.y + 60 }, data: JSON.parse(JSON.stringify(n.data)) }], selectedId: nid, dirty: true }))
  },
  autoLayout: () => { get().commit(true); set((s) => ({ nodes: layoutTopDown(s.nodes, s.edges), dirty: true, fitTick: s.fitTick + 1 })) },

  setPayload: (payload) => { const id = get().wf?.id; if (id) try { localStorage.setItem('ff.payload.' + id, payload) } catch {} set({ payload }) },
  setDry: (dry) => set({ dry }),

  startRun: async () => {
    const s = get(); if (!s.wf) return
    if (!s.nodes.length) { s.toast('info', 'Add a trigger node first, or describe a workflow in the bar above'); return }
    let payload: Json
    try { payload = s.payload.trim() ? JSON.parse(s.payload) : {} } catch { s.toast('err', 'Payload is not valid JSON'); set({ drawerTab: 'Payload', drawerOpen: true }); return }
    try {
      if (s.dirty) await get().saveNow()
      const v = await api.validate(toGraph(get().nodes, get().edges)); set({ validation: v })
      if (!v.valid) { s.toast('err', `Fix before running: ${v.errors[0]}`); return }
      const r = await api.run(s.wf.id, payload, s.dry)
      get().attachRun(r.run_id, s.dry); set({ drawerTab: 'Logs', drawerOpen: true })
    } catch (e) { get().toast('err', errMsg(e)) }
  },
  attachRun: (id, dry) => {
    get().stopStream?.()
    set({ run: { id, status: 'running', nodes: {}, events: [], startedAt: Date.now(), dry } })
    const stop = streamRun(id, (ev) => set((s) => (s.run?.id === id ? { run: applyEvent(s.run, ev) } : {})), async () => {
      try {
        const detail = await api.runDetail(id)
        set((s) => {
          if (s.run?.id !== id) return {}
          const nodes = { ...s.run.nodes }
          Object.values(detail.nodes).forEach((n) => { nodes[n.node_id] = { ...nodes[n.node_id], status: n.status as NodeState['status'], input: n.input, output: n.output, error: n.error, attempts: n.attempts, duration_ms: n.duration_ms ?? nodes[n.node_id]?.duration_ms, handles: n.handles } })
          return { run: { ...s.run, detail, status: detail.status, nodes } }
        })
        const r = get().run
        if (r?.id === id) get().toast(r.status === 'success' ? 'ok' : 'err', r.status === 'success' ? `Run finished in ${((detail.duration_ms || 0) / 1000).toFixed(2)}s` : `Run ${detail.status}: ${detail.error || ''}`)
      } catch { /* ignore */ }
      get().refreshRuns()
    })
    set({ stopStream: stop })
  },
  cancelRun: async () => { const r = get().run; if (!r) return; try { await api.cancel(r.id) } catch (e) { get().toast('err', errMsg(e)) } },
  clearRun: () => { get().stopStream?.(); set({ run: null, stopStream: null }) },

  generate: async (prompt) => {
    if (!prompt.trim() || get().aiBusy) return
    set({ aiBusy: true })
    try {
      const g = await api.generate(prompt)
      if (!get().wf && !(await get().newWorkflow())) return
      const { nodes, edges } = fromGraph(g.graph, get().specs)
      const laid = layoutTopDown(nodes, edges)
      get().commit(true)
      set({ nodes: [], edges: [], selectedId: null, dirty: true, run: null, validation: g.validation })
      for (const n of laid) { await sleep(160); set((s) => ({ nodes: [...s.nodes, n], fitTick: s.fitTick + 1 })) }
      await sleep(220); set((s) => ({ edges, fitTick: s.fitTick + 1 }))
      if (get().wf?.name === 'Untitled workflow') get().setName(g.name)
      get().toast(g.validation.valid ? 'ok' : 'err', `${g.source === 'llm' ? 'Claude' : 'Offline generator'} built ${laid.length} nodes${g.warnings.length ? ' · ' + g.warnings[0] : ''}`)
    } catch (e) { get().toast('err', errMsg(e)) } finally { set({ aiBusy: false }) }
  },
}))

export const nodeIssues = (v: Validation | null, id: string) => (v?.errors || []).filter((e) => e.startsWith(`[${id}]`)).map((e) => e.replace(`[${id}] `, ''))

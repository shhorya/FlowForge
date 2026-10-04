// Typed client for the FlowForge backend (REST + SSE).
export type Json = any
export type FieldSpec = { name: string; type: 'string' | 'text' | 'number' | 'boolean' | 'select' | 'json' | 'expression'; required?: boolean; default?: Json; help?: string; options?: string[] | null }
export type NodeSpec = { type: string; label: string; category: string; description: string; config: FieldSpec[]; handles: string[] | 'dynamic'; trigger: boolean; expression_fields: string[] }
export type GraphNode = { id: string; type: string; position?: { x: number; y: number }; data: { label?: string; config?: Record<string, Json>; settings?: Record<string, Json> } }
export type GraphEdge = { id?: string; source: string; target: string; sourceHandle?: string | null }
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] }
export type Validation = { valid: boolean; errors: string[]; warnings: string[] }
export type Workflow = { id: string; name: string; description: string; graph: Graph; active: boolean; version: number; webhook_path: string; validation: Validation; updated_at: string }
export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'timed_out'
export type RunSummary = { id: string; workflow_id: string; workflow_version: number; status: RunStatus; trigger_type: string; dry_run: boolean; started_at: string; finished_at: string | null; duration_ms: number | null; error: string | null; resumed_from: string | null }
export type NodeRun = { node_id: string; status: string; attempts: number; input: Json; output: Json; handles: string[] | null; error: string | null; duration_ms: number | null }
export type Run = RunSummary & { trigger: Json; graph: Graph; output: Json; nodes: Record<string, NodeRun> }
export type FlowEvent = { id: number; run_id: string; ts: string; type: string; node_id: string | null; data: Record<string, Json> }
export type Template = { id: string; name: string; description: string; sample_payload: Json; graph: Graph }
export type Generated = { name: string; graph: Graph; source: 'llm' | 'heuristic'; warnings: string[]; validation: Validation; workflow?: Workflow }

export class ApiError extends Error {
  constructor(message: string, public status: number, public errors?: string[]) { super(message) }
}

const DEFAULT_URL = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:8000'
let cfg = { url: DEFAULT_URL, key: '' }
export const defaultApiUrl = DEFAULT_URL
export const getApi = () => cfg
export const setApi = (url: string, key: string) => { cfg = { url: (url || DEFAULT_URL).replace(/\/+$/, ''), key: key || '' } }

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(cfg.url + path, { ...init, headers: { 'Content-Type': 'application/json', ...(cfg.key ? { 'X-API-Key': cfg.key } : {}), ...(init.headers as Record<string, string>) } })
  } catch {
    throw new ApiError(`Cannot reach the FlowForge API at ${cfg.url}. Is the backend running?`, 0)
  }
  if (!res.ok) {
    let detail = res.statusText, errors: string[] | undefined
    try { const j = await res.json(); detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); errors = j.errors } catch { /* ignore */ }
    throw new ApiError(errors?.length ? errors.join(' · ') : detail, res.status, errors)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}
const post = <T,>(p: string, body?: Json) => req<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) })

export const api = {
  health: () => req<{ ok: boolean; nodes: number }>('/health'),
  stats: () => req<{ workflows: number; runs: number; success_rate: number | null; avg_duration_ms: number | null }>('/stats'),
  nodes: () => req<NodeSpec[]>('/nodes'),
  templates: () => req<Template[]>('/templates'),
  useTemplate: (id: string) => post<Workflow>(`/templates/${id}/instantiate`),
  workflows: () => req<Workflow[]>('/workflows'),
  createWorkflow: (name: string, graph: Graph) => post<Workflow>('/workflows', { name, graph }),
  saveWorkflow: (id: string, patch: Partial<Pick<Workflow, 'name' | 'graph' | 'active' | 'description'>>) => req<Workflow>(`/workflows/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  activate: (id: string, active: boolean) => post<Workflow>(`/workflows/${id}/activate`, { active }),
  duplicate: (id: string) => post<Workflow>(`/workflows/${id}/duplicate`),
  remove: (id: string) => req<void>(`/workflows/${id}`, { method: 'DELETE' }),
  exportUrl: (id: string) => `${cfg.url}/workflows/${id}/export${cfg.key ? `?api_key=${encodeURIComponent(cfg.key)}` : ''}`,
  validate: (graph: Graph) => post<Validation>('/validate', { graph }),
  run: (id: string, payload: Json, dry_run: boolean) => post<{ run_id: string }>(`/workflows/${id}/run`, { payload, dry_run }),
  runs: (workflow_id?: string) => req<RunSummary[]>(`/runs?limit=200${workflow_id ? `&workflow_id=${workflow_id}` : ''}`),
  runDetail: (id: string) => req<Run>(`/runs/${id}`),
  runEvents: (id: string) => req<FlowEvent[]>(`/runs/${id}/events`),
  cancel: (id: string) => post<{ cancelled: boolean }>(`/runs/${id}/cancel`),
  resume: (id: string) => post<{ run_id: string }>(`/runs/${id}/resume`),
  replay: (id: string, dry_run?: boolean) => post<{ run_id: string }>(`/runs/${id}/replay`, dry_run === undefined ? {} : { dry_run }),
  testNode: (type: string, config: Json, input: Json, trigger: Json) => post<{ output: Json; handles: string[] }>('/nodes/test', { type, config, input, trigger, dry_run: true }),
  generate: (prompt: string) => post<Generated>('/ai/generate', { prompt }),
  outbox: () => req<{ id: number; run_id: string; to_addr: string; subject: string; body: string; created_at: string }[]>('/outbox'),
  records: (c: string) => req<{ id: number; data: Json; created_at: string }[]>(`/records/${encodeURIComponent(c)}`),
}

const EVENT_TYPES = ['run_started', 'node_started', 'node_succeeded', 'node_failed', 'node_retry', 'node_skipped', 'node_reused', 'node_error_routed', 'log', 'run_finished']

/** Subscribe to live run events (server replays stored events first, so nothing is missed). */
export function streamRun(runId: string, onEvent: (e: FlowEvent) => void, onEnd: () => void) {
  const es = new EventSource(`${cfg.url}/runs/${runId}/stream${cfg.key ? `?api_key=${encodeURIComponent(cfg.key)}` : ''}`)
  let ended = false
  const end = () => { if (!ended) { ended = true; es.close(); onEnd() } }
  EVENT_TYPES.forEach((t) => es.addEventListener(t, (m: MessageEvent) => {
    try { const ev = JSON.parse(m.data) as FlowEvent; onEvent(ev); if (ev.type === 'run_finished') end() } catch { /* ignore malformed */ }
  }))
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) end() }
  return () => { ended = true; es.close() }
}

export const webhookUrl = (wf: Workflow) => cfg.url + wf.webhook_path

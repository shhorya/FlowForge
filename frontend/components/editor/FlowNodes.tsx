'use client'
import { createContext, useContext, useEffect } from 'react'
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import { Check, RotateCcw, X } from 'lucide-react'
import WarnIcon from '../WarnIcon'
import { handlesOf, iconFor, isTrigger, summary, type FFData } from '@/lib/graph'
import { nodeIssues, useStore, type NodeState } from '@/lib/store'

/** Lets read-only canvases (run replay) override the live run state. */
export const RunStateContext = createContext<((id: string) => NodeState | undefined) | null>(null)

function useNodeState(id: string) {
  const override = useContext(RunStateContext)
  const live = useStore((s) => s.run?.nodes[id])
  return override ? override(id) : live
}
const dur = (ms?: number | null) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`)

function StatusBits({ st }: { st?: NodeState }) {
  if (!st) return null
  return <>
    {st.status === 'success' && <div className="duration-chip">{st.reused ? 'cached' : <><Check size={9} /> {dur(st.duration_ms) || 'done'}{st.attempts && st.attempts > 1 ? ` · ${st.attempts} tries` : ''}</>}</div>}
    {st.status === 'retrying' && <div className="duration-chip chip-warn"><RotateCcw size={9} /> retry {st.retry}</div>}
    {st.status === 'failed' && <div className="duration-chip chip-err"><X size={9} /> failed</div>}
  </>
}

export function FlowNodeCard({ id, data, selected }: { id: string; data: FFData; selected?: boolean }) {
  const st = useNodeState(id)
  const issues = useStore((s) => nodeIssues(s.validation, id))
  const Icon = iconFor(data.specType), trig = isTrigger(data.specType), status = st?.status ?? 'idle'
  const detail = summary(data.specType, data.config)
  return <>
    {!trig && <Handle type="target" position={Position.Top} className="ff-handle" />}
    <div className={`flow-node ${trig ? 'trigger-node' : ''} ${selected ? 'selected-node' : ''} st-${status} ${issues.length ? 'has-issue' : ''}`} title={issues.join('\n') || undefined}>
      <div className="flex items-start gap-3">
        <div className={`node-icon ${trig ? 'node-icon-lime' : ''}`}><Icon size={16} strokeWidth={1.7} /></div>
        <div className="min-w-0 flex-1"><div className="truncate text-[12px] font-semibold tracking-[-0.01em]">{data.label}</div><div className="mt-1 text-[10px] text-[#778198]">{data.specType.replace('.', ' · ')}</div></div>
        {issues.length ? <WarnIcon size={13} className="text-[#f04438]" /> : <span className={`status-dot status-${status}`} />}
      </div>
      {detail && <div className="node-detail">{detail}</div>}
      <StatusBits st={st} />
    </div>
    <Handle type="source" position={Position.Bottom} className="ff-handle" />
    {!trig && <Handle type="source" id="error" position={Position.Right} className="ff-handle error-handle" title="error route" />}
  </>
}

export function DecisionNode({ id, data, selected }: { id: string; data: FFData; selected?: boolean }) {
  const st = useNodeState(id)
  const issues = useStore((s) => nodeIssues(s.validation, id))
  const update = useUpdateNodeInternals()
  const Icon = iconFor(data.specType), hs = handlesOf(data.specType, data.config), isIf = data.specType === 'logic.if'
  const key = hs.join('|')
  useEffect(() => { update(id) }, [key, id, update])
  const status = st?.status ?? 'idle', taken = st?.handles || []
  return <>
    <Handle type="target" position={Position.Top} className="ff-handle" />
    <div className={`decision-wrap ${selected ? 'selected-decision' : ''} st-${status} ${issues.length ? 'has-issue' : ''}`} style={!isIf ? { width: Math.max(150, hs.length * 74) } : undefined} title={issues.join('\n') || undefined}>
      <div className="decision-node" style={!isIf ? { left: '50%', marginLeft: -49 } : undefined}><Icon size={18} /><span>{data.label.length > 14 ? data.label.slice(0, 13) + '…' : data.label}</span><small>{summary(data.specType, data.config)}</small></div>
      {isIf && <><div className={`decision-label true-label ${taken.includes('true') ? 'taken' : ''}`}>true</div><div className={`decision-label false-label ${taken.includes('false') ? 'taken' : ''}`}>false</div></>}
      {st?.status === 'success' && <div className="duration-chip decision-chip"><Check size={9} /> {dur(st.duration_ms)}</div>}
    </div>
    {isIf ? <>
      <Handle type="source" id="true" position={Position.Left} className="ff-handle ff-indigo" />
      <Handle type="source" id="false" position={Position.Right} className="ff-handle ff-indigo" />
    </> : hs.map((h, i) => <Handle key={h} type="source" id={h} position={Position.Bottom} className="ff-handle ff-indigo" style={{ left: `${((i + 0.5) / hs.length) * 100}%` }}><span className="handle-name">{h}</span></Handle>)}
  </>
}

export const nodeTypes = { flowNode: FlowNodeCard, decision: DecisionNode }

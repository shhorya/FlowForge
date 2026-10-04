'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Activity, ArrowRight, Check, ChevronRight, Copy, Download, Maximize2, MousePointer2, Moon, PanelLeft, Play, Redo2, Save, Sparkles, Square, Sun, Undo2, Webhook, Zap } from 'lucide-react'
import { api, getApi, webhookUrl } from '@/lib/api'
import { isDecision } from '@/lib/graph'
import { useStore } from '@/lib/store'
import Drawer from './Drawer'
import { nodeTypes } from './FlowNodes'
import Inspector from './Inspector'
import Palette from './Palette'

const EXAMPLES = [
  'When a webhook arrives, if amount is greater than 100 send an email to boss@corp.com, otherwise log it',
  'Every 30 seconds call https://jsonplaceholder.typicode.com/todos/1 then log it',
]

function Canvas() {
  const s = useStore()
  const rf = useReactFlow()
  const wrap = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<'select' | 'pan'>('select')
  useEffect(() => { if (!s.fitTick) return; const t = setTimeout(() => rf.fitView({ padding: 0.25, duration: 450, maxZoom: 1.1 }), 80); return () => clearTimeout(t) }, [s.fitTick]) // eslint-disable-line
  const edges = useMemo(() => s.edges.map((e) => {
    const r = s.run; if (!r) return e
    const a = r.nodes[e.source], b = r.nodes[e.target]
    const skipped = a?.status === 'skipped' || b?.status === 'skipped'
    const taken = !!a && (a.status === 'success' || a.status === 'failed') && !!b && b.status !== 'skipped'
    return { ...e, animated: taken && (b?.status === 'running' || b?.status === 'retrying'), style: { stroke: skipped ? '#d3d9e6' : taken ? '#4f5bff' : undefined, strokeWidth: taken ? 2 : 1.3, opacity: skipped ? 0.4 : 1 } }
  }), [s.edges, s.run])
  const centerPos = () => { const b = wrap.current?.getBoundingClientRect(); return rf.screenToFlowPosition({ x: (b?.left ?? 0) + (b?.width ?? 600) / 2, y: (b?.top ?? 0) + (b?.height ?? 400) / 2 }) }
  const onDrop = useCallback((e: React.DragEvent) => { e.preventDefault(); const t = e.dataTransfer.getData('application/flowforge'); if (t) s.addNode(t, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })) }, [rf, s.addNode]) // eslint-disable-line
  const addAtCenter = (t: string) => { const p = centerPos(); s.addNode(t, { x: p.x - 94 + Math.random() * 30, y: p.y - 40 + Math.random() * 30 }) }
  const empty = s.wf && s.nodes.length === 0

  return <>
    <AnimatePresence>{s.paletteOpen && <Palette addAtCenter={addAtCenter} />}</AnimatePresence>
    <div className="canvas-area" ref={wrap}>
      <AiBar />
      {!s.paletteOpen && <button className="reopen-panel" onClick={() => s.set({ paletteOpen: true })} aria-label="Open node library"><PanelLeft size={16} /></button>}
      <ReactFlow<any, any> nodes={s.nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={s.onNodesChange} onEdgesChange={s.onEdgesChange} onConnect={s.onConnect}
        onNodeDragStart={() => s.commit(true)} onNodeClick={(_, n) => { s.select(n.id); if (s.run) s.set({ drawerTab: 'Data', drawerOpen: true }) }} onPaneClick={() => s.select(null)}
        onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }} panOnDrag={tool === 'pan' ? true : [1, 2]} selectionOnDrag={tool === 'select'}
        fitView fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }} minZoom={0.3} maxZoom={1.5} deleteKeyCode={['Backspace', 'Delete']} proOptions={{ hideAttribution: true }} defaultEdgeOptions={{ type: 'smoothstep' }}>
        <Background variant={BackgroundVariant.Dots} color="#C9D1E3" gap={22} size={1.2} />
        <MiniMap className="mini-map" pannable zoomable nodeColor={(n: any) => (isDecision(n.data?.specType) ? '#4F5BFF' : n.data?.specType?.startsWith('trigger') ? '#C8F54A' : '#CBD3E4')} maskColor="rgba(238,242,249,.74)" />
        <Controls className="flow-controls" showInteractive={false} />
      </ReactFlow>
      {empty && <motion.div className="canvas-empty" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <div className="ce-icon"><Zap size={20} /></div><h3>Start with a trigger</h3><p>Drag nodes from the library, or describe what you want and let the generator draft the graph.</p>
        <div className="ce-chips">{EXAMPLES.map((x) => <button key={x} onClick={() => s.generate(x)}><Sparkles size={12} /> {x}</button>)}</div>
        <button className="link-btn" onClick={() => s.setView('Templates')}>Or browse templates <ArrowRight size={12} /></button></motion.div>}
      <div className="canvas-tools">
        <button className={tool === 'select' ? 'tool-active' : ''} aria-label="Select" title="Select" onClick={() => setTool('select')}><MousePointer2 size={16} /></button>
        <button className={tool === 'pan' ? 'tool-active' : ''} aria-label="Pan" title="Pan" onClick={() => setTool('pan')}><span className="hand-icon">✋</span></button>
        <button aria-label="Auto layout" title="Auto layout" onClick={s.autoLayout}><Maximize2 size={16} /></button>
        <div className="tool-divider" />
        <button aria-label="Undo" title="Undo (Ctrl+Z)" onClick={s.undo} disabled={!s.past.length}><Undo2 size={16} /></button>
        <button aria-label="Redo" title="Redo" onClick={s.redo} disabled={!s.future.length}><Redo2 size={16} /></button>
        <button aria-label="Fit view" title="Fit view" onClick={() => rf.fitView({ padding: 0.25, duration: 400 })}><Square size={14} /></button>
      </div>
      <div className="canvas-status"><span className={`status-dot status-${s.run ? (s.run.status === 'running' ? 'running' : s.run.status === 'success' ? 'success' : 'failed') : 'idle'}`} />{s.run ? `Run ${s.run.status}` : 'Ready'}<span className="status-sep" />{s.nodes.length} nodes · {s.edges.length} links</div>
    </div>
    <AnimatePresence>{s.inspectorOpen && s.selectedId && s.nodes.some((n) => n.id === s.selectedId) && <Inspector key={s.selectedId} />}</AnimatePresence>
  </>
}

function AiBar() {
  const { generate, aiBusy } = useStore()
  const [v, setV] = useState('')
  const go = () => { if (v.trim()) { generate(v); setV('') } }
  return <div className={`ai-bar ${aiBusy ? 'busy' : ''}`}><Sparkles size={16} className="ai-spark" />
    <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} disabled={aiBusy} placeholder={aiBusy ? 'Building your workflow…' : 'Describe a workflow in plain English'} aria-label="Describe a workflow in plain English" />
    <button aria-label="Generate workflow" onClick={go} disabled={aiBusy}><ArrowRight size={15} /></button></div>
}

export default function Editor() {
  const s = useStore()
  const [copied, setCopied] = useState(false)
  // debounced autosave
  useEffect(() => { if (!s.dirty || !s.wf || s.run?.status === 'running') return; const t = setTimeout(() => useStore.getState().saveNow(), 1600); return () => clearTimeout(t) }, [s.dirty, s.nodes, s.edges, s.wf?.name]) // eslint-disable-line
  const hook = s.wf && s.nodes.some((n) => n.data.specType === 'trigger.webhook')
  const copyHook = async () => { if (!s.wf) return; try { await navigator.clipboard.writeText(webhookUrl(s.wf)); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { s.toast('err', 'Clipboard unavailable') } }
  if (!s.wf) return <div className="editor-empty"><div className="ce-icon"><Zap size={22} /></div><h3>{s.online === false ? 'Backend not reachable' : 'No workflow open'}</h3>
    <p>{s.online === false ? s.connError : 'Create a workflow from scratch, or start from a template that already runs end to end.'}</p>
    <div className="ce-actions">{s.online === false ? <button className="run-btn" onClick={() => s.setView('Settings')}>Open settings</button> : <><button className="run-btn" onClick={s.newWorkflow}>New workflow</button><button className="top-btn" onClick={() => s.setView('Templates')}>Browse templates</button></>}</div></div>
  const running = s.run?.status === 'running'
  const saveText = s.saving ? 'Saving…' : s.dirty ? 'Unsaved changes' : s.savedAt ? 'Saved' : `v${s.wf.version}`
  return <>
    <header className="topbar">
      <div className="workflow-meta"><div className="workflow-symbol"><Activity size={15} /></div>
        <div><div className="eyebrow">WORKFLOW</div><input className="workflow-name name-input" value={s.wf.name} onChange={(e) => s.setName(e.target.value)} aria-label="Workflow name" /></div><span className="version">v{s.wf.version}</span></div>
      <div className="top-actions">
        <span className="save-state"><span className={`save-dot ${!s.dirty && !s.saving ? 'saved' : ''}`} />{saveText}</span>
        <button className="top-btn" onClick={() => s.saveNow()}><Save size={14} /> Save</button>
        <button className="top-btn hidden md:flex" onClick={() => s.validate()}><Check size={14} /> Validate</button>
        <label className="dry-toggle hidden lg:flex" title="Skip emails, writes and non-GET calls"><input type="checkbox" checked={s.dry} onChange={(e) => s.setDry(e.target.checked)} /> Dry run</label>
        <button className="run-btn" onClick={() => (running ? s.cancelRun() : s.startRun())}>{running ? <><Square size={13} fill="currentColor" /> Stop</> : <><Play size={14} fill="currentColor" /> Run now</>}</button>
        <button className="activate" onClick={() => s.activate(!s.wf!.active)} title="Active workflows run their schedule triggers"><span className={`status-dot ${s.wf.active ? 'status-success' : 'status-idle'}`} /> {s.wf.active ? 'Active' : 'Paused'}</button>
        <button className="icon-btn theme-btn" aria-label="Toggle theme" onClick={s.toggleDark}>{s.dark ? <Sun size={16} /> : <Moon size={16} />}</button>
      </div></header>
    <div className="subbar"><div className="crumb"><span>Automations</span><ChevronRight size={13} /><strong>{s.wf.name}</strong></div>
      <div className="sub-actions">
        {hook && <button className="chip-btn" onClick={copyHook} title={webhookUrl(s.wf)}><Webhook size={12} /> {copied ? 'Copied' : 'Copy webhook URL'} <Copy size={11} /></button>}
        {s.validation && !s.validation.valid && <span className="stat-chip chip-bad">{s.validation.errors.length} issue(s)</span>}
        {s.validation?.valid && s.validation.warnings.length > 0 && <span className="stat-chip chip-warn-s" title={s.validation.warnings.join('\n')}>{s.validation.warnings.length} warning(s)</span>}
        {s.stats?.success_rate != null && <span className="stat-chip"><Activity size={13} /> {(s.stats.success_rate * 100).toFixed(0)}% success</span>}
        <a className="chip-btn" href={api.exportUrl(s.wf.id)} target="_blank" rel="noreferrer" aria-label="Export JSON"><Download size={12} /> Export</a></div></div>
    <section className="workspace"><ReactFlowProvider><Canvas /></ReactFlowProvider></section>
    <Drawer />
  </>
}

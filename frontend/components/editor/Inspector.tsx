'use client'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Copy, Trash2, X, Zap } from 'lucide-react'
import { api, type FieldSpec, type Json } from '@/lib/api'
import { iconFor } from '@/lib/graph'
import { nodeIssues, useStore } from '@/lib/store'
import { JsonTree } from './Drawer'

function JsonField({ value, onChange }: { value: Json; onChange: (v: Json) => void }) {
  const [text, setText] = useState(() => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)))
  const [bad, setBad] = useState(false)
  const commit = (t: string) => { if (!t.trim()) { onChange(undefined); setBad(false); return } try { onChange(JSON.parse(t)); setBad(false) } catch { if (t.includes('{{')) { onChange(t); setBad(false) } else setBad(true) } }
  return <><textarea className={`json-area ${bad ? 'bad' : ''}`} value={text} spellCheck={false} rows={4} onChange={(e) => { setText(e.target.value); commit(e.target.value) }} />{bad && <div className="hint err">Invalid JSON (templates like {'{{ input.x }}'} are fine inside strings)</div>}</>
}

function Field({ f, value, onChange }: { f: FieldSpec; value: Json; onChange: (v: Json) => void }) {
  const common = { 'aria-label': f.name }
  switch (f.type) {
    case 'text': return <textarea className="json-area plain" rows={3} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...common} />
    case 'number': return <div className="input-wrap"><input type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} {...common} /></div>
    case 'boolean': return <label className="toggle"><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} {...common} /><span /></label>
    case 'select': return <select className="select-input" value={value ?? f.options?.[0] ?? ''} onChange={(e) => onChange(e.target.value)} {...common}>{(f.options || []).map((o) => <option key={o}>{o}</option>)}</select>
    case 'json': return <JsonField value={value} onChange={onChange} />
    case 'expression': return <div className="code-input"><span className="line-num">ƒ</span><input className="expr-input" spellCheck={false} value={typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)} onChange={(e) => onChange(e.target.value)} {...common} /></div>
    default: return <div className="input-wrap"><input value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={f.help || ''} {...common} /></div>
  }
}

export default function Inspector() {
  const { nodes, selectedId, specs, run, validation, payload } = useStore()
  const { updateNode, deleteNode, duplicateNode, set, toast } = useStore.getState()
  const node = nodes.find((n) => n.id === selectedId)
  const [test, setTest] = useState<{ ok: boolean; body: Json } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => setTest(null), [selectedId])
  if (!node) return null
  const spec = specs[node.data.specType]
  const Icon = iconFor(node.data.specType)
  const issues = nodeIssues(validation, node.id)
  const setCfg = (name: string, v: Json) => { const c = { ...node.data.config }; if (v === undefined) delete c[name]; else c[name] = v; updateNode(node.id, { config: c }) }
  const setSet = (name: string, v: Json) => updateNode(node.id, { settings: { ...node.data.settings, [name]: v } })
  const runTest = async () => {
    setBusy(true)
    try {
      let trig: Json = {}; try { trig = JSON.parse(payload || '{}') } catch {}
      const up = run?.nodes[node.id]?.input ?? {}
      const r = await api.testNode(node.data.specType, node.data.config, up, trig); setTest({ ok: true, body: r.output })
    } catch (e) { setTest({ ok: false, body: (e as Error).message }); toast('err', 'Test failed') } finally { setBusy(false) }
  }
  return <motion.aside initial={{ x: 18, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 18, opacity: 0 }} className="inspector">
    <div className="inspector-header"><div className="inspector-title"><div className="node-icon"><Icon size={16} /></div><div><div className="panel-kicker">{spec?.category || 'Node'} · {node.id}</div><h2>{spec?.label}</h2></div></div><button className="icon-btn" onClick={() => set({ inspectorOpen: false })} aria-label="Close inspector"><X size={16} /></button></div>
    <div className="inspector-scroll">
      {issues.length > 0 && <div className="issue-box">{issues.map((i) => <div key={i}>{i}</div>)}</div>}
      <div className="inspector-section"><div className="section-title">Label</div><div className="input-wrap"><input value={node.data.label} onChange={(e) => updateNode(node.id, { label: e.target.value })} aria-label="Node label" /></div><div className="hint">{spec?.description}</div></div>
      {spec && spec.config.length > 0 && <div className="inspector-section"><div className="section-title">Configuration</div>
        {spec.config.map((f) => <div key={f.name}><label className="field-label"><span>{f.name.replace(/_/g, ' ')}{f.required && <span className="required"> required</span>}</span>{f.type === 'expression' && <em className="ftag">expression</em>}</label><Field f={f} value={node.data.config[f.name]} onChange={(v) => setCfg(f.name, v)} />{f.help && f.type !== 'string' && <div className="hint">{f.help}</div>}</div>)}
        <div className="hint">Use <b>trigger</b>, <b>input</b>, <b>nodes.id.output</b>, <b>vars</b>; templates: <b>{'{{ input.total * 2 }}'}</b></div></div>}
      {spec && !spec.trigger && <div className="inspector-section"><div className="section-title">Reliability</div>
        <div className="setting-row"><span>Retries (0–5)</span><input type="number" min={0} max={5} value={node.data.settings.retries ?? 0} onChange={(e) => setSet('retries', Math.max(0, Math.min(5, Number(e.target.value))))} /></div>
        <div className="setting-row"><span>Backoff (s)</span><input type="number" min={0} step={0.1} value={node.data.settings.backoff ?? 0.5} onChange={(e) => setSet('backoff', Number(e.target.value))} /></div>
        <div className="setting-row"><span>Timeout (s)</span><input type="number" min={1} value={node.data.settings.timeout ?? 30} onChange={(e) => setSet('timeout', Number(e.target.value))} /></div>
        <div className="hint">Connect the red handle on the right to build an error route.</div></div>}
      <button className="test-button" onClick={runTest} disabled={busy}><Zap size={14} /> {busy ? 'Testing…' : 'Test step (dry run)'}</button>
      {test && <div className={`test-result ${test.ok ? '' : 'err'}`}>{test.ok ? <JsonTree value={test.body} open /> : String(test.body)}</div>}
      <div className="inspector-footer"><button className="danger-button" onClick={() => deleteNode(node.id)}><Trash2 size={14} /> Delete node</button><button className="icon-btn" aria-label="Duplicate node" onClick={() => duplicateNode(node.id)}><Copy size={15} /></button></div>
    </div>
  </motion.aside>
}

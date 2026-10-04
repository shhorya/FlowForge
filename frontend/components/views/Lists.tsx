'use client'
import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Copy, Download, Play, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useStore } from '@/lib/store'
import { Empty, MiniGraph, PageHead, StatusChip, ago } from './shared'

export function WorkflowsView() {
  const { workflows, runs, openWorkflow, newWorkflow, deleteWorkflow, duplicateWorkflow, activate, startRun, setView } = useStore()
  const last = useMemo(() => { const m: Record<string, string> = {}; runs.forEach((r) => { if (!m[r.workflow_id]) m[r.workflow_id] = r.status }); return m }, [runs])
  return <div className="page"><PageHead title="Workflows" sub="Everything you have built. Open one to edit, or run it right from here."><button className="run-btn" onClick={newWorkflow}><Plus size={14} /> New workflow</button></PageHead>
    {!workflows.length ? <Empty title="No workflows yet" text="Create one from scratch or start from a template."><button className="top-btn" onClick={() => setView('Templates')}>Browse templates</button></Empty>
      : <div className="card-grid">{workflows.map((w, i) => <motion.div key={w.id} className="wcard" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.04, 0.3) }}>
        <button className="wcard-preview" onClick={() => openWorkflow(w)} aria-label={`Open ${w.name}`}><MiniGraph graph={w.graph} /></button>
        <div className="wcard-body"><div className="wcard-title"><h3>{w.name}</h3><StatusChip status={last[w.id]} /></div>
          <div className="wcard-meta">{w.graph.nodes.length} nodes · v{w.version} · edited {ago(w.updated_at)}</div>
          <div className="wcard-actions"><button className="top-btn" onClick={() => { openWorkflow(w); setTimeout(() => startRun(), 120) }}><Play size={12} /> Run</button>
            <button className={`activate ${w.active ? 'on' : ''}`} onClick={() => activate(!w.active, w.id)}><span className={`status-dot ${w.active ? 'status-success' : 'status-idle'}`} /> {w.active ? 'Active' : 'Paused'}</button>
            <span className="grow" /><button className="icon-btn" aria-label="Duplicate" onClick={() => duplicateWorkflow(w.id)}><Copy size={14} /></button>
            <a className="icon-btn" aria-label="Export" href={api.exportUrl(w.id)} target="_blank" rel="noreferrer"><Download size={14} /></a>
            <button className="icon-btn danger" aria-label="Delete" onClick={() => confirm(`Delete “${w.name}”?`) && deleteWorkflow(w.id)}><Trash2 size={14} /></button></div></div></motion.div>)}</div>}</div>
}

export function TemplatesView() {
  const { templates, instantiateTemplate } = useStore()
  const [busy, setBusy] = useState('')
  return <div className="page"><PageHead title="Templates" sub="Real workflows that execute end to end: webhooks, branching, parallel steps, retries and error routes." />
    <div className="card-grid big">{templates.map((t, i) => <motion.div key={t.id} className="wcard" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}>
      <div className="wcard-preview static"><MiniGraph graph={t.graph} relayout /></div>
      <div className="wcard-body"><h3>{t.name}</h3><p className="wcard-desc">{t.description}</p>
        <div className="wcard-actions"><span className="wcard-meta">{t.graph.nodes.length} nodes</span><span className="grow" /><button className="run-btn" disabled={busy === t.id} onClick={async () => { setBusy(t.id); await instantiateTemplate(t.id); setBusy('') }}>{busy === t.id ? 'Adding…' : 'Use template'}</button></div></div></motion.div>)}</div>
    {!templates.length && <Empty title="No templates" text="The backend returned no templates." />}</div>
}

export function OutboxView() {
  const [mails, setMails] = useState<Awaited<ReturnType<typeof api.outbox>> | null>(null)
  const [coll, setColl] = useState('priority_orders'), [recs, setRecs] = useState<Awaited<ReturnType<typeof api.records>> | null>(null)
  const [err, setErr] = useState('')
  const load = async () => { setErr(''); try { setMails(await api.outbox()); setRecs(await api.records(coll)) } catch (e) { setErr((e as Error).message) } }
  useEffect(() => { load() }, []) // eslint-disable-line
  return <div className="page"><PageHead title="Outbox & data" sub="Emails sent by workflows (when SMTP isn't configured) and records saved by Data Store nodes."><button className="top-btn" onClick={load}>Refresh</button></PageHead>
    {err && <div className="issue-box">{err}</div>}
    <h2 className="section-h">Emails</h2>
    {mails && !mails.length ? <Empty title="Outbox is empty" text="Run the Order router template with a total of 100 or more." /> : <div className="table-wrap"><table className="ff-table"><thead><tr><th>Sent</th><th>To</th><th>Subject</th><th>Body</th><th>Run</th></tr></thead><tbody>{mails?.map((m) => <tr key={m.id}><td>{ago(m.created_at)}</td><td>{m.to_addr}</td><td>{m.subject}</td><td className="mono clip">{m.body}</td><td className="mono">{m.run_id}</td></tr>)}</tbody></table></div>}
    <h2 className="section-h">Records <input className="inline-input" value={coll} onChange={(e) => setColl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} aria-label="Collection name" /></h2>
    {recs && !recs.length ? <div className="empty-mini">No records in “{coll}”.</div> : <div className="table-wrap"><table className="ff-table"><thead><tr><th>#</th><th>Created</th><th>Data</th></tr></thead><tbody>{recs?.map((r) => <tr key={r.id}><td>{r.id}</td><td>{ago(r.created_at)}</td><td className="mono clip">{JSON.stringify(r.data)}</td></tr>)}</tbody></table></div>}</div>
}

export function SettingsView() {
  const { apiUrl, apiKey, online, connError, setConnection, dark, toggleDark, stats, catalog } = useStore()
  const [u, setU] = useState(apiUrl), [k, setK] = useState(apiKey)
  return <div className="page narrow"><PageHead title="Settings" sub="Connection to the FlowForge engine." />
    <div className="set-card"><div className="set-row"><span className={`status-dot ${online ? 'status-success' : 'status-failed'}`} /><b>{online ? 'Connected' : 'Not connected'}</b><span className="muted">{online ? `${catalog.length} node types · ${stats?.runs ?? 0} runs recorded` : connError}</span></div>
      <label className="field-label">API URL</label><div className="input-wrap"><input value={u} onChange={(e) => setU(e.target.value)} aria-label="API URL" /></div>
      <label className="field-label">API key (optional)</label><div className="input-wrap"><input type="password" value={k} onChange={(e) => setK(e.target.value)} placeholder="Only if FLOWFORGE_API_KEY is set on the server" aria-label="API key" /></div>
      <div className="set-row"><button className="run-btn" onClick={() => setConnection(u, k)}>Save & reconnect</button><button className="top-btn" onClick={toggleDark}>{dark ? 'Light theme' : 'Dark theme'}</button></div></div></div>
}

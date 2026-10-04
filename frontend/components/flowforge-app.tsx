'use client'
import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Activity, Archive, GitBranch, LayoutDashboard, LayoutGrid, Layers3, Search, Settings2, Zap } from 'lucide-react'
import { useStore, type View } from '@/lib/store'
import WarnIcon from './WarnIcon'
import CommandPalette from './CommandPalette'
import Editor from './editor/Editor'
import { OutboxView, SettingsView, TemplatesView, WorkflowsView } from './views/Lists'
import RunsView from './views/RunsView'
import Dashboard from './views/Dashboard'

const NAV: [View, React.ElementType][] = [['Dashboard', LayoutDashboard], ['Editor', GitBranch], ['Workflows', Layers3], ['Runs', Activity], ['Templates', LayoutGrid], ['Outbox', Archive], ['Settings', Settings2]]

export default function FlowForgeApp() {
  const s = useStore()
  useEffect(() => { useStore.getState().init() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey, st = useStore.getState(), tag = (e.target as HTMLElement)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); st.set({ paletteCmd: !st.paletteCmd }) }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); st.saveNow() }
      else if (mod && e.key === 'Enter') { e.preventDefault(); st.startRun() }
      else if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? st.redo() : st.undo() }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [])
  return <div className={s.dark ? 'flowforge dark' : 'flowforge'}>
    <aside className="rail">
      <div className="brand-mark"><Zap size={19} fill="currentColor" /></div>
      <div className="rail-group">{NAV.slice(0, 6).map(([label, Icon]) => <button key={label} aria-label={label} title={label} onClick={() => s.setView(label)} className={`rail-button ${s.view === label ? 'rail-active' : ''}`}><Icon size={17} /></button>)}</div>
      <div className="mt-auto rail-group"><button className="rail-button" aria-label="Search" title="Command palette (Ctrl+K)" onClick={() => s.set({ paletteCmd: true })}><Search size={17} /></button>
        <button className={`rail-button ${s.view === 'Settings' ? 'rail-active' : ''}`} aria-label="Settings" title="Settings" onClick={() => s.setView('Settings')}><Settings2 size={17} /></button></div>
    </aside>
    <main className={`main-area ${s.view === 'Editor' ? '' : 'page-mode'}`}>
      {s.online === false && s.view !== 'Settings' && <div className="banner"><WarnIcon size={14} /> {s.connError || 'Backend not reachable.'} <button onClick={() => s.setView('Settings')}>Connection settings</button><button onClick={() => s.init()}>Retry</button></div>}
      {!s.ready ? <div className="boot"><Zap size={22} className="boot-spin" /> Connecting to FlowForge…</div>
        : <AnimatePresence mode="wait"><motion.div key={s.view} className="view-wrap" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
          {s.view === 'Dashboard' ? <Dashboard /> : s.view === 'Editor' ? <Editor /> : s.view === 'Workflows' ? <WorkflowsView /> : s.view === 'Runs' ? <RunsView /> : s.view === 'Templates' ? <TemplatesView /> : s.view === 'Outbox' ? <OutboxView /> : <SettingsView />}
        </motion.div></AnimatePresence>}
    </main>
    <CommandPalette />
    <div className="toasts" role="status" aria-live="polite"><AnimatePresence>{s.toasts.map((t) => <motion.div key={t.id} className={`toast t-${t.kind}`} initial={{ opacity: 0, y: 14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 30 }} onClick={() => s.dismissToast(t.id)}>{t.msg}</motion.div>)}</AnimatePresence></div>
  </div>
}

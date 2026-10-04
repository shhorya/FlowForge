'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Search } from 'lucide-react'
import { useStore, type View } from '@/lib/store'

export default function CommandPalette() {
  const s = useStore()
  const [q, setQ] = useState(''), [i, setI] = useState(0)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (s.paletteCmd) { setQ(''); setI(0); setTimeout(() => ref.current?.focus(), 30) } }, [s.paletteCmd])
  const items = useMemo(() => {
    const go = (v: View) => ({ label: `Go to ${v}`, hint: 'View', run: () => s.setView(v) })
    const all = [
      { label: 'Run current workflow', hint: 'Ctrl+Enter', run: () => { s.setView('Editor'); s.startRun() } },
      { label: 'Save workflow', hint: 'Ctrl+S', run: () => s.saveNow() },
      { label: 'Validate workflow', hint: 'Check', run: () => s.validate() },
      { label: 'Auto-layout canvas', hint: 'Canvas', run: () => { s.setView('Editor'); s.autoLayout() } },
      { label: 'New workflow', hint: 'Create', run: () => s.newWorkflow() },
      { label: 'Toggle dark mode', hint: 'Theme', run: s.toggleDark },
      ...(['Editor', 'Workflows', 'Runs', 'Templates', 'Outbox', 'Settings'] as View[]).map(go),
      ...s.workflows.map((w) => ({ label: `Open “${w.name}”`, hint: 'Workflow', run: () => s.openWorkflow(w) })),
      ...s.templates.map((t) => ({ label: `Use template: ${t.name}`, hint: 'Template', run: () => s.instantiateTemplate(t.id) })),
      ...s.catalog.map((c) => ({ label: `Add node: ${c.label}`, hint: c.category, run: () => { s.setView('Editor'); s.addNode(c.type, { x: 380 + Math.random() * 80, y: 120 + Math.random() * 200 }) } })),
    ]
    return all.filter((x) => x.label.toLowerCase().includes(q.toLowerCase())).slice(0, 9)
  }, [q, s.workflows, s.templates, s.catalog, s.wf]) // eslint-disable-line
  const exec = (n: number) => { const it = items[n]; if (it) { s.set({ paletteCmd: false }); it.run() } }
  return <AnimatePresence>{s.paletteCmd && <motion.div className="cmdk-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => s.set({ paletteCmd: false })}>
    <motion.div className="cmdk" initial={{ y: -12, scale: 0.98 }} animate={{ y: 0, scale: 1 }} onClick={(e) => e.stopPropagation()}>
      <div className="cmdk-input"><Search size={15} /><input ref={ref} value={q} onChange={(e) => { setQ(e.target.value); setI(0) }} placeholder="Type a command, workflow or node…" aria-label="Command palette"
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setI((i + 1) % Math.max(items.length, 1)) } else if (e.key === 'ArrowUp') { e.preventDefault(); setI((i - 1 + items.length) % Math.max(items.length, 1)) } else if (e.key === 'Enter') exec(i); else if (e.key === 'Escape') s.set({ paletteCmd: false }) }} /></div>
      <div className="cmdk-list">{items.map((it, n) => <button key={it.label + n} className={n === i ? 'on' : ''} onMouseEnter={() => setI(n)} onClick={() => exec(n)}><span>{it.label}</span><kbd>{it.hint}</kbd></button>)}{!items.length && <div className="empty-mini">Nothing found</div>}</div></motion.div></motion.div>}</AnimatePresence>
}

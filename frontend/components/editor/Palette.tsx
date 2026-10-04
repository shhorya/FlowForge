'use client'
import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { GripVertical, PanelLeft, Search } from 'lucide-react'
import { iconFor, isTrigger } from '@/lib/graph'
import { useStore } from '@/lib/store'

const TABS = ['All', 'Triggers', 'Actions', 'Logic', 'Data']

export default function Palette({ addAtCenter }: { addAtCenter: (type: string) => void }) {
  const catalog = useStore((s) => s.catalog)
  const set = useStore((s) => s.set)
  const [tab, setTab] = useState('All'), [q, setQ] = useState('')
  const items = useMemo(() => catalog.filter((c) => (tab === 'All' || c.category === tab) && (c.label + c.description).toLowerCase().includes(q.toLowerCase())), [catalog, tab, q])
  return <motion.aside initial={{ x: -16, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -16, opacity: 0 }} className="palette-panel">
    <div className="panel-heading"><div><div className="panel-kicker">BUILD</div><h2>Node library</h2></div><button className="icon-btn" onClick={() => set({ paletteOpen: false })} aria-label="Collapse node library"><PanelLeft size={16} /></button></div>
    <div className="search-box"><Search size={14} /><input placeholder="Search nodes" aria-label="Search nodes" value={q} onChange={(e) => setQ(e.target.value)} /></div>
    <div className="category-tabs">{TABS.map((t) => <button key={t} className={tab === t ? 'tab-active' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
    <div className="palette-scroll"><div className="group-label">{tab === 'All' ? 'All nodes' : tab} <span>{items.length}</span></div>
      <div className="palette-grid">{items.map((item, i) => { const Icon = iconFor(item.type); return (
        <motion.div key={item.type} className="tile-wrap" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.02, 0.3) }}>
          <button className="palette-tile" draggable title={item.description}
            onDragStart={(e: React.DragEvent) => { e.dataTransfer.setData('application/flowforge', item.type); e.dataTransfer.effectAllowed = 'move' }} onClick={() => addAtCenter(item.type)}>
            <div className={`tile-icon ${isTrigger(item.type) ? 'tile-lime' : ''}`}><Icon size={15} /></div><span>{item.label}</span><small>{item.category}</small>
          </button></motion.div>) })}
        {!items.length && <div className="empty-mini">No nodes match “{q}”</div>}
      </div></div>
    <div className="palette-foot"><div className="drag-hint"><GripVertical size={14} /> Drag to canvas or click</div></div>
  </motion.aside>
}

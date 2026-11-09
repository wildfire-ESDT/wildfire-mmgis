import { useEffect, useState } from 'react'
import { getMap, coveredEdges } from '../../utils'

const MAP_CONTROLS = 56 // the zoom buttons on the map's right edge

// Where the tool sits: fixed at the map's top right, left of the zoom buttons. It never moves when
// the map pans or zooms; the map is brought to it instead (on open, and by "Center on the fire").
export default function useDocked(ref, open) {
    const [pos, setPos] = useState(null)
    useEffect(() => {
        const m = getMap()
        if (!open || !m) return undefined
        const place = () => {
            const r = m.getContainer().getBoundingClientRect()
            const covered = coveredEdges(m.getContainer())
            const w = ref.current ? ref.current.offsetWidth : 296
            const left = Math.max(r.left + covered.left + 8, r.right - covered.right - MAP_CONTROLS - w)
            const top = r.top + covered.top + 12
            const maxY = r.bottom - covered.bottom - 12
            setPos({ left, top, maxHeight: Math.max(160, maxY - top), sideFits: false })
        }
        const raf = requestAnimationFrame(place)
        const settle = setTimeout(place, 1500) // once the time bar has laid out
        m.on('resize', place)
        window.addEventListener('resize', place)
        return () => {
            cancelAnimationFrame(raf)
            clearTimeout(settle)
            m.off('resize', place)
            window.removeEventListener('resize', place)
        }
    }, [open])
    return pos
}

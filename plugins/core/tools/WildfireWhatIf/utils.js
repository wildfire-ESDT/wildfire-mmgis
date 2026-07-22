// Shared math/geometry helpers for the Wildfire What-If tool

export function getMap() {
    return (window.mmgisAPI && window.mmgisAPI.map) || null
}

export function uvToSpeedDir(u, v) {
    const speed = Math.sqrt(u * u + v * v)
    // Meteorological "FROM" direction
    let dir = (270 - (Math.atan2(v, u) * 180) / Math.PI) % 360
    if (dir < 0) dir += 360
    return { speed_ms: speed, direction_deg: dir }
}

export function meanWind(points) {
    if (!points || points.length === 0) return null
    const meanU = points.reduce((s, p) => s + p.u, 0) / points.length
    const meanV = points.reduce((s, p) => s + p.v, 0) / points.length
    return uvToSpeedDir(meanU, meanV)
}

export function msToMph(ms) {
    return (ms * 2.23694).toFixed(1)
}

const COMPASS_LABELS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
export function dirLabel(deg) {
    return COMPASS_LABELS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]
}

// Speed → color ramp: calm blue → moderate amber → strong red-orange (0–15+ m/s)
export function speedColor(speed) {
    const stops = [
        [79, 195, 247],
        [255, 213, 79],
        [255, 112, 67],
    ]
    const t = Math.max(0, Math.min(speed / 15, 1))
    const seg = t < 0.5 ? 0 : 1
    const f = t < 0.5 ? t * 2 : (t - 0.5) * 2
    const a = stops[seg]
    const b = stops[seg + 1]
    const c = a.map((av, i) => Math.round(av + (b[i] - av) * f))
    return `rgb(${c[0]},${c[1]},${c[2]})`
}

export function closeRing(ring) {
    if (ring.length < 3) return ring
    const [fx, fy] = ring[0]
    const [lx, ly] = ring[ring.length - 1]
    if (fx !== lx || fy !== ly) return ring.concat([[fx, fy]])
    return ring
}

export function generateId() {
    return 'wf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
}

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

// The HRRR cycle `hoursBack` hours before now (floored to the hour), as the
// UTC identity Veloserver keys its gribjson routes by. hoursBack=0 is the
// current hour; the fetch walks back from there to the latest published cycle.
export function utcCycle(hoursBack) {
    const d = new Date()
    d.setUTCMinutes(0, 0, 0)
    d.setUTCHours(d.getUTCHours() - hoursBack)
    return {
        iso: d.toISOString().replace('.000Z', 'Z'),
        date_utc: d.toISOString().slice(0, 10),
        cycle_utc: d.getUTCHours(),
    }
}

// Convert a Veloserver gribjson response (leaflet-velocity format: U and V
// records on a regular lat/lon grid, values as numbers or the string "NaN"
// outside the model domain) into the [{lon, lat, u, v}] points this tool's
// wind field consumes. Grids larger than maxPoints are strided down so the
// map doesn't drown in arrow markers.
export function gribjsonToPoints(records, maxPoints) {
    maxPoints = maxPoints || 250
    if (!Array.isArray(records)) return []
    const uRec = records.find((r) => r && r.header && r.header.parameterNumber === 2)
    const vRec = records.find((r) => r && r.header && r.header.parameterNumber === 3)
    if (!uRec || !vRec) return []
    const h = uRec.header
    const { nx, ny, lo1, la1, la2, dx, dy } = h
    const latStep = la2 >= la1 ? dy : -dy
    const stride = Math.max(1, Math.ceil(Math.sqrt((nx * ny) / maxPoints)))
    const points = []
    for (let j = 0; j < ny; j += stride) {
        for (let i = 0; i < nx; i += stride) {
            const u = Number(uRec.data[j * nx + i])
            const v = Number(vRec.data[j * nx + i])
            if (!isFinite(u) || !isFinite(v)) continue
            let lon = lo1 + i * dx
            if (lon > 180) lon -= 360
            points.push({ lon, lat: la1 + j * latStep, u, v })
        }
    }
    return points
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

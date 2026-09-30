// Shared math/geometry helpers for the Wildfire What-If tool

import { area, polygon, centerOfMass } from '@turf/turf'
import { centerGlobeOn } from './globe'

export function getMap() {
    return (window.mmgisAPI && window.mmgisAPI.map) || null
}

// How much of each edge of the map container is covered by other UI, in px.
// Left/right: the tool panel column, which floats over the map's edge and
// animates its width open, so the width it's opening to (its inline style) is
// used. Top/bottom: whatever overlays the map there (the time bar, forecast
// timeline, …), found by walking in from each edge until the map itself is
// what's under that point.
export function coveredEdges(container) {
    const r = container.getBoundingClientRect()
    const edges = { left: 0, right: 0, top: 0, bottom: 0 }

    const panelEl = document.getElementById('toolPanel')
    if (panelEl) {
        const p = panelEl.getBoundingClientRect()
        const width = parseFloat(panelEl.style.width) || p.width
        const panelRight = p.left + width
        if (width > 0 && panelRight > r.left && p.left < r.right) {
            if ((p.left + panelRight) / 2 < r.left + r.width / 2)
                edges.left = panelRight - r.left
            else edges.right = r.right - p.left
        }
    }

    const isMap = (x, y) => {
        const el = document.elementFromPoint(x, y)
        return !!el && container.contains(el)
    }
    // Deepest covered point walking in from an edge. Overlays needn't sit
    // flush with the map's edge (the time bar leaves a bare pixel row under
    // it), so a short run of bare map doesn't end the walk — only a clear
    // stretch of it does.
    const STEP = 4
    const CLEAR_RUN = 48
    const maxInset = r.height * 0.6
    const coveredDepth = (pointAt) => {
        let depth = 0
        let clear = 0
        for (let d = 0; d < maxInset && clear < CLEAR_RUN; d += STEP) {
            if (isMap(...pointAt(d))) clear += STEP
            else {
                depth = d + STEP
                clear = 0
            }
        }
        return depth
    }
    const x = r.left + edges.left + (r.width - edges.left - edges.right) / 2
    edges.top = coveredDepth((d) => [x, r.top + d + 1])
    edges.bottom = coveredDepth((d) => [x, r.bottom - d - 1])

    edges.left = Math.min(Math.max(0, edges.left), r.width * 0.6)
    edges.right = Math.min(Math.max(0, edges.right), r.width * 0.6)
    return edges
}

// A fire perimeter's centroid (center of mass), as [lat, lon].
export function ringCentroid(ring) {
    try {
        const [lon, lat] = centerOfMass(polygon([closeRing(ring)])).geometry
            .coordinates
        return [lat, lon]
    } catch (e) {
        return null
    }
}

// Zoom so the whole of bounds is in the part of the map the user can actually
// see (clear of the tool panel and the bars over the map's top and bottom),
// and move the globe camera over the same view. With `center` ([lat, lon],
// e.g. the fire's centroid) the view is centered on that point, zoomed out
// just enough to still show all of bounds on every side.
export function fitVisible(bounds, pad = 40, center = null) {
    const leafletMap = getMap()
    if (!leafletMap || !bounds) return
    if (center) {
        const [[s, w], [n, e]] = bounds
        const dLat = Math.max(center[0] - s, n - center[0])
        const dLon = Math.max(center[1] - w, e - center[1])
        bounds = [
            [center[0] - dLat, center[1] - dLon],
            [center[0] + dLat, center[1] + dLon],
        ]
    }
    leafletMap.invalidateSize({ pan: false })
    const e = coveredEdges(leafletMap.getContainer())
    leafletMap.fitBounds(bounds, {
        paddingTopLeft: [e.left + pad, e.top + pad],
        paddingBottomRight: [e.right + pad, e.bottom + pad],
    })
    centerGlobeOn(
        bounds,
        leafletMap.getBoundsZoom(
            bounds,
            false,
            window.L.point(e.left + e.right + 2 * pad, e.top + e.bottom + 2 * pad)
        ),
        { pad, coveredEdgesOf: coveredEdges }
    )
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

// ─── Fire names ───────────────────────────────────────────────────────────────

// Incident-name fields used by WFIGS / NIFC perimeter services, most specific
// first, then generic fallbacks for uploaded GeoJSON.
const FIRE_NAME_KEYS = [
    'poly_IncidentName',
    'attr_IncidentName',
    'IncidentName',
    'INCIDENT',
    'incident_name',
    'FIRE_NAME',
    'fire_name',
    'name',
    'Name',
]

export function pickFireName(properties) {
    if (!properties) return null
    for (const k of FIRE_NAME_KEYS) {
        const v = properties[k]
        if (v != null && String(v).trim() !== '') return String(v).trim()
    }
    return null
}

// ─── Run summaries (Results card + PNG export) ───────────────────────────────

const SQ_M_PER_ACRE = 4046.8564224

export function ringAcres(ring) {
    if (!Array.isArray(ring) || ring.length < 3) return null
    try {
        return area(polygon([closeRing(ring)])) / SQ_M_PER_ACRE
    } catch (e) {
        return null
    }
}

// Starting perimeter vs. the predicted footprint (the spread ring encloses
// the original perimeter plus the downwind growth).
export function runStats(job) {
    const p = (job && job.payload) || {}
    const start = ringAcres(p.perimeter_coords && p.perimeter_coords[0])
    const end = ringAcres(job && job.spreadRing)
    const growth = start != null && end != null ? Math.max(0, end - start) : null
    const growthPct = growth != null && start > 0 ? (growth / start) * 100 : null
    return { start, end, growth, growthPct }
}

export function fmtAcres(acres) {
    if (acres == null) return '—'
    return (
        acres.toLocaleString(undefined, {
            maximumFractionDigits: acres < 10 ? 1 : 0,
        }) + ' ac'
    )
}

export function fmtPct(pct) {
    if (pct == null) return ''
    return `+${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`
}

export function fmtRunTime(ms) {
    const d = new Date(ms)
    if (isNaN(d.getTime())) return ''
    return d.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    })
}

// Fire name and run time, minus whatever the run's name already says (an
// auto-generated name is exactly "<fire> · <time>").
export function runSubtitle(job) {
    const name = (job && job.name) || ''
    const fire = job && job.payload && job.payload.fire_name
    const time = fmtRunTime(job && job.startedAt)
    return [fire && !name.includes(fire) ? fire : null, time && !name.includes(time) ? time : null]
        .filter(Boolean)
        .join(' · ')
}

export function fmtWind(wm) {
    if (!wm || wm.speed_ms == null || wm.direction_deg == null) return null
    return `${Number(wm.speed_ms).toFixed(1)} m/s (${msToMph(
        wm.speed_ms
    )} mph) from ${dirLabel(wm.direction_deg)}`
}

export function fmtHrrr(hr) {
    if (!hr || hr.date == null) return null
    return `HRRR ${hr.date} ${String(hr.cycle).padStart(2, '0')}Z`
}

export function simTypeLabel(simType) {
    return simType === 'smoke_dispersion' ? 'Smoke dispersion' : 'Fire spread'
}

// All user-triggered behavior for the Wildfire What-If tool. Components call
// these; they orchestrate the store (state), map (Leaflet), and the backend.

import useWhatIfStore, { BBOX_BUFFER_KM } from './store'
import * as map from './map'
import { getMap, meanWind, closeRing, generateId } from './utils'

const S = useWhatIfStore

const ENDPOINT_TAG = 'wildfire-whatif:/api/payload'

let drawSession = null

// ─── Backend / MMGIS-server requests ──────────────────────────────────────────

function mmgisFetch(path, init) {
    const root = (window.mmgisglobal && window.mmgisglobal.ROOT_PATH) || ''
    const url = (root ? root + '/' : '') + path.replace(/^\//, '')
    return fetch(url, {
        credentials: 'same-origin',
        headers: {
            Accept: 'application/json',
            ...((init && init.headers) || {}),
        },
        ...(init || {}),
    })
}

// Run history, persisted via MMGIS's workflows-history table (same pattern as
// WorkflowsTool). Only rows tagged as wildfire submissions are loaded.
function fetchJobHistory() {
    return mmgisFetch('api/workflows-history')
        .then((r) => r.json())
        .then((d) => {
            if (!d || d.status !== 'success' || !Array.isArray(d.body)) return {}
            const out = {}
            d.body.forEach((row) => {
                if (!row || !row.workflow_id) return
                const isWildfire =
                    (row.endpoint && row.endpoint.includes('wildfire')) ||
                    (row.payload && row.payload.sim_type != null)
                if (!isWildfire) return
                out[row.workflow_id] = {
                    payload: row.payload || null,
                    name: row.name || '',
                    ts: row.created_on
                        ? new Date(row.created_on).getTime()
                        : Date.now(),
                }
            })
            return out
        })
        .catch(() => ({}))
}

function recordJob(jobId, payload, name) {
    return mmgisFetch('api/workflows-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            workflow_id: jobId,
            endpoint: ENDPOINT_TAG,
            payload,
            name: name || '',
        }),
    }).catch(() => {})
}

// Fetch a single forecast hour from /api/wind (fxx=0…12).
function fetchWindHour(backendUrl, { date, hourPdt, fxx, bbox }) {
    const url = new URL(backendUrl + '/api/wind')
    url.searchParams.set('date', date)
    url.searchParams.set('hour_pdt', hourPdt)
    url.searchParams.set('fxx', fxx)
    url.searchParams.set('lon_min', bbox[0])
    url.searchParams.set('lat_min', bbox[1])
    url.searchParams.set('lon_max', bbox[2])
    url.searchParams.set('lat_max', bbox[3])
    return fetch(url.toString()).then((r) => r.json())
}

// ─── Perimeter + auto bbox ────────────────────────────────────────────────────

// Perimeter bounding extent buffered by BBOX_BUFFER_KM on every side — the
// HRRR region always clears the perimeter by the full buffer and stays
// centered on it.
function bufferedBounds(ring) {
    let lonMin = Infinity
    let latMin = Infinity
    let lonMax = -Infinity
    let latMax = -Infinity
    ring.forEach(([lon, lat]) => {
        if (lon < lonMin) lonMin = lon
        if (lon > lonMax) lonMax = lon
        if (lat < latMin) latMin = lat
        if (lat > latMax) latMax = lat
    })
    const bufM = BBOX_BUFFER_KM * 1000
    const dLat = bufM / 111320
    const midLat = (latMin + latMax) / 2
    const dLon = bufM / (111320 * Math.cos((midLat * Math.PI) / 180))
    return [
        [latMin - dLat, lonMin - dLon],
        [latMax + dLat, lonMax + dLon],
    ]
}

export function bboxLonLat() {
    const b = S.getState().bboxBounds
    if (!b) return null
    return [b[0][1], b[0][0], b[1][1], b[1][0]]
}

// Central entry point: set the perimeter ring, draw it with edit handles, and
// auto-derive the HRRR bbox — the perimeter's extent plus a 15 km buffer.
export function setPerimeter(ring, opts) {
    if (!getMap() || !ring || ring.length < 4) return
    const closed = closeRing(ring.map((p) => [Number(p[0]), Number(p[1])]))
    map.showPerimeter(closed, {
        onChange: (opts && opts.noEdit) ? null : (newRing) => setPerimeter(newRing),
    })
    const bounds = bufferedBounds(closed)
    map.showBbox(bounds)
    S.setState({
        perimeterRing: closed,
        bboxBounds: bounds,
        windStale: S.getState().wind != null && !(opts && opts.fromRun),
    })
    if (S.getState().wind) renderWindVectors()
}

// Redraw a scenario already held in the store (e.g. after tool close/reopen)
export function restoreScenario() {
    const ring = S.getState().perimeterRing
    if (ring) setPerimeter(ring, { fromRun: true })
}

export function clearPerimeter() {
    cancelMapDraw()
    cancelWindFetch()
    map.clearScenarioLayers()
    S.setState({
        perimeterRing: null,
        bboxBounds: null,
        wind: null,
        hrrrRun: null,
        hrrrError: null,
        windStale: false,
        fetchingWinds: false,
    })
}

export function uploadPerimeter(file) {
    const reader = new FileReader()
    reader.onload = function (e) {
        try {
            const gj = JSON.parse(e.target.result)
            let geom
            if (gj.type === 'FeatureCollection' && gj.features && gj.features.length)
                geom = gj.features[0].geometry
            else if (gj.type === 'Feature') geom = gj.geometry
            else if (gj.type === 'Polygon' || gj.type === 'MultiPolygon') geom = gj
            else throw new Error('Unsupported GeoJSON type: ' + gj.type)
            let ring
            if (geom.type === 'Polygon') ring = geom.coordinates[0]
            else if (geom.type === 'MultiPolygon') ring = geom.coordinates[0][0]
            else throw new Error('Geometry must be a Polygon or MultiPolygon')
            setPerimeter(ring)
        } catch (err) {
            window.alert('Invalid GeoJSON: ' + err.message)
        }
    }
    reader.readAsText(file)
}

// ─── Drawing ──────────────────────────────────────────────────────────────────

export function startMapDraw() {
    const leafletMap = getMap()
    if (!leafletMap) {
        window.alert('Map not ready yet.')
        return
    }
    cancelMapDraw()
    S.setState({ drawing: true })
    drawSession = map.startDrawSession(leafletMap, {
        onDone: (ring) => {
            drawSession = null
            S.setState({ drawing: false })
            if (ring) setPerimeter(ring)
        },
    })
}

export function cancelMapDraw() {
    if (drawSession) drawSession.cancel()
}

// ─── HRRR fxx=0 wind fetch ────────────────────────────────────────────────────

let windFetchGen = 0

export function cancelWindFetch() {
    windFetchGen++
}

export function fetchWinds() {
    const s = S.getState()
    const bbox = bboxLonLat()
    if (!bbox) {
        window.alert('Draw a fire perimeter first — the HRRR region is derived from it.')
        return
    }
    const gen = ++windFetchGen
    S.setState({ wind: null, hrrrRun: null, fetchingWinds: true, hrrrError: null, windStale: false })

    fetchWindHour(s.backendUrl, { date: s.hrrrDate, hourPdt: s.hrrrHour, fxx: 0, bbox })
        .then((data) => {
            if (gen !== windFetchGen) return
            const mean = data && !data.error ? meanWind(data.points) : null
            if (!mean) {
                S.setState({
                    fetchingWinds: false,
                    hrrrError: (data && data.error) || 'No wind data returned',
                })
                return
            }
            const base = {
                speed_ms: Math.round(mean.speed_ms * 10) / 10,
                direction_deg: Math.round(mean.direction_deg),
            }
            const patch = {
                fetchingWinds: false,
                wind: { base, target: { ...base }, hrrr_ref: data.hrrr_ref, points: data.points },
            }
            if (data.cycle_utc != null) {
                patch.hrrrRun = {
                    date_utc: data.date_utc,
                    cycle_utc: data.cycle_utc,
                    hour_pdt: Number(data.hour_pdt),
                    source: data.source,
                }
            }
            S.setState(patch)
            renderWindVectors()
        })
        .catch((err) => {
            if (gen !== windFetchGen) return
            S.setState({ fetchingWinds: false, hrrrError: err.message })
        })
}

export function setWind(field, value) {
    const s = S.getState()
    if (!s.wind) return
    const target = { ...s.wind.target }
    if (field === 'speed_ms') {
        target.speed_ms = Math.round(Math.max(0, Math.min(40, value)) * 10) / 10
    } else {
        target.direction_deg = ((Math.round(value) % 360) + 360) % 360
    }
    S.setState({ wind: { ...s.wind, target } })
    renderWindVectors()
}

export function resetWind() {
    const s = S.getState()
    if (!s.wind || !s.wind.base) return
    S.setState({ wind: { ...s.wind, target: { ...s.wind.base } } })
    renderWindVectors()
}

export function renderWindVectors() {
    const s = S.getState()
    const w = s.wind
    if (!w || !w.points || w.points.length === 0) {
        map.removeWindVectors()
        return
    }
    map.showWindVectors(w.points, w.base, w.target)
}

// ─── Mock spread polygon ──────────────────────────────────────────────────────

// Builds a crescent-shaped spread polygon that never overlaps the original
// perimeter. Only vertices on the downwind side are displaced; upwind vertices
// stay at their original position. The resulting polygon shares an edge with
// the original perimeter on the upwind side and extends outward downwind.
export function drawMockSpread() {
    const s = S.getState()
    const ring = s.perimeterRing
    const wind = s.wind && s.wind.target
    if (!ring || !wind) { map.removeMockSpread(); return }

    // Fire spreads in the direction opposite to wind origin
    const spreadDeg = (wind.direction_deg + 180) % 360
    const spreadRad = (spreadDeg * Math.PI) / 180
    const spreadVecX = Math.sin(spreadRad) // lon component
    const spreadVecY = Math.cos(spreadRad) // lat component

    // Scale: 1 m/s ≈ 0.5 km, max 10 km
    const spreadKm = Math.min(wind.speed_ms * 0.5, 10)

    // Pre-compute centroid and per-degree offsets
    const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length
    const cy = ring.reduce((a, p) => a + p[1], 0) / ring.length
    const dLat = spreadKm / 111.32
    const dLon = spreadKm / (111.32 * Math.cos((cy * Math.PI) / 180))

    // For each vertex compute its dot product with the spread vector.
    // Positive = downwind side (gets displaced), negative = upwind (stays put).
    // Cosine weight tapers displacement smoothly at the flanks.
    const maxDot = Math.max(...ring.map(([lx, ly]) =>
        (lx - cx) * spreadVecX + (ly - cy) * spreadVecY
    ))
    const spreadRing = ring.map(([lon, lat]) => {
        const dot = (lon - cx) * spreadVecX + (lat - cy) * spreadVecY
        const weight = maxDot > 0 ? Math.max(0, dot / maxDot) : 0
        return [
            lon + dLon * spreadVecX * weight,
            lat + dLat * spreadVecY * weight,
        ]
    })

    map.showMockSpread(spreadRing)
    return spreadRing
}

// ─── Submission ───────────────────────────────────────────────────────────────

export function submit() {
    const s = S.getState()
    if (!s.perimeterRing) {
        window.alert('Draw or upload a fire perimeter first.')
        return
    }
    const name = (s.runName || '').trim()
    if (!name) {
        S.setState({ nameError: true })
        return
    }
    if (!s.wind) {
        window.alert('Fetch HRRR winds first — the forecast needs a wind field.')
        return
    }
    const spreadRing = drawMockSpread()
    map.removeWindVectors()
    const wind = s.wind.target
    if (!wind) {
        window.alert('No usable wind data — refetch HRRR winds.')
        return
    }
    const payload = {
        hrrr_ref: s.wind.hrrr_ref || `hrrr.t${String(s.hrrrHour).padStart(2, '0')}z.wrfsfcf00.grib2`,
        hrrr_run: s.hrrrRun
            ? { date: s.hrrrRun.date_utc, cycle: s.hrrrRun.cycle_utc, fxx: 0 }
            : null,
        wind_mods: {
            speed_ms: wind.speed_ms,
            direction_deg: wind.direction_deg,
        },
        perimeter_coords: [s.perimeterRing],
        perimeter_props: {
            runid: generateId(),
            t: new Date().toISOString(),
            synthetic: true,
        },
        sim_type: s.simType,
    }
    S.setState({ submitting: true })
    fetch(s.backendUrl + '/api/payload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    })
        .then((r) => r.json())
        .then((body) => {
            const jobId = generateId()
            const st = S.getState()
            S.setState({
                jobs: {
                    ...st.jobs,
                    [jobId]: {
                        payload,
                        name,
                        status: 'completed',
                        startedAt: Date.now(),
                        result: body,
                        spreadRing,
                    },
                },
                jobIds: [jobId, ...st.jobIds],
                page: 0,
                activeJobId: jobId,
                runName: '',
                submitting: false,
            })
            recordJob(jobId, payload, name)
        })
        .catch((err) => {
            S.setState({ submitting: false })
            window.alert('Submission failed: ' + err.message)
        })
}

// ─── Downloads ────────────────────────────────────────────────────────────────

function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
}

export function downloadSpreadGeoJSON(job) {
    const p = job && job.payload
    const spreadRing = job && job.spreadRing
    const features = []
    if (p && p.perimeter_coords && p.perimeter_coords[0]) {
        features.push({
            type: 'Feature',
            properties: { type: 'current_perimeter', name: job.name || '' },
            geometry: { type: 'Polygon', coordinates: p.perimeter_coords },
        })
    }
    if (spreadRing) {
        features.push({
            type: 'Feature',
            properties: {
                type: 'predicted_spread',
                name: job.name || '',
                speed_ms: p && p.wind_mods ? p.wind_mods.speed_ms : null,
                direction_deg: p && p.wind_mods ? p.wind_mods.direction_deg : null,
            },
            geometry: { type: 'Polygon', coordinates: [spreadRing] },
        })
    }
    const geojson = { type: 'FeatureCollection', features }
    const blob = new Blob([JSON.stringify(geojson, null, 2)], {
        type: 'application/geo+json',
    })
    const safeName = (job.name || 'prediction').replace(/[^a-z0-9_-]/gi, '_')
    triggerDownload(blob, `${safeName}_prediction.geojson`)
}

export function downloadSpreadPNG(job) {
    const leafletMap = getMap()
    if (!leafletMap) return
    import('html2canvas').then(({ default: html2canvas }) => {
        const container = leafletMap.getContainer()
        html2canvas(container, { useCORS: true, allowTaint: true, scale: 2 }).then((canvas) => {
            canvas.toBlob((blob) => {
                const safeName = (job.name || 'prediction').replace(/[^a-z0-9_-]/gi, '_')
                triggerDownload(blob, `${safeName}_prediction.png`)
            }, 'image/png')
        })
    })
}

// ─── WFIGS / map-layer fire click ────────────────────────────────────────────

// Called when the user clicks a fire polygon on the WFIGS map layer while the
// tool is open. Uses the full perimeter extent + BBOX_BUFFER_KM padding on
// every side — identical to the drawn-perimeter bbox behaviour.
export function setBboxFromMapFeature(feature) {
    if (!feature || !feature.geometry) return
    const geom = feature.geometry
    let ring
    if (geom.type === 'Polygon') ring = geom.coordinates[0]
    else if (geom.type === 'MultiPolygon') {
        ring = geom.coordinates
            .map((poly) => poly[0])
            .reduce((best, r) => (r.length > best.length ? r : best), [])
    }
    if (!ring || ring.length < 3) return

    // Treat exactly like a drawn/uploaded perimeter — sets perimeterRing,
    // draws the polygon on the map, derives the bbox, and enables forecast.
    setPerimeter(ring, { noEdit: true })

    const leafletMap = getMap()
    if (leafletMap) leafletMap.fitBounds(bufferedBounds(ring), { padding: [40, 40] })
}

// ─── Run history / swapping ───────────────────────────────────────────────────

export function loadHistory() {
    fetchJobHistory().then((reg) => {
        const jobs = { ...S.getState().jobs }
        Object.keys(reg).forEach((id) => {
            // Rows are only recorded after a successful submission
            if (!jobs[id])
                jobs[id] = {
                    ...reg[id],
                    status: 'completed',
                    startedAt: reg[id].ts || Date.now(),
                }
        })
        const jobIds = Object.keys(jobs).sort(
            (a, b) => (jobs[b].startedAt || 0) - (jobs[a].startedAt || 0)
        )
        S.setState({ jobs, jobIds })
    })
}

// Rename a run locally and upsert the name into the DB-backed history
// (same route WorkflowsTool uses — POST upserts, so this also works for rows
// this browser never submitted).
export function renameRun(id, name) {
    const s = S.getState()
    const job = s.jobs[id]
    if (!job) return
    S.setState({ jobs: { ...s.jobs, [id]: { ...job, name } } })
    mmgisFetch('api/workflows-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow_id: id, name: name || '' }),
    }).catch(() => {})
}

export function selectRun(id) {
    const s = S.getState()
    if (s.activeJobId === id) {
        S.setState({ activeJobId: null, showActiveJson: false })
        map.removeMockSpread()
        return
    }
    const job = s.jobs[id]
    const p = job && job.payload
    S.setState({ activeJobId: id, showActiveJson: false })
    if (!p) return
    // Restore the run's scenario onto the map and controls
    cancelWindFetch()
    map.removeWindVectors()
    map.removeMockSpread()
    S.setState({
        wind: null,
        hrrrRun: null,
        windStale: false,
        fetchingWinds: false,
    })
    if (p.perimeter_coords && p.perimeter_coords[0]) {
        setPerimeter(p.perimeter_coords[0], { fromRun: true })
    }
    if (job.spreadRing) {
        map.showMockSpread(job.spreadRing)
    }
    if (p.sim_type) S.setState({ simType: p.sim_type })
}

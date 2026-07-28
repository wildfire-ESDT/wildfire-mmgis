// All user-triggered behavior for the Wildfire What-If tool. Components call
// these; they orchestrate the store (state), map (Leaflet), Veloserver (HRRR
// winds), and the MMGIS server (run history).

import { area, length, polygon, lineString } from '@turf/turf'
import useWhatIfStore, { BBOX_BUFFER_KM } from './store'
import * as map from './map'
import {
    getMap,
    meanWind,
    closeRing,
    generateId,
    utcCycle,
    gribjsonToPoints,
} from './utils'

const S = useWhatIfStore

const ENDPOINT_TAG = 'wildfire-whatif:/api/payload'

// How many hours back from now to search for the latest published HRRR cycle
const LATEST_MAX_HOURS_BACK = 4
// Debounce for the automatic wind fetch while a perimeter is being edited
const AUTO_FETCH_DEBOUNCE_MS = 400

let drawSession = null
let autoFetchTimer = null

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

// Run history, persisted per-user in MMGIS Postgres via the WhatIfRuns
// backend plugin (/api/whatif-runs), keyed by the Keycloak username.
function fetchJobHistory() {
    const userId = S.getState().authUserId
    return mmgisFetch(
        'api/whatif-runs' +
            (userId ? '?user_id=' + encodeURIComponent(userId) : '')
    )
        .then((r) => r.json())
        .then((d) => {
            if (!d || d.status !== 'success' || !Array.isArray(d.body)) return {}
            const out = {}
            d.body.forEach((row) => {
                if (!row || !row.scenario_id) return
                const isWildfire =
                    (row.endpoint && row.endpoint.includes('wildfire')) ||
                    (row.payload && row.payload.sim_type != null)
                if (!isWildfire) return
                // The result column stores the computed result with the
                // predicted spreadRing folded in; split them back into the
                // same shape a freshly submitted job has in memory.
                const stored = row.result || null
                const spreadRing =
                    stored && stored.spreadRing ? stored.spreadRing : null
                let result = stored
                if (stored && spreadRing) {
                    result = { ...stored }
                    delete result.spreadRing
                }
                out[row.scenario_id] = {
                    payload: row.payload || null,
                    result,
                    spreadRing,
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

function recordJob(jobId, payload, name, result) {
    return mmgisFetch('api/whatif-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            scenario_id: jobId,
            endpoint: ENDPOINT_TAG,
            payload,
            result: result || null,
            name: name || '',
            user_id: S.getState().authUserId || null,
            username: S.getState().authUser || null,
        }),
    }).catch(() => {})
}

// Fetch one HRRR cycle from Veloserver's gribjson route, which subsets
// server-side: /hrrr/gribjson/{cycle-time}/{ulx,uly,lrx,lry}. veloUrl may be
// absolute or a path relative to the MMGIS origin (the default 'veloserver'
// rides MMGIS's adjacent-server proxy and its session).
function fetchWindHour(veloUrl, { run, fxx, bbox }) {
    const projwin = `${bbox[0]},${bbox[3]},${bbox[2]},${bbox[1]}`
    const root = (window.mmgisglobal && window.mmgisglobal.ROOT_PATH) || ''
    const base = /^https?:\/\//.test(veloUrl)
        ? veloUrl.replace(/\/$/, '')
        : (root ? root + '/' : '') + veloUrl.replace(/^\/|\/$/g, '')
    const cc = String(run.cycle_utc).padStart(2, '0')
    const ff = String(fxx).padStart(2, '0')
    return fetch(`${base}/hrrr/gribjson/${run.iso}/${projwin}?fxx=${fxx}`, {
        credentials: 'same-origin',
    })
        .then((r) => {
            if (!r.ok)
                return r.text().then((t) => {
                    throw new Error(t || `Veloserver HTTP ${r.status}`)
                })
            return r.json()
        })
        .then((records) => ({
            points: gribjsonToPoints(records),
            hrrr_ref: `hrrr.t${cc}z.wrfsfcf${ff}.grib2`,
            date_utc: run.date_utc,
            cycle_utc: run.cycle_utc,
            valid_iso: run.iso,
            source: `HRRR ${run.date_utc} ${cc}Z f${ff}`,
        }))
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
        // Edit-handle drags re-enter without opts — keep the original source
        perimeterSource:
            (opts && opts.source) || S.getState().perimeterSource || 'drawn',
        windStale: S.getState().wind != null && !(opts && opts.fromRun),
    })
    if (S.getState().wind) renderWindVectors()
    // Selecting/editing a perimeter fetches the latest wind for it — debounced
    // so a stream of edit-handle drags collapses into one request. Restored
    // runs keep their saved wind instead.
    if (!(opts && opts.fromRun)) {
        if (autoFetchTimer) clearTimeout(autoFetchTimer)
        autoFetchTimer = setTimeout(() => {
            autoFetchTimer = null
            fetchWinds()
        }, AUTO_FETCH_DEBOUNCE_MS)
    }
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
        perimeterSource: null,
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
            setPerimeter(ring, { source: 'uploaded' })
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
            if (ring) setPerimeter(ring, { source: 'drawn' })
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
    if (autoFetchTimer) {
        clearTimeout(autoFetchTimer)
        autoFetchTimer = null
    }
}

export function fetchWinds() {
    const s = S.getState()
    const bbox = bboxLonLat()
    if (!bbox) {
        window.alert('Draw a fire perimeter first. The wind region is derived from it.')
        return
    }
    const gen = ++windFetchGen
    S.setState({ wind: null, hrrrRun: null, fetchingWinds: true, hrrrError: null, windStale: false })

    // Latest available wind: HRRR analyses publish ~1 h behind wall clock, so
    // walk back hour-by-hour from the current UTC hour until Veloserver has
    // data (LATEST_MAX_HOURS_BACK bounds a fully-down upstream).
    const tryCycle = (hoursBack) =>
        fetchWindHour(s.veloUrl, { run: utcCycle(hoursBack), fxx: 0, bbox }).catch(
            (err) => {
                if (gen !== windFetchGen || hoursBack >= LATEST_MAX_HOURS_BACK)
                    throw err
                return tryCycle(hoursBack + 1)
            }
        )

    tryCycle(0)
        .then((data) => {
            if (gen !== windFetchGen) return
            const mean = data ? meanWind(data.points) : null
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
                    valid_iso: data.valid_iso,
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

    map.showMockSpread(spreadRing, ring)
    return spreadRing
}

// ─── Submission ───────────────────────────────────────────────────────────────

// Assemble the run result entirely client-side (formerly the whatif-demo
// backend's POST /api/payload): geodesic-ish perimeter stats via turf,
// meteorological speed/direction resolved to earth-relative U/V.
function buildPayloadResult(payload) {
    const ring = payload.perimeter_coords[0]
    const props = {
        meanfrp: 0,
        isactive: 1,
        region: 'CONUS',
        seeded_from: null,
        ...payload.perimeter_props,
        farea: Math.round((area(polygon([ring])) / 1e6) * 100) / 100, // km²
        fperim:
            Math.round(length(lineString(ring), { units: 'kilometers' }) * 100) /
            100,
    }
    const wm = payload.wind_mods
    let wind_uv = null
    if (wm.speed_ms != null && wm.direction_deg != null) {
        // direction_deg is where the wind comes FROM; u east, v north
        const mathRad = ((270 - wm.direction_deg) * Math.PI) / 180
        wind_uv = {
            u10: Math.round(wm.speed_ms * Math.cos(mathRad) * 1e4) / 1e4,
            v10: Math.round(wm.speed_ms * Math.sin(mathRad) * 1e4) / 1e4,
            speed_ms: Math.round(wm.speed_ms * 1e4) / 1e4,
            direction_deg: Math.round(wm.direction_deg * 100) / 100,
        }
    }
    return {
        hrrr_ref: payload.hrrr_ref,
        hrrr_run: payload.hrrr_run,
        wind_mods: wm,
        wind_uv,
        perimeter: {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: payload.perimeter_coords },
            properties: props,
        },
        resources: { type: 'FeatureCollection', features: [] },
        generated_at: new Date().toISOString(),
    }
}

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
        window.alert('Fetch winds first. The forecast needs a wind field.')
        return
    }
    const spreadRing = drawMockSpread()
    map.removeWindVectors()
    const wind = s.wind.target
    if (!wind) {
        window.alert('No usable wind data. Refetch the latest winds.')
        return
    }
    const payload = {
        hrrr_ref: s.wind.hrrr_ref,
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
    let result
    try {
        result = buildPayloadResult(payload)
    } catch (err) {
        S.setState({ submitting: false })
        window.alert('Submission failed: ' + err.message)
        return
    }
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
                result,
                spreadRing,
            },
        },
        jobIds: [jobId, ...st.jobIds],
        page: 0,
        activeJobId: jobId,
        runName: '',
        submitting: false,
    })
    // Persist the frozen prediction (computed result plus the predicted spread
    // polygon) so it reloads exactly as generated, not recomputed on load.
    recordJob(jobId, payload, name, { ...result, spreadRing })
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
    setPerimeter(ring, { noEdit: true, source: 'selected' })

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
    mmgisFetch('api/whatif-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario_id: id, name: name || '' }),
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
    // Replay the saved wind (speed/direction) so the loaded run is immediately
    // re-runnable — Generate works without re-fetching, and it keeps working
    // even after that HRRR cycle ages out of the archive. hrrrRun is restored
    // too so a re-run records the same date/cycle/fxx. Gridded points aren't
    // persisted, so the raw wind vectors stay hidden (the frozen spread shows
    // instead); a manual re-fetch brings the live wind field back.
    const wm = p.wind_mods
    const restoredWind = wm
        ? {
              base: { speed_ms: wm.speed_ms, direction_deg: wm.direction_deg },
              target: { speed_ms: wm.speed_ms, direction_deg: wm.direction_deg },
              hrrr_ref: p.hrrr_ref || null,
              points: [],
          }
        : null
    const restoredHrrrRun = p.hrrr_run
        ? {
              date_utc: p.hrrr_run.date,
              cycle_utc: p.hrrr_run.cycle,
              source: 'restored',
          }
        : null
    S.setState({
        wind: restoredWind,
        hrrrRun: restoredHrrrRun,
        windStale: false,
        fetchingWinds: false,
    })
    if (p.perimeter_coords && p.perimeter_coords[0]) {
        setPerimeter(p.perimeter_coords[0], { fromRun: true, source: 'run' })
        // Snap the map to the restored perimeter, same as clicking a fire does.
        const leafletMap = getMap()
        if (leafletMap)
            leafletMap.fitBounds(bufferedBounds(p.perimeter_coords[0]), {
                padding: [40, 40],
            })
    }
    if (job.spreadRing) {
        const perimRing = p.perimeter_coords && p.perimeter_coords[0]
        map.showMockSpread(job.spreadRing, perimRing || null)
    }
    if (p.sim_type) S.setState({ simType: p.sim_type })
}

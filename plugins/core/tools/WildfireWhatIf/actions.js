// All user-triggered behavior for the Wildfire What-If tool. Components call
// these; they orchestrate the store (state), map (Leaflet), Veloserver (HRRR
// winds), and the MMGIS server (run history).

import { area, length, polygon, lineString, lineIntersect } from '@turf/turf'
import useWhatIfStore, { BBOX_BUFFER_KM } from './store'
import * as map from './map'
import {
    getMap,
    fitVisible,
    coveredEdges,
    ringCentroid,
    meanWind,
    closeRing,
    generateId,
    utcCycle,
    gribjsonToPoints,
    pickFireName,
    runStats,
    fmtAcres,
    fmtPct,
    fmtRunTime,
    fmtWind,
    fmtHrrr,
    simTypeLabel,
    runSubtitle,
} from './utils'

const S = useWhatIfStore

const ENDPOINT_TAG = 'wildfire-whatif:/api/payload'

// How many hours back from now to search for the latest published HRRR cycle
const LATEST_MAX_HOURS_BACK = 4
// Debounce for the automatic wind fetch while a perimeter is being edited
const AUTO_FETCH_DEBOUNCE_MS = 400

let drawSession = null
let dozerDrawSession = null
let autoFetchTimer = null
// False while the tool is closed. Late async work (a wind fetch landing, an
// auth refresh failing) may still update the store, but must not draw on the
// map; reopening redraws from the store.
let toolOpen = false
// A fire picked on the map while signed out, applied once the user signs in.
let pendingMapFire = null
// The last map-picked fire the tool dealt with (applied, or ignored as a click
// that belonged to a drawing). On open, a selected fire that isn't this one
// was picked while the tool couldn't hear it.
let lastMapFire = null

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
function fetchJobHistory(userId) {
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
        .then((records) => {
            // An hour that isn't published yet comes back as an empty 200,
            // not an error — treat it as missing so the caller falls back
            // to the previous hour.
            const points = gribjsonToPoints(records)
            if (!points.length)
                throw new Error('No recent HRRR winds for this area')
            return {
                points,
                rawRecords: records,
                hrrr_ref: `hrrr.t${cc}z.wrfsfcf${ff}.grib2`,
                date_utc: run.date_utc,
                cycle_utc: run.cycle_utc,
                valid_iso: run.iso,
                source: `HRRR ${run.date_utc} ${cc}Z f${ff}`,
            }
        })
}

// ─── Perimeter + auto bbox ────────────────────────────────────────────────────

// Perimeter bounding extent buffered by BBOX_BUFFER_KM on every side — the
// HRRR region always clears the perimeter by the full buffer and stays
// centered on it.
function bufferedBounds(ring, bufferKm = BBOX_BUFFER_KM) {
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
    const bufM = bufferKm * 1000
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

// Map-selected fire perimeters are fixed; drawn, uploaded and re-run ones get
// edit handles.
function showDraftPerimeter(closedRing, source) {
    map.showPerimeter(closedRing, {
        onChange: source === 'selected' ? null : (newRing) => setPerimeter(newRing),
    })
}

// Central entry point: set the perimeter ring, draw it with edit handles, and
// auto-derive the HRRR bbox — the perimeter's extent plus a 15 km buffer.
// A new perimeter always belongs to the draft, so any run being viewed closes.
export function setPerimeter(ring, opts) {
    if (!getMap() || !ring || ring.length < 4) return
    exitRunView()
    cancelWindFetch()
    const closed = closeRing(ring.map((p) => [Number(p[0]), Number(p[1])]))
    // Edit-handle drags re-enter without opts — keep the original source
    const isEdit = !(opts && opts.source)
    const source = isEdit ? S.getState().perimeterSource || 'drawn' : opts.source
    showDraftPerimeter(closed, source)
    const bounds = bufferedBounds(closed)
    map.showBbox(bounds)
    if (isEdit) {
        // Reshaping the same fire: keep its wind on screen until the refetch
        // for the new region lands — debounced so a stream of handle drags
        // collapses into one request.
        S.setState({
            perimeterRing: closed,
            bboxBounds: bounds,
            perimeterSource: source,
            windStale: S.getState().wind != null,
        })
        renderWindVectors()
        autoFetchTimer = setTimeout(() => {
            autoFetchTimer = null
            fetchWinds()
        }, AUTO_FETCH_DEBOUNCE_MS)
        return
    }
    // A different fire: the previous wind and dozer lines don't apply to it,
    // so drop them and fetch the new region's wind straight away.
    map.removeDozerLines()
    S.setState({
        perimeterRing: closed,
        bboxBounds: bounds,
        perimeterSource: source,
        perimeterName: (opts && opts.name) || null,
        wind: null,
        hrrrRun: null,
        hrrrError: null,
        windStale: false,
        dozerLines: [],
    })
    fetchWinds()
}

// Tool lifecycle: open redraws whatever was showing before it closed; close
// stops everything that could still draw on the map.
export function onToolOpen() {
    toolOpen = true
    restoreScenario()
}

export function onToolClose() {
    toolOpen = false
    pendingMapFire = null
    cancelDrawSessions()
    cancelWindFetch()
    map.clearScenarioLayers()
}

// Redraw the run being viewed, or else the draft. Nothing is drawn while
// signed out — the login gate covers the panel, so the map stays clean too.
export function restoreScenario() {
    const s = S.getState()
    if (!s.loggedIn) return
    if (pendingMapFire) {
        const feature = pendingMapFire
        pendingMapFire = null
        lastMapFire = feature
        setBboxFromMapFeature(feature)
        return
    }
    const job = s.activeJobId && s.jobs[s.activeJobId]
    if (job) {
        drawRunLayers(job)
    } else {
        if (s.activeJobId) S.setState({ activeJobId: null, showActiveJson: false })
        drawDraftLayers()
    }
    // A wind fetch cut off by closing the tool starts again
    if (s.perimeterRing && !s.wind && !s.fetchingWinds) fetchWinds()
}

// Take the scenario off the map without touching the store (sign-out).
export function hideScenario() {
    cancelDrawSessions()
    map.clearScenarioLayers()
}

// ─── Setup vs. results view ───────────────────────────────────────────────────
// The draft (perimeterRing, wind, dozerLines, …) is the scenario the Setup
// view edits. Viewing a run (activeJobId set) swaps the map to that run's
// frozen layers without touching the draft, so closing the run puts the
// draft back exactly as it was.

function drawDraftLayers() {
    if (!toolOpen) return
    const s = S.getState()
    map.clearScenarioLayers()
    if (s.perimeterRing) {
        showDraftPerimeter(s.perimeterRing, s.perimeterSource)
        if (s.bboxBounds) map.showBbox(s.bboxBounds)
    }
    if (s.dozerLines.length) map.showDozerLines(s.dozerLines)
    renderWindVectors()
}

function drawRunLayers(job, { fit } = {}) {
    if (!toolOpen) return
    const p = job.payload || {}
    const perim = p.perimeter_coords && p.perimeter_coords[0]
    map.clearScenarioLayers()
    if (perim) map.showPerimeter(perim)
    if (job.spreadRing) map.showMockSpread(job.spreadRing, perim || null)
    if (Array.isArray(p.dozer_lines) && p.dozer_lines.length)
        map.showDozerLines(p.dozer_lines.map((coords, i) => ({ id: i, coords })))
    const pts = [...(perim || []), ...(job.spreadRing || [])]
    if (fit && pts.length)
        fitVisible(bufferedBounds(pts, 2), 40, perim ? ringCentroid(perim) : null)
}

function cancelDrawSessions() {
    cancelMapDraw()
    cancelDozerLineDraw()
}

// Leave the results view and put the draft back on the map.
export function exitRunView() {
    if (!S.getState().activeJobId) return
    S.setState({ activeJobId: null, showActiveJson: false })
    drawDraftLayers()
}

// The user closing a result: back to the draft or, when there's no draft to
// return to, into Setup with this run's inputs — closing never leaves the
// map empty.
export function closeRunView() {
    const s = S.getState()
    const id = s.activeJobId
    if (!id) return
    if (!s.perimeterRing && s.jobs[id]) editRun(id)
    else exitRunView()
}

// Leave the results view with an empty draft.
export function newScenario() {
    S.setState({ activeJobId: null, showActiveJson: false, runName: '' })
    clearPerimeter()
}

// Copy a run's inputs into the draft and switch to Setup to tweak and re-run
// it. The saved wind (speed/direction) is replayed so Generate works without
// re-fetching, even after that HRRR cycle ages out of the archive; hrrrRun is
// restored so a re-run records the same date/cycle/fxx. Gridded wind points
// aren't persisted, so arrows stay hidden until a manual re-fetch.
export function editRun(id) {
    const s = S.getState()
    const job = s.jobs[id]
    const p = job && job.payload
    if (!p) return
    cancelDrawSessions()
    cancelWindFetch()
    const wm = p.wind_mods
    S.setState({
        activeJobId: null,
        showActiveJson: false,
        wind: wm
            ? {
                  base: { speed_ms: wm.speed_ms, direction_deg: wm.direction_deg },
                  target: { speed_ms: wm.speed_ms, direction_deg: wm.direction_deg },
                  hrrr_ref: p.hrrr_ref || null,
                  points: [],
              }
            : null,
        hrrrRun: p.hrrr_run
            ? {
                  date_utc: p.hrrr_run.date,
                  cycle_utc: p.hrrr_run.cycle,
                  valid_iso: `${p.hrrr_run.date}T${String(p.hrrr_run.cycle).padStart(2, '0')}:00:00Z`,
                  source: 'restored',
              }
            : null,
        hrrrError: null,
        windStale: false,
        fetchingWinds: false,
        dozerLines: (p.dozer_lines || []).map((coords) => ({ id: generateId(), coords })),
        simType: p.sim_type || s.simType,
        runName: '',
    })
    const perim = p.perimeter_coords && p.perimeter_coords[0]
    const closed = perim ? closeRing(perim.map((pt) => [Number(pt[0]), Number(pt[1])])) : null
    S.setState({
        perimeterRing: closed,
        perimeterSource: closed ? 'run' : null,
        perimeterName: p.fire_name || null,
        bboxBounds: closed ? bufferedBounds(closed) : null,
    })
    drawDraftLayers()
    if (closed) fitVisible(bufferedBounds(closed), 40, ringCentroid(closed))
}

export function clearPerimeter() {
    cancelMapDraw()
    cancelDozerLineDraw()
    cancelWindFetch()
    map.clearScenarioLayers()
    S.setState({
        perimeterRing: null,
        perimeterSource: null,
        perimeterName: null,
        bboxBounds: null,
        wind: null,
        hrrrRun: null,
        hrrrError: null,
        windStale: false,
        fetchingWinds: false,
        dozerLines: [],
    })
}

export function uploadPerimeter(file) {
    const reader = new FileReader()
    reader.onload = function (e) {
        try {
            const gj = JSON.parse(e.target.result)
            let geom
            let props = null
            if (gj.type === 'FeatureCollection' && gj.features && gj.features.length) {
                geom = gj.features[0].geometry
                props = gj.features[0].properties
            } else if (gj.type === 'Feature') {
                geom = gj.geometry
                props = gj.properties
            } else if (gj.type === 'Polygon' || gj.type === 'MultiPolygon') geom = gj
            else throw new Error('Unsupported GeoJSON type: ' + gj.type)
            if (!geom) throw new Error('The first feature has no geometry')
            let ring
            if (geom.type === 'Polygon') ring = geom.coordinates[0]
            else if (geom.type === 'MultiPolygon')
                // Largest part, same as picking a fire on the map
                ring = geom.coordinates
                    .map((poly) => poly[0])
                    .reduce((best, r) => (r.length > best.length ? r : best), [])
            else throw new Error('Geometry must be a Polygon or MultiPolygon')
            const name = pickFireName(props) || file.name.replace(/\.(geo)?json$/i, '')
            setPerimeter(ring, { source: 'uploaded', name })
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
    cancelDrawSessions()
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

// ─── Dozer lines ──────────────────────────────────────────────────────────────
// Simple stopgap fuel barriers: "fuel was cleared along this line, the mock
// spread should not cross it." No raster/backend involved — just a drawn
// line stored and sent through the payload alongside the perimeter/wind.

export function startDozerLineDraw() {
    const leafletMap = getMap()
    if (!leafletMap) {
        window.alert('Map not ready yet.')
        return
    }
    cancelDrawSessions()
    S.setState({ drawingDozerLine: true })
    dozerDrawSession = map.startLineDrawSession(leafletMap, {
        onDone: (coords) => {
            dozerDrawSession = null
            S.setState({ drawingDozerLine: false })
            if (coords) {
                const line = { id: generateId(), coords }
                const lines = [...S.getState().dozerLines, line]
                S.setState({ dozerLines: lines })
                map.showDozerLines(lines)
            }
        },
    })
}

export function cancelDozerLineDraw() {
    if (dozerDrawSession) dozerDrawSession.cancel()
}

export function removeDozerLine(id) {
    const lines = S.getState().dozerLines.filter((l) => l.id !== id)
    S.setState({ dozerLines: lines })
    map.showDozerLines(lines)
}

export function clearDozerLines() {
    cancelDozerLineDraw()
    S.setState({ dozerLines: [] })
    map.removeDozerLines()
}

// ─── HRRR fxx=0 wind fetch ────────────────────────────────────────────────────

let windFetchGen = 0

export function cancelWindFetch() {
    windFetchGen++
    if (autoFetchTimer) {
        clearTimeout(autoFetchTimer)
        autoFetchTimer = null
    }
    if (S.getState().fetchingWinds) S.setState({ fetchingWinds: false })
}

export function fetchWinds() {
    const s = S.getState()
    const bbox = bboxLonLat()
    if (!bbox) {
        window.alert('Draw a fire perimeter first. The wind region is derived from it.')
        return
    }
    const gen = ++windFetchGen
    if (autoFetchTimer) {
        clearTimeout(autoFetchTimer)
        autoFetchTimer = null
    }
    S.setState({ wind: null, hrrrRun: null, fetchingWinds: true, hrrrError: null, windStale: false })
    // The old arrows belong to the old wind
    if (!S.getState().activeJobId) map.removeWindVectors()

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
                wind: { base, target: { ...base }, hrrr_ref: data.hrrr_ref, points: data.points, rawRecords: data.rawRecords },
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
    // A background fetch for the draft must not draw arrows over a run, or on
    // the map at all while the tool is closed
    if (!toolOpen || s.activeJobId) return
    const w = s.wind
    if (!w || !w.points || w.points.length === 0) {
        map.removeWindVectors()
        return
    }
    map.showWindVectors(w.points, w.base, w.target)
}

// ─── Mock spread polygon ──────────────────────────────────────────────────────

// If the segment from `from` (original perimeter vertex, unburned side) to
// `to` (its displaced/spread position) crosses any dozer line, pull the
// vertex back to the nearest crossing — fire doesn't spread past a line
// where fuel's been cleared. Ties (multiple lines) resolve to whichever
// crossing is closest to `from`.
function clipToDozerLines(from, to, dozerLines) {
    if (!dozerLines || dozerLines.length === 0) return to
    const seg = lineString([from, to])
    let closest = null
    let closestDist = Infinity
    dozerLines.forEach((coords) => {
        if (!coords || coords.length < 2) return
        const inter = lineIntersect(seg, lineString(coords))
        inter.features.forEach((f) => {
            const pt = f.geometry.coordinates
            const d = Math.hypot(pt[0] - from[0], pt[1] - from[1])
            if (d < closestDist) {
                closestDist = d
                closest = pt
            }
        })
    })
    return closest || to
}

// Insert points along each edge so no edge is longer than stepKm. Spread only
// displaces vertices, so a dozer line lying between two widely spaced
// vertices would otherwise never be crossed and never clip anything.
function densifyRing(ring, stepKm) {
    const out = []
    for (let i = 0; i < ring.length - 1; i++) {
        const [x0, y0] = ring[i]
        const [x1, y1] = ring[i + 1]
        const kx = 111.32 * Math.cos((((y0 + y1) / 2) * Math.PI) / 180)
        const km = Math.hypot((x1 - x0) * kx, (y1 - y0) * 111.32)
        const n = Math.max(1, Math.ceil(km / stepKm))
        for (let j = 0; j < n; j++)
            out.push([x0 + ((x1 - x0) * j) / n, y0 + ((y1 - y0) * j) / n])
    }
    out.push(ring[ring.length - 1])
    return out
}

const DOZER_DENSIFY_MAX_POINTS = 1500

// Builds a crescent-shaped spread polygon that never overlaps the original
// perimeter. Only vertices on the downwind side are displaced; upwind vertices
// stay at their original position. The resulting polygon shares an edge with
// the original perimeter on the upwind side and extends outward downwind.
// Displacement is clipped against any drawn dozer lines (see clipToDozerLines).
function computeMockSpread() {
    const s = S.getState()
    const ring = s.perimeterRing
    const wind = s.wind && s.wind.target
    const dozerLines = s.dozerLines.map((l) => l.coords)
    if (!ring || !wind) return null

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
    // (reduce, not Math.max(...): large WFIGS rings overflow the call stack)
    const maxDot = ring.reduce(
        (m, [lx, ly]) => Math.max(m, (lx - cx) * spreadVecX + (ly - cy) * spreadVecY),
        -Infinity
    )
    // Centroid and maxDot come from the original ring (densifying would skew
    // a vertex-average centroid); only the displaced ring is densified.
    let outRing = ring
    if (dozerLines.length) {
        const perimKm = length(lineString(ring), { units: 'kilometers' })
        outRing = densifyRing(ring, Math.max(0.05, perimKm / DOZER_DENSIFY_MAX_POINTS))
    }
    const spreadRing = outRing.map(([lon, lat]) => {
        const dot = (lon - cx) * spreadVecX + (lat - cy) * spreadVecY
        const weight = maxDot > 0 ? Math.max(0, dot / maxDot) : 0
        const displaced = [
            lon + dLon * spreadVecX * weight,
            lat + dLat * spreadVecY * weight,
        ]
        return clipToDozerLines([lon, lat], displaced, dozerLines)
    })

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
    // The name is optional: default to the fire and the time of the run
    const name = (s.runName || '').trim() || `${s.perimeterName || 'Scenario'} · ${fmtRunTime(Date.now())}`
    if (!s.wind) {
        window.alert('Fetch winds first. The forecast needs a wind field.')
        return
    }
    const wind = s.wind.target
    if (!wind) {
        window.alert('No usable wind data. Refetch the latest winds.')
        return
    }
    cancelDrawSessions()
    const spreadRing = computeMockSpread()
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
        fire_name: s.perimeterName || null,
        sim_type: s.simType,
        fuel: s.fuel,
        dozer_lines: s.dozerLines.map((l) => l.coords),
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
    const job = {
        payload,
        name,
        status: 'completed',
        startedAt: Date.now(),
        result,
        spreadRing,
    }
    // Open the new run's results; the draft stays behind for "Back to setup".
    S.setState({
        jobs: { ...st.jobs, [jobId]: job },
        jobIds: [jobId, ...st.jobIds],
        page: 0,
        activeJobId: jobId,
        showActiveJson: false,
        runName: '',
        submitting: false,
    })
    drawRunLayers(job)
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

// Same stats as the Results card and PNG, as plain values
function runSummary(job) {
    const p = job.payload || {}
    const st = runStats(job)
    const round = (v, d = 0) => (v == null ? null : Number(v.toFixed(d)))
    return {
        name: job.name || '',
        fire_name: p.fire_name || null,
        sim_type: p.sim_type || 'fire_spread',
        run_time: job.startedAt ? new Date(job.startedAt).toISOString() : null,
        starting_acres: round(st.start, 1),
        forecast_acres: round(st.end, 1),
        growth_acres: round(st.growth, 1),
        growth_pct: round(st.growthPct, 1),
        wind_speed_ms: p.wind_mods ? p.wind_mods.speed_ms : null,
        wind_direction_deg: p.wind_mods ? p.wind_mods.direction_deg : null,
        hrrr: fmtHrrr(p.hrrr_run),
        dozer_lines: Array.isArray(p.dozer_lines) ? p.dozer_lines.length : 0,
    }
}

export function downloadSpreadGeoJSON(job) {
    const p = job && job.payload
    const spreadRing = job && job.spreadRing
    const summary = runSummary(job)
    const features = []
    if (p && p.perimeter_coords && p.perimeter_coords[0]) {
        features.push({
            type: 'Feature',
            properties: {
                type: 'current_perimeter',
                name: summary.name,
                fire_name: summary.fire_name,
                acres: summary.starting_acres,
            },
            geometry: { type: 'Polygon', coordinates: p.perimeter_coords },
        })
    }
    if (spreadRing) {
        features.push({
            type: 'Feature',
            properties: { type: 'predicted_spread', ...summary },
            geometry: { type: 'Polygon', coordinates: [spreadRing] },
        })
    }
    const geojson = { type: 'FeatureCollection', properties: summary, features }
    const blob = new Blob([JSON.stringify(geojson, null, 2)], {
        type: 'application/geo+json',
    })
    const safeName = (job.name || 'prediction').replace(/[^a-z0-9_-]/gi, '_')
    triggerDownload(blob, `${safeName}_prediction.geojson`)
}

// Summary card drawn onto the exported PNG so the image stands on its own:
// run + fire name, time, areas, wind, and a legend for the map colors.
function drawSummaryCard(canvas, job, scale) {
    const ctx = canvas.getContext('2d')
    const p = job.payload || {}
    const isSmoke = p.sim_type === 'smoke_dispersion'
    const st = runStats(job)
    const sub = runSubtitle(job)
    const stats = isSmoke
        ? [['Fire area', fmtAcres(st.start)], ['Smoke extent', fmtAcres(st.end)]]
        : [
              ['Starting area', fmtAcres(st.start)],
              ['Forecast area', fmtAcres(st.end)],
              ['Growth', st.growth == null ? '—' : `+${fmtAcres(st.growth)} (${fmtPct(st.growthPct)})`],
          ]
    const nDozer = Array.isArray(p.dozer_lines) ? p.dozer_lines.length : 0
    const details = [
        ['Model', simTypeLabel(p.sim_type)],
        ['Wind', fmtWind(p.wind_mods)],
        ['Weather', fmtHrrr(p.hrrr_run)],
        ['Dozer lines', nDozer ? String(nDozer) : null],
    ].filter(([, v]) => v)
    const legend = [
        [map.COLOR_PERIM, 'Starting perimeter'],
        [map.COLOR_SPREAD, isSmoke ? 'Smoke extent' : 'Forecast spread'],
    ]
    if (nDozer) legend.push([map.COLOR_DOZER, 'Dozer line'])

    const W = 340
    const pad = 14
    const lineH = 18
    const H =
        pad + 22 + (sub ? 18 : 0) + 10 + stats.length * lineH + 8 +
        details.length * lineH + 10 + legend.length * lineH + 8 + 14 + pad
    const x0 = 16
    const y0 = canvas.height / scale - H - 16

    ctx.save()
    // html2canvas leaves its own scale on the context; start from a clean one
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.fillStyle = 'rgba(18, 22, 26, 0.9)'
    ctx.fillRect(x0, y0, W, H)
    ctx.fillStyle = '#ffdd5c'
    ctx.fillRect(x0, y0, 3, H)
    let y = y0 + pad
    const text = (str, x, font, color, align = 'left', maxW = W - 2 * pad) => {
        ctx.font = font
        ctx.fillStyle = color
        ctx.textAlign = align
        ctx.textBaseline = 'top'
        let out = String(str)
        if (ctx.measureText(out).width > maxW) {
            while (out.length > 1 && ctx.measureText(out + '…').width > maxW) out = out.slice(0, -1)
            out += '…'
        }
        ctx.fillText(out, x, y)
    }
    const left = x0 + pad
    const right = x0 + W - pad
    text(job.name || 'Forecast', left, 'bold 16px sans-serif', '#ffffff')
    y += 22
    if (sub) {
        text(sub, left, '12px sans-serif', '#b4bac0')
        y += 18
    }
    y += 10
    stats.forEach(([k, v]) => {
        text(k, left, '13px sans-serif', '#b4bac0')
        text(v, right, 'bold 13px sans-serif', '#ffffff', 'right')
        y += lineH
    })
    y += 8
    details.forEach(([k, v]) => {
        text(k, left, '12px sans-serif', '#b4bac0')
        text(v, right, '12px sans-serif', '#e8ebee', 'right')
        y += lineH
    })
    y += 10
    legend.forEach(([color, label]) => {
        ctx.fillStyle = color
        ctx.fillRect(left, y + 3, 14, 10)
        text(label, left + 22, '12px sans-serif', '#e8ebee')
        y += lineH
    })
    y += 8
    text('Placeholder spread model', left, 'italic 11px sans-serif', '#8f969c')
    ctx.restore()
}

export function downloadSpreadPNG(job) {
    const leafletMap = getMap()
    if (!leafletMap) return
    const scale = 2
    const container = leafletMap.getContainer()
    // Only the part of the map the user can see: the tool panel and the time
    // bars sit over its edges, and the view is centered on what's left.
    const edges = coveredEdges(container)
    const fail = (err) =>
        window.alert('PNG export failed: ' + ((err && err.message) || 'the map image could not be read'))
    import('html2canvas')
        .then(({ default: html2canvas }) =>
            // useCORS without allowTaint: a tainted canvas can't be exported
            html2canvas(container, {
                useCORS: true,
                scale,
                // Zoom/home buttons, compass, scale bar
                ignoreElements: (el) =>
                    el.classList && el.classList.contains('leaflet-control-container'),
            })
        )
        .then((full) => {
            const w = Math.max(1, container.clientWidth - edges.left - edges.right)
            const h = Math.max(1, container.clientHeight - edges.top - edges.bottom)
            const canvas = document.createElement('canvas')
            canvas.width = Math.round(w * scale)
            canvas.height = Math.round(h * scale)
            canvas
                .getContext('2d')
                .drawImage(
                    full,
                    edges.left * scale,
                    edges.top * scale,
                    canvas.width,
                    canvas.height,
                    0,
                    0,
                    canvas.width,
                    canvas.height
                )
            drawSummaryCard(canvas, job, scale)
            canvas.toBlob((blob) => {
                if (!blob) return fail()
                const safeName = (job.name || 'prediction').replace(/[^a-z0-9_-]/gi, '_')
                triggerDownload(blob, `${safeName}_prediction.png`)
            }, 'image/png')
        })
        .catch(fail)
}

// ─── WFIGS / map-layer fire click ────────────────────────────────────────────

// Entry point for a fire picked on the map: a click while the tool is open,
// or one made while it was closed, picked up on the next open. Signed out, it
// waits for login.
export function selectFireFromMap(feature) {
    if (!S.getState().loggedIn) {
        pendingMapFire = feature
        return
    }
    lastMapFire = feature
    setBboxFromMapFeature(feature)
}

export function ignoreMapFire(feature) {
    lastMapFire = feature
}

export function isNewMapFire(feature) {
    return feature !== lastMapFire
}

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
    // Closes any run being viewed, since this starts a new scenario.
    setPerimeter(ring, { source: 'selected', name: pickFireName(feature.properties) })

    fitVisible(bufferedBounds(ring), 40, ringCentroid(ring))
}

// ─── Run history / swapping ───────────────────────────────────────────────────

export function loadHistory() {
    const userId = S.getState().authUserId
    if (!userId) return
    fetchJobHistory(userId).then((reg) => {
        // Someone else signed in (or out) while this was loading
        if (S.getState().authUserId !== userId) return
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

// Delete a run from local state and from the DB-backed history.
export function deleteRun(id) {
    const s = S.getState()
    if (!s.jobs[id]) return
    const jobs = { ...s.jobs }
    delete jobs[id]
    const jobIds = s.jobIds.filter((jid) => jid !== id)
    if (s.activeJobId === id) exitRunView()
    S.setState({ jobs, jobIds })
    mmgisFetch(`api/whatif-runs/${encodeURIComponent(id)}`, {
        method: 'DELETE',
    }).catch(() => {})
}

// Clicking a run opens its results; clicking the open run again closes it.
export function selectRun(id) {
    const s = S.getState()
    if (s.activeJobId === id) return closeRunView()
    const job = s.jobs[id]
    if (!job) return
    cancelDrawSessions()
    S.setState({ activeJobId: id, showActiveJson: false })
    drawRunLayers(job, { fit: true })
}

// All user-triggered behavior for the Wildfire What-If tool. Components call
// these; they orchestrate the store (state), map (Leaflet), and the backend.

import useWhatIfStore, { BBOX_BUFFER_KM, FORECAST_HOURS, hourEdited } from './store'
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
        windStale: S.getState().hours != null && !(opts && opts.fromRun),
    })
    if (S.getState().hours) renderWindVectors()
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
        hours: null,
        hrrrRun: null,
        hrrrError: null,
        windStale: false,
        fetchingWinds: false,
        windProgress: null,
        selectedFxx: 0,
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

// ─── HRRR 12-hour wind bundle ─────────────────────────────────────────────────

// Streams the 13 forecast hours in individually: f00 lands first (so editing
// can start immediately), the rest load with limited concurrency while chips
// fill in. `windFetchGen` guards against stale responses after a refetch or
// perimeter clear.
let windFetchGen = 0
const WIND_FETCH_CONCURRENCY = 4

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
    const params = { date: s.hrrrDate, hourPdt: s.hrrrHour, bbox }
    S.setState({
        hours: Array.from({ length: FORECAST_HOURS }, (_, fxx) => ({
            fxx,
            hrrr_ref: null,
            points: [],
            error: null,
            base: null,
            target: null,
            loading: true,
        })),
        hrrrRun: null,
        selectedFxx: 0,
        editScope: 'hour',
        fetchingWinds: true,
        windProgress: { done: 0, total: FORECAST_HOURS },
        hrrrError: null,
        windStale: false,
    })

    function applyHour(fxx, data) {
        if (gen !== windFetchGen) return
        const st = S.getState()
        if (!st.hours) return
        const mean = data && !data.error ? meanWind(data.points) : null
        const base = mean
            ? {
                  speed_ms: Math.round(mean.speed_ms * 10) / 10,
                  direction_deg: Math.round(mean.direction_deg),
              }
            : null
        const hours = st.hours.map((h) =>
            h.fxx === fxx
                ? {
                      ...h,
                      loading: false,
                      hrrr_ref: (data && data.hrrr_ref) || h.hrrr_ref,
                      points: (data && data.points) || [],
                      error: base
                          ? null
                          : (data && data.error) || 'No wind data',
                      base,
                      target: base ? { ...base } : null,
                  }
                : h
        )
        const done = (st.windProgress ? st.windProgress.done : 0) + 1
        const patch = { hours, windProgress: { done, total: FORECAST_HOURS } }
        if (!st.hrrrRun && base && data.cycle_utc != null) {
            patch.hrrrRun = {
                date_utc: data.date_utc,
                cycle_utc: data.cycle_utc,
                hour_pdt: Number(data.hour_pdt),
                source: data.source,
            }
        }
        if (done >= FORECAST_HOURS) {
            patch.fetchingWinds = false
            patch.windProgress = null
            if (!hours.some((h) => h.base)) {
                patch.hours = null
                patch.hrrrError =
                    (hours[0] && hours[0].error) || 'No wind data returned'
            }
        }
        S.setState(patch)
        if (fxx === S.getState().selectedFxx) renderWindVectors()
    }

    const fetchOne = (fxx) =>
        fetchWindHour(s.backendUrl, { ...params, fxx })
            .then((data) => applyHour(fxx, data))
            .catch((err) => applyHour(fxx, { error: err.message }))

    fetchOne(0).then(() => {
        if (gen !== windFetchGen) return
        const queue = []
        for (let fxx = 1; fxx < FORECAST_HOURS; fxx++) queue.push(fxx)
        const next = () => {
            if (gen !== windFetchGen) return
            const fxx = queue.shift()
            if (fxx == null) return
            return fetchOne(fxx).then(next)
        }
        for (let i = 0; i < WIND_FETCH_CONCURRENCY; i++) next()
    })
}

export function selectHour(fxx) {
    S.setState({ selectedFxx: fxx })
    renderWindVectors()
}

// Set speed/direction for the selected hour. In 'all' scope the change is a
// delta applied to every forecast hour together (anchored at the selected
// hour), preserving hour-to-hour differences.
export function setWind(field, value) {
    const s = S.getState()
    if (!s.hours) return
    const all = s.editScope === 'all'
    const sel = s.hours[s.selectedFxx]
    if (!sel || !sel.target) return
    const delta = value - sel.target[field]
    const hours = s.hours.map((h, i) => {
        if (!h.target) return h
        if (!all && i !== s.selectedFxx) return h
        const target = { ...h.target }
        if (field === 'speed_ms') {
            const v = all ? target.speed_ms + delta : value
            target.speed_ms = Math.round(Math.max(0, Math.min(40, v)) * 10) / 10
        } else {
            const v = all ? target.direction_deg + delta : value
            target.direction_deg = ((Math.round(v) % 360) + 360) % 360
        }
        return { ...h, target }
    })
    S.setState({ hours })
    renderWindVectors()
}

export function resetHours(all) {
    const s = S.getState()
    if (!s.hours) return
    const hours = s.hours.map((h, i) => {
        if (!h.base) return h
        if (!all && i !== s.selectedFxx) return h
        return { ...h, target: { ...h.base } }
    })
    S.setState({ hours })
    renderWindVectors()
}

export function renderWindVectors() {
    const s = S.getState()
    const h = s.hours && s.hours[s.selectedFxx]
    if (!h || !h.points || h.points.length === 0 || !h.base) {
        map.removeWindVectors()
        return
    }
    map.showWindVectors(h.points, h.base, h.target)
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
    if (!s.hours) {
        window.alert('Fetch the 12-hr HRRR winds first — the forecast needs a wind field.')
        return
    }
    const sel = s.hours[s.selectedFxx]
    const wind =
        (sel && sel.target) ||
        (s.hours.find((h) => h.target) || {}).target
    if (!wind) {
        window.alert('No usable wind data — refetch HRRR winds.')
        return
    }
    const payload = {
        hrrr_ref: sel
            ? sel.hrrr_ref
            : `hrrr.t${String(s.hrrrHour).padStart(2, '0')}z.wrfsfcf00.grib2`,
        hrrr_run: s.hrrrRun
            ? { date: s.hrrrRun.date_utc, cycle: s.hrrrRun.cycle_utc, fxx: s.selectedFxx }
            : null,
        wind_mods: {
            speed_ms: wind.speed_ms,
            direction_deg: wind.direction_deg,
        },
        // Full edited 12-hour profile (recorded with the run; extra fields are
        // ignored by the payload endpoint)
        wind_profile: s.hours
            ? s.hours.map((h) => ({
                  fxx: h.fxx,
                  hrrr_ref: h.hrrr_ref,
                  speed_ms: h.target ? h.target.speed_ms : null,
                  direction_deg: h.target ? h.target.direction_deg : null,
                  edited: !!hourEdited(h),
              }))
            : null,
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
        return
    }
    const job = s.jobs[id]
    const p = job && job.payload
    S.setState({ activeJobId: id, showActiveJson: false })
    if (!p) return
    // Restore the run's scenario onto the map and controls
    if (p.perimeter_coords && p.perimeter_coords[0]) {
        cancelWindFetch()
        map.removeWindVectors()
        S.setState({
            hours: null,
            hrrrRun: null,
            windStale: false,
            fetchingWinds: false,
            windProgress: null,
            selectedFxx: 0,
        })
        setPerimeter(p.perimeter_coords[0], { fromRun: true })
    }
    if (p.sim_type) S.setState({ simType: p.sim_type })
}

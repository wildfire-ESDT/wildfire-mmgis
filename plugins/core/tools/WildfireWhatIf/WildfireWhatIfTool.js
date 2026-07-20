import $ from 'jquery'
import './WildfireWhatIfTool.css'
import L_ from '@basics/Layers_/Layers_'
import ToolController_ from '@basics/ToolController_/ToolController_'

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 30000
const DEFAULT_BACKEND_URL = 'http://localhost:8000'
const PAGE_SIZE = 10

// ─── MMGIS fetch helpers (same pattern as WorkflowsTool) ──────────────────────

function mmgisUrl(path) {
    const root = (window.mmgisglobal && window.mmgisglobal.ROOT_PATH) || ''
    return (root ? root + '/' : '') + path.replace(/^\//, '')
}

function mmgisFetch(path, init) {
    return fetch(mmgisUrl(path), {
        credentials: 'same-origin',
        headers: {
            Accept: 'application/json',
            ...((init && init.headers) || {}),
        },
        ...(init || {}),
    })
}

// ─── Job history (mirrors WorkflowsTool's DB-backed registry) ─────────────────

function fetchJobHistory() {
    return mmgisFetch('api/workflows-history')
        .then((r) => r.json())
        .then((d) => {
            if (!d || d.status !== 'success' || !Array.isArray(d.body)) return {}
            const out = {}
            d.body.forEach((row) => {
                if (!row || !row.workflow_id) return
                // Only load rows that look like wildfire submissions
                if (row.endpoint && !row.endpoint.includes('wildfire')) return
                out[row.workflow_id] = {
                    endpoint: row.endpoint || '',
                    payload: row.payload || null,
                    name: row.name || '',
                    ts: row.created_on ? new Date(row.created_on).getTime() : Date.now(),
                }
            })
            return out
        })
        .catch(() => ({}))
}

function recordJob(jobId, endpoint, payload, name) {
    return mmgisFetch('api/workflows-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            workflow_id: jobId,
            endpoint,
            payload,
            name: name || '',
        }),
    }).catch(() => {})
}

// ─── Wind math ────────────────────────────────────────────────────────────────

function uvToSpeedDir(u, v) {
    const speed = Math.sqrt(u * u + v * v)
    // Meteorological "FROM" direction: 180° + math direction
    let dir = (270 - (Math.atan2(v, u) * 180) / Math.PI) % 360
    if (dir < 0) dir += 360
    return { speed_ms: speed, direction_deg: dir }
}

function msToMph(ms) {
    return (ms * 2.23694).toFixed(1)
}

const COMPASS_LABELS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
function dirLabel(deg) {
    return COMPASS_LABELS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHTML(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

function normalizeStatus(s) {
    if (!s) return 'unknown'
    const l = String(s).toLowerCase()
    if (l === 'completed' || l === 'complete' || l === 'succeeded' || l === 'success') return 'completed'
    if (l === 'failed' || l === 'error') return 'failed'
    if (l === 'running' || l === 'processing') return 'running'
    if (l === 'queued' || l === 'pending') return 'queued'
    if (l === 'cancelled' || l === 'canceled') return 'cancelled'
    return l
}

function isTerminal(s) {
    const n = normalizeStatus(s)
    return n === 'completed' || n === 'failed' || n === 'cancelled'
}

function formatLocale(iso) {
    if (!iso) return ''
    const s = typeof iso === 'string' && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso + 'Z' : iso
    const d = new Date(s)
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString()
}

function generateId() {
    return 'wf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
}

// ─── Layer management (mirrors WorkflowsTool pattern) ─────────────────────────

function ensureGroup() {
    if (L_.layers.data[GROUP_UUID]) return L_.layers.data[GROUP_UUID]
    const group = {
        name: GROUP_UUID,
        uuid: GROUP_UUID,
        display_name: GROUP_DISPLAY_NAME,
        type: 'header',
        expanded: true,
        visibility: true,
        sublayers: [],
        time: { enabled: false },
    }
    L_.layers.data[GROUP_UUID] = group
    L_.layers.dataFlat = L_.layers.dataFlat || []
    L_.layers.dataFlat.unshift(group)
    return group
}

function renderPagination(page, totalPages, total) {
    const $container = $('#wildfireTool .ww-pagination')
    if ($container.length === 0) return
    $container.empty()
    if (totalPages <= 1) return
    const $prev = $('<button type="button" class="ww-page-btn">Prev</button>')
    if (page === 0) $prev.attr('disabled', true)
    $prev.on('click', () => WildfireWhatIf.goToPage(WildfireWhatIf.page - 1))
    const $next = $('<button type="button" class="ww-page-btn">Next</button>')
    if (page >= totalPages - 1) $next.attr('disabled', true)
    $next.on('click', () => WildfireWhatIf.goToPage(WildfireWhatIf.page + 1))
    const $label = $(`<span class="ww-page-label">Page ${page + 1} of ${totalPages} · ${total} scenarios</span>`)
    $container.append($prev).append($label).append($next)
}

// ─── Tool state ────────────────────────────────────────────────────────────────

const WildfireWhatIf = {
    height: 0,
    width: 380,
    vars: null,
    backendUrl: DEFAULT_BACKEND_URL,
    // Wind state
    windSpeed_ms: 8,
    windDir_deg: 225,
    windFromHRRR: false,
    hrrr_date: new Date().toISOString().slice(0, 10),
    hrrr_hour_pdt: 12,
    // Bbox state (HRRR fetch region + wind vector canvas)
    bboxGeoJSON: null,        // GeoJSON Polygon feature for the bounding box
    _bboxLayer: null,         // Leaflet layer for the bbox rectangle
    // Fire perimeter state (drawn inside the bbox)
    perimeterGeoJSON: null,   // GeoJSON Polygon feature
    _perimLayer: null,        // Leaflet layer for the fire perimeter
    // Wind vector map layer
    _windLayer: null,         // Leaflet LayerGroup of arrow markers
    _hrrrPoints: null,        // raw {lon,lat,u,v} points from last HRRR fetch
    windVectorMode: 'rotated', // 'uniform' | 'rotated'
    // Shared draw handler
    _drawHandler: null,       // active L.Draw.* handler
    _drawMode: null,          // 'bbox' | 'polygon'
    _onCreated: null,         // current draw:created listener reference
    // Simulation
    simType: 'fire_spread',  // 'fire_spread' | 'smoke_dispersion'
    // Job tracking
    jobs: {},
    jobIds: [],
    page: 0,
    expandedIds: null,
    pollTimer: null,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    MMGISInterface: null,

    make: function () {
        WildfireWhatIf.vars = L_.getToolVars('wildfire-whatif') || {}
        WildfireWhatIf.backendUrl =
            WildfireWhatIf.vars.backendUrl || DEFAULT_BACKEND_URL
        WildfireWhatIf.hrrr_date =
            WildfireWhatIf.vars.hrrr_date || new Date().toISOString().slice(0, 10)
        WildfireWhatIf.hrrr_hour_pdt =
            WildfireWhatIf.vars.hrrr_hour_pdt != null
                ? Number(WildfireWhatIf.vars.hrrr_hour_pdt)
                : 12
        if (!WildfireWhatIf.expandedIds) WildfireWhatIf.expandedIds = new Set()
        WildfireWhatIf.MMGISInterface = new interfaceWithMMGIS()
        fetchJobHistory().then((reg) => {
            Object.keys(reg).forEach((id) => {
                if (!WildfireWhatIf.jobs[id]) {
                    WildfireWhatIf.jobs[id] = {
                        ...reg[id],
                        status: 'unknown',
                        startedAt: reg[id].ts || Date.now(),
                    }
                }
            })
            WildfireWhatIf.renderJobs()
        })
    },

    destroy: function () {
        WildfireWhatIf.cancelMapDraw()
        WildfireWhatIf._removeMapLayer('_bboxLayer')
        WildfireWhatIf._removeMapLayer('_perimLayer')
        WildfireWhatIf._removeMapLayer('_windLayer')
        if (WildfireWhatIf.MMGISInterface)
            WildfireWhatIf.MMGISInterface.separateFromMMGIS()
        WildfireWhatIf.MMGISInterface = null
        if (WildfireWhatIf.pollTimer) {
            clearInterval(WildfireWhatIf.pollTimer)
            WildfireWhatIf.pollTimer = null
        }
    },

    submit: function () {
        if (!WildfireWhatIf.perimeterGeoJSON) {
            window.alert('Draw or upload a fire perimeter first.')
            return
        }
        const perimeter = WildfireWhatIf.perimeterGeoJSON
        const ring = perimeter.geometry
            ? perimeter.geometry.coordinates
            : perimeter.coordinates
        const name = ($('#ww-run-name').val() || '').trim()
        if (!name) {
            $('#ww-run-name').addClass('ww-input-error').trigger('focus')
            return
        }
        const payload = {
            hrrr_ref: `hrrr.t${String(WildfireWhatIf.hrrr_hour_pdt).padStart(2,'0')}z.wrfsfcf00.grib2`,
            wind_mods: {
                speed_ms: WildfireWhatIf.windSpeed_ms,
                direction_deg: WildfireWhatIf.windDir_deg,
            },
            perimeter_coords: ring,
            perimeter_props: {
                runid: generateId(),
                t: new Date().toISOString(),
                synthetic: true,
            },
            sim_type: WildfireWhatIf.simType,
        }
        const $btn = $('#ww-generate-btn')
        $btn.attr('disabled', true).text('Submitting…')
        fetch(WildfireWhatIf.backendUrl + '/api/payload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
            .then((r) => r.json())
            .then((body) => {
                const jobId = generateId()
                WildfireWhatIf.jobs[jobId] = {
                    endpoint: '/api/payload',
                    payload,
                    name,
                    status: 'completed',
                    startedAt: Date.now(),
                    result: body,
                }
                if (WildfireWhatIf.jobIds.indexOf(jobId) === -1)
                    WildfireWhatIf.jobIds.unshift(jobId)
                WildfireWhatIf.page = 0
                recordJob(jobId, '/api/payload', payload, name)
                WildfireWhatIf.renderJobs()
                $btn.attr('disabled', false).text('Generate Forecast')
                $('#ww-run-name').val('')
            })
            .catch((err) => {
                $btn.attr('disabled', false).text('Generate Forecast')
                window.alert('Submission failed: ' + err.message)
            })
    },

    fetchHRRRWind: function () {
        const $btn = $('#ww-hrrr-btn')
        $btn.attr('disabled', true).text('Fetching…')
        // Must have a bbox drawn first
        const b = WildfireWhatIf.bboxBounds()
        if (!b) {
            $btn.attr('disabled', false).text('Fetch from HRRR')
            window.alert('Draw a bounding box first — it defines the HRRR fetch region.')
            return
        }
        const url = new URL(WildfireWhatIf.backendUrl + '/api/wind')
        url.searchParams.set('date', WildfireWhatIf.hrrr_date)
        url.searchParams.set('hour_pdt', WildfireWhatIf.hrrr_hour_pdt)
        url.searchParams.set('fxx', 0)
        url.searchParams.set('lon_min', b[0])
        url.searchParams.set('lat_min', b[1])
        url.searchParams.set('lon_max', b[2])
        url.searchParams.set('lat_max', b[3])
        fetch(url.toString())
            .then((r) => r.json())
            .then((data) => {
                if (!data.points || data.points.length === 0) throw new Error('No wind data returned')
                WildfireWhatIf._hrrrPoints = data.points
                // Seed sliders from mean U/V
                const pts = data.points
                const meanU = pts.reduce((s, p) => s + p.u, 0) / pts.length
                const meanV = pts.reduce((s, p) => s + p.v, 0) / pts.length
                const { speed_ms, direction_deg } = uvToSpeedDir(meanU, meanV)
                WildfireWhatIf.windSpeed_ms = Math.round(speed_ms * 10) / 10
                WildfireWhatIf.windDir_deg = Math.round(direction_deg)
                WildfireWhatIf.windFromHRRR = true
                WildfireWhatIf.renderWindControls()
                WildfireWhatIf.renderWindVectors()
                $btn.attr('disabled', false).text('Fetch from HRRR')
            })
            .catch((err) => {
                $btn.attr('disabled', false).text('Fetch from HRRR')
                window.alert('HRRR fetch failed: ' + err.message)
            })
    },

    // Re-render wind vectors on the map whenever speed/direction sliders change.
    renderWindVectors: function () {
        const leafletMap = window.mmgisAPI && window.mmgisAPI.map
        if (!leafletMap) return
        const L = window.L
        WildfireWhatIf._removeMapLayer('_windLayer')
        const pts = WildfireWhatIf._hrrrPoints
        if (!pts || pts.length === 0) return

        // Mean of original field
        const meanU0 = pts.reduce((s, p) => s + p.u, 0) / pts.length
        const meanV0 = pts.reduce((s, p) => s + p.v, 0) / pts.length
        const origMeanSpeed = Math.sqrt(meanU0 * meanU0 + meanV0 * meanV0) || 1
        const origMeanAng = Math.atan2(meanV0, meanU0)  // math angle of original mean

        const targetSpeed = WildfireWhatIf.windSpeed_ms
        const targetDir = WildfireWhatIf.windDir_deg   // meteorological FROM direction
        // Target math angle (direction wind is GOING TO)
        const targetMathAng = Math.PI / 180 * (270 - targetDir)
        // Delta rotation from original mean to target
        const deltaAng = targetMathAng - origMeanAng
        // Speed scale factor
        const speedScale = targetSpeed / origMeanSpeed

        const mode = WildfireWhatIf.windVectorMode  // 'uniform' | 'rotated'

        const markers = []
        pts.forEach((pt) => {
            let u, v
            if (mode === 'uniform') {
                // Every arrow points exactly the target direction; only length varies
                // by local speed ratio, preserving spatial speed variation.
                const localSpeed = Math.sqrt(pt.u * pt.u + pt.v * pt.v)
                const newSpeed = localSpeed * speedScale
                u = newSpeed * Math.cos(targetMathAng)
                v = newSpeed * Math.sin(targetMathAng)
            } else {
                // 'rotated': rotate each point's original vector by deltaAng and
                // scale by speedScale. Preserves spatial direction AND speed variation
                // (terrain-induced shear rotates as a whole). More physically realistic.
                const localSpeed = Math.sqrt(pt.u * pt.u + pt.v * pt.v)
                const localAng = Math.atan2(pt.v, pt.u)
                const newAng = localAng + deltaAng
                const newSpeed = localSpeed * speedScale
                u = newSpeed * Math.cos(newAng)
                v = newSpeed * Math.sin(newAng)
            }

            const speed = Math.sqrt(u * u + v * v)
            // Interpolate light-steel-blue → white based on speed (0–15 m/s)
            const t = Math.min(speed / 15, 1)
            const r = Math.round(176 + (255 - 176) * t)
            const g = Math.round(196 + (255 - 196) * t)
            const b = Math.round(222 + (255 - 222) * t)
            const color = `rgb(${r},${g},${b})`
            const len = Math.max(8, Math.min(30, 6 + speed * 2))
            const angDeg = Math.atan2(-v, u) * 180 / Math.PI
            const svg =
                `<svg xmlns="http://www.w3.org/2000/svg" width="${len+10}" height="${len+10}" viewBox="-${(len+10)/2} -${(len+10)/2} ${len+10} ${len+10}" style="overflow:visible">` +
                `<g transform="rotate(${angDeg})">` +
                `<line x1="0" y1="0" x2="${len}" y2="0" stroke="${color}" stroke-width="1.5"/>` +
                `<polygon points="${len},0 ${len-5},-3 ${len-5},3" fill="${color}"/>` +
                `</g></svg>`
            markers.push(L.marker([pt.lat, pt.lon], {
                icon: L.divIcon({ html: svg, className: 'ww-wind-arrow-icon', iconSize: [len+10, len+10], iconAnchor: [(len+10)/2, (len+10)/2] }),
                interactive: false,
            }))
        })
        WildfireWhatIf._windLayer = L.layerGroup(markers).addTo(leafletMap)
    },

    // Extract [lon_min, lat_min, lon_max, lat_max] from the drawn bbox.
    bboxBounds: function () {
        const p = WildfireWhatIf.bboxGeoJSON
        if (!p) return null
        return WildfireWhatIf._geoJSONBounds(p)
    },

    _geoJSONBounds: function (feature) {
        const coords = (feature.geometry ? feature.geometry.coordinates : feature.coordinates) || []
        const ring = Array.isArray(coords[0]) && Array.isArray(coords[0][0]) ? coords[0] : coords
        if (!ring.length) return null
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
        ring.forEach(([lon, lat]) => {
            if (lon < minLon) minLon = lon
            if (lat < minLat) minLat = lat
            if (lon > maxLon) maxLon = lon
            if (lat > maxLat) maxLat = lat
        })
        return [minLon, minLat, maxLon, maxLat]
    },

    // Start an interactive Leaflet draw session on the map.
    // mode: 'bbox' | 'polygon'
    startMapDraw: function (mode) {
        const leafletMap = window.mmgisAPI && window.mmgisAPI.map
        if (!leafletMap) { window.alert('Map not ready yet.'); return }

        // Disable any previous handler directly — do NOT call cancelMapDraw()
        // because that triggers draw:drawstop which would remove our new listeners.
        if (WildfireWhatIf._drawHandler) {
            try { WildfireWhatIf._drawHandler.disable() } catch (e) {}
            WildfireWhatIf._drawHandler = null
        }

        WildfireWhatIf._drawMode = mode
        $('#ww-draw-polygon-btn, #ww-draw-bbox-btn').removeClass('ww-btn-active')
        $(`#ww-draw-${mode === 'bbox' ? 'bbox' : 'polygon'}-btn`).addClass('ww-btn-active')
        $('#ww-draw-hint').text(
            mode === 'bbox'
                ? 'Click and drag to define the HRRR fetch region. Press Escape to cancel.'
                : 'Click to add vertices inside the bbox. Double-click to finish. Press Escape to cancel.'
        ).show()

        const L = window.L
        const handler = mode === 'bbox'
            ? new L.Draw.Rectangle(leafletMap, {
                shapeOptions: { color: '#4fc3f7', weight: 2, fillOpacity: 0.08, dashArray: '6,4' },
              })
            : new L.Draw.Polygon(leafletMap, {
                showArea: true, allowIntersection: false, guidelineDistance: 15,
                shapeOptions: { color: '#ff6b35', weight: 2, fillOpacity: 0.15 },
              })

        // Remove any stale listener from a previous session before adding a new one
        if (WildfireWhatIf._onCreated) {
            leafletMap.off('draw:created', WildfireWhatIf._onCreated)
        }
        WildfireWhatIf._onCreated = function (e) {
            leafletMap.off('draw:created', WildfireWhatIf._onCreated)
            WildfireWhatIf._onCreated = null
            WildfireWhatIf._drawHandler = null
            WildfireWhatIf._drawMode = null
            $('#ww-draw-polygon-btn, #ww-draw-bbox-btn').removeClass('ww-btn-active')
            $('#ww-draw-hint').hide()

            const geoJSON = e.layer.toGeoJSON()
            WildfireWhatIf.perimeterGeoJSON = geoJSON
            WildfireWhatIf._setLayer('_perimLayer', e.layer,
                { color: '#ff6b35', weight: 2, fillOpacity: 0.12, dashArray: '5,4' })
            WildfireWhatIf.renderPerimeterStatus()
            WildfireWhatIf._deriveBboxFromPerimeter()
        }

        leafletMap.on('draw:created', WildfireWhatIf._onCreated)
        WildfireWhatIf._drawHandler = handler
        handler.enable()
    },

    cancelMapDraw: function () {
        const leafletMap = window.mmgisAPI && window.mmgisAPI.map
        if (WildfireWhatIf._onCreated && leafletMap) {
            leafletMap.off('draw:created', WildfireWhatIf._onCreated)
            WildfireWhatIf._onCreated = null
        }
        if (WildfireWhatIf._drawHandler) {
            try { WildfireWhatIf._drawHandler.disable() } catch (e) {}
            WildfireWhatIf._drawHandler = null
        }
        WildfireWhatIf._drawMode = null
        $('#ww-draw-polygon-btn, #ww-draw-bbox-btn').removeClass('ww-btn-active')
        $('#ww-draw-hint').hide()
    },

    // Add a Leaflet layer to the map, replacing any previous layer stored under key.
    // interactive:false ensures map clicks pass through the overlay.
    _setLayer: function (key, rawLayer, style) {
        const leafletMap = window.mmgisAPI && window.mmgisAPI.map
        if (!leafletMap) return
        WildfireWhatIf._removeMapLayer(key)
        const L = window.L
        const lg = L.geoJSON(rawLayer.toGeoJSON(), { style, interactive: false }).addTo(leafletMap)
        WildfireWhatIf[key] = lg
    },

    _removeMapLayer: function (key) {
        const leafletMap = window.mmgisAPI && window.mmgisAPI.map
        if (WildfireWhatIf[key] && leafletMap) {
            try { leafletMap.removeLayer(WildfireWhatIf[key]) } catch (e) {}
            WildfireWhatIf[key] = null
        }
    },

    // Derive bbox from current perimeterGeoJSON with padding (degrees) and show on map.
    _deriveBboxFromPerimeter: function (padDeg) {
        padDeg = padDeg != null ? padDeg : 0.3
        const b = WildfireWhatIf._geoJSONBounds(WildfireWhatIf.perimeterGeoJSON)
        if (!b) return
        const [minLon, minLat, maxLon, maxLat] = b
        const paddedBounds = [
            [minLat - padDeg, minLon - padDeg],
            [maxLat + padDeg, maxLon + padDeg],
        ]
        const L = window.L
        const leafletMap = window.mmgisAPI && window.mmgisAPI.map
        if (!leafletMap) return
        WildfireWhatIf._removeMapLayer('_bboxLayer')
        WildfireWhatIf._removeMapLayer('_windLayer')
        WildfireWhatIf._hrrrPoints = null
        const rect = L.rectangle(paddedBounds)
        // Store a synthetic GeoJSON bbox
        WildfireWhatIf.bboxGeoJSON = rect.toGeoJSON()
        WildfireWhatIf._bboxLayer = L.geoJSON(rect.toGeoJSON(), {
            style: { color: '#4fc3f7', weight: 1, fillOpacity: 0.04, dashArray: '6,4' },
            interactive: false,
        }).addTo(leafletMap)
        WildfireWhatIf.renderBboxStatus()
    },

    clearPerimeter: function () {
        WildfireWhatIf._removeMapLayer('_perimLayer')
        WildfireWhatIf._removeMapLayer('_bboxLayer')
        WildfireWhatIf._removeMapLayer('_windLayer')
        WildfireWhatIf.perimeterGeoJSON = null
        WildfireWhatIf.bboxGeoJSON = null
        WildfireWhatIf._hrrrPoints = null
        WildfireWhatIf.renderPerimeterStatus()
        WildfireWhatIf.renderBboxStatus()
    },

    renderWindControls: function () {
        const spd = WildfireWhatIf.windSpeed_ms
        const dir = WildfireWhatIf.windDir_deg
        $('#ww-speed-slider').val(spd)
        $('#ww-speed-val').text(`${spd.toFixed(1)} m/s (${msToMph(spd)} mph)`)
        $('#ww-dir-slider').val(dir)
        $('#ww-dir-val').text(`${dir}° ${dirLabel(dir)}`)
        $('#ww-wind-arrow').css('transform', `rotate(${dir}deg)`)
        if (WildfireWhatIf.windFromHRRR)
            $('#ww-wind-source').text('Source: HRRR').show()
        else
            $('#ww-wind-source').text('Source: Manual').show()
        // Re-render map vectors whenever controls change
        if (WildfireWhatIf._hrrrPoints) WildfireWhatIf.renderWindVectors()
    },

    renderBboxStatus: function () {
        const $s = $('#ww-bbox-status')
        if (!$s.length) return
        if (WildfireWhatIf.bboxGeoJSON) {
            const b = WildfireWhatIf.bboxBounds()
            $s.removeClass('ww-status-none').addClass('ww-status-bbox')
              .text(b ? `Bbox: ${b[0].toFixed(2)}, ${b[1].toFixed(2)} → ${b[2].toFixed(2)}, ${b[3].toFixed(2)}` : 'Bbox set')
        } else {
            $s.removeClass('ww-status-bbox').addClass('ww-status-none').text('No bbox drawn')
        }
    },

    renderPerimeterStatus: function () {
        const $status = $('#ww-perimeter-status')
        if (!$status.length) return
        if (WildfireWhatIf.perimeterGeoJSON) {
            $status.removeClass('ww-status-none').addClass('ww-status-ok').text('Fire perimeter set ✓')
        } else {
            $status.removeClass('ww-status-ok').addClass('ww-status-none').text('No perimeter drawn')
        }
    },

    goToPage: function (n) {
        const total = WildfireWhatIf.jobIds.length
        const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)
        WildfireWhatIf.page = Math.max(0, Math.min(n, maxPage))
        WildfireWhatIf.renderJobs()
    },

    renderJobs: function () {
        const $list = $('#wildfireTool .ww-jobs-list')
        if ($list.length === 0) return
        $list.empty()

        if (WildfireWhatIf.jobIds.length === 0)
            WildfireWhatIf.jobIds = Object.keys(WildfireWhatIf.jobs).sort(
                (a, b) => (WildfireWhatIf.jobs[b].startedAt || 0) - (WildfireWhatIf.jobs[a].startedAt || 0)
            )

        const total = WildfireWhatIf.jobIds.length
        if (total === 0) {
            $list.append('<div class="ww-empty">No scenarios yet.</div>')
            renderPagination(0, 0, 0)
            return
        }

        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
        if (WildfireWhatIf.page >= totalPages) WildfireWhatIf.page = totalPages - 1
        const start = WildfireWhatIf.page * PAGE_SIZE
        const pageIds = WildfireWhatIf.jobIds.slice(start, start + PAGE_SIZE)

        pageIds.forEach((id) => {
            const job = WildfireWhatIf.jobs[id] || { status: 'unknown', name: id }
            const statusClass = normalizeStatus(job.status)
            const isExpanded = WildfireWhatIf.expandedIds.has(id)
            const $div = $('<div class="ww-job"></div>')
            const label = job.name || id
            const simType = (job.payload && job.payload.sim_type) || ''
            const simBadge = simType === 'smoke_dispersion'
                ? '<span class="ww-sim-badge smoke">Smoke</span>'
                : '<span class="ww-sim-badge fire">Fire Spread</span>'
            $div.append(
                `<div class="ww-job-header" data-job-id="${escapeHTML(id)}">` +
                `<span class="ww-job-chevron">${isExpanded ? '▼' : '▶'}</span> ` +
                `<span class="ww-job-name">${escapeHTML(label)}</span>` +
                simBadge +
                `<span class="ww-job-status ${escapeHTML(statusClass)}">${escapeHTML(job.status)}</span>` +
                `</div>`
            )
            if (isExpanded) {
                const $exp = $('<div class="ww-job-expanded"></div>')
                $exp.append(`<div class="ww-exp-ts">${formatLocale(new Date(job.startedAt).toISOString())}</div>`)
                if (job.payload && job.payload.wind_mods) {
                    const wm = job.payload.wind_mods
                    $exp.append(
                        `<div class="ww-exp-wind">Wind: ${wm.speed_ms} m/s from ${wm.direction_deg}° ${dirLabel(wm.direction_deg)}</div>`
                    )
                }
                if (job.result) {
                    const $pre = $('<pre class="ww-exp-json"></pre>')
                    $pre.text(JSON.stringify(job.result, null, 2))
                    $exp.append($pre)
                }
                $div.append($exp)
            }
            $list.append($div)
        })

        renderPagination(WildfireWhatIf.page, totalPages, total)
    },
}

// ─── UI construction ──────────────────────────────────────────────────────────

function interfaceWithMMGIS() {
    const tools = $('#toolPanel')
    tools.css({
        background: 'var(--color-k)',
        'box-shadow': 'inset 2px 0px 10px 0px rgba(0,0,0,0.2)',
    })
    tools.empty()
    tools.html('<div id="wildfireTool" class="mmgisScrollbar"></div>')
    const $root = $('#wildfireTool')

    // ── Header ──────────────────────────────────────────────────────────────
    $root.append('<div class="ww-header">Wildfire Scenario</div>')

    // ── Fire Perimeter ────────────────────────────────────────────────────────
    $root.append('<div class="ww-section-label">Fire Perimeter</div>')
    const $perimRow = $('<div class="ww-perim-row"></div>')
    const $polyBtn = $('<button type="button" class="ww-btn ww-btn-secondary" id="ww-draw-polygon-btn" title="Draw the fire perimeter polygon on the map">Draw Polygon</button>')
    const $uploadBtn = $('<label class="ww-btn ww-btn-secondary ww-upload-label" title="Upload a GeoJSON perimeter file">Upload GeoJSON<input type="file" accept=".geojson,application/geo+json,application/json" id="ww-upload-input" /></label>')
    const $clearPerimBtn = $('<button type="button" class="ww-btn ww-btn-ghost" id="ww-clear-perim-btn" title="Clear perimeter">✕</button>')
    $perimRow.append($polyBtn).append($uploadBtn).append($clearPerimBtn)
    $root.append($perimRow)
    $root.append('<div class="ww-draw-hint" id="ww-draw-hint" style="display:none"></div>')
    $root.append('<div class="ww-perimeter-status ww-status-none" id="ww-perimeter-status">No perimeter drawn</div>')
    $root.append('<div class="ww-bbox-status ww-status-none" id="ww-bbox-status" style="display:none"></div>')

    $polyBtn.on('click', function () { WildfireWhatIf.startMapDraw('polygon') })
    $clearPerimBtn.on('click', function () { WildfireWhatIf.clearPerimeter() })

    $('#ww-upload-input', $root).on('change', function () {
        const file = this.files && this.files[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = function (e) {
            try {
                const gj = JSON.parse(e.target.result)
                let feature
                if (gj.type === 'FeatureCollection' && gj.features && gj.features.length > 0)
                    feature = gj.features[0]
                else if (gj.type === 'Feature')
                    feature = gj
                else if (gj.type === 'Polygon' || gj.type === 'MultiPolygon')
                    feature = { type: 'Feature', geometry: gj, properties: {} }
                else
                    throw new Error('Unsupported GeoJSON type: ' + gj.type)
                WildfireWhatIf.perimeterGeoJSON = feature
                const leafletMap = window.mmgisAPI && window.mmgisAPI.map
                if (leafletMap) {
                    WildfireWhatIf._removeMapLayer('_perimLayer')
                    const L = window.L
                    WildfireWhatIf._perimLayer = L.geoJSON(feature, {
                        style: { color: '#ff6b35', weight: 2, fillOpacity: 0.12, dashArray: '5,4' },
                        interactive: false,
                    }).addTo(leafletMap)
                }
                WildfireWhatIf.renderPerimeterStatus()
                WildfireWhatIf._deriveBboxFromPerimeter()
            } catch (err) {
                window.alert('Invalid GeoJSON: ' + err.message)
            }
        }
        reader.readAsText(file)
    })

    // ── Wind ─────────────────────────────────────────────────────────────────
    $root.append('<div class="ww-section-label">Wind Conditions</div>')

    // Arrow + source badge row
    const $windHeader = $('<div class="ww-wind-header"></div>')
    const $arrowWrap = $('<div class="ww-arrow-wrap"><svg id="ww-wind-arrow" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="20" x2="12" y2="4"/><polyline points="7,9 12,4 17,9"/></svg></div>')
    const $windSource = $('<span class="ww-wind-source" id="ww-wind-source"></span>')
    $windHeader.append($arrowWrap).append($windSource)
    $root.append($windHeader)

    // Speed slider
    const $speedRow = $('<div class="ww-slider-row"></div>')
    $speedRow.append('<span class="ww-slider-label">Speed</span>')
    $speedRow.append('<input type="range" id="ww-speed-slider" min="0" max="30" step="0.1" />')
    $speedRow.append('<span class="ww-slider-val" id="ww-speed-val"></span>')
    $root.append($speedRow)

    // Direction slider
    const $dirRow = $('<div class="ww-slider-row"></div>')
    $dirRow.append('<span class="ww-slider-label">Direction</span>')
    $dirRow.append('<input type="range" id="ww-dir-slider" min="0" max="359" step="1" />')
    $dirRow.append('<span class="ww-slider-val" id="ww-dir-val"></span>')
    $root.append($dirRow)

    // HRRR fetch button
    const $hrrrBtn = $('<button type="button" class="ww-btn ww-btn-secondary ww-full" id="ww-hrrr-btn">Fetch from HRRR</button>')
    $root.append($hrrrBtn)

    // Wind vector mode toggle
    const $modeRow = $('<div class="ww-mode-row"></div>')
    const $modeLabel = $('<span class="ww-mode-label">Vector display:</span>')
    const $modeRotated = $('<label class="ww-mode-opt" title="Rotate each point\u2019s vector by the same delta as the mean \u2014 preserves spatial wind shear. More physically realistic."><input type="radio" name="ww-vec-mode" value="rotated" checked /> Rotated field</label>')
    const $modeUniform = $('<label class="ww-mode-opt" title="Every arrow points exactly the target direction \u2014 only length varies. Good for showing a uniform wind shift."><input type="radio" name="ww-vec-mode" value="uniform" /> Uniform direction</label>')
    $modeRow.append($modeLabel).append($modeRotated).append($modeUniform)
    $root.append($modeRow)
    $root.find('[name="ww-vec-mode"]').on('change', function () {
        WildfireWhatIf.windVectorMode = $(this).val()
        if (WildfireWhatIf._hrrrPoints) WildfireWhatIf.renderWindVectors()
    })

    // Wire slider events
    $root.find('#ww-speed-slider').on('input', function () {
        WildfireWhatIf.windSpeed_ms = parseFloat($(this).val())
        WildfireWhatIf.windFromHRRR = false
        WildfireWhatIf.renderWindControls()
    })
    $root.find('#ww-dir-slider').on('input', function () {
        WildfireWhatIf.windDir_deg = parseInt($(this).val(), 10)
        WildfireWhatIf.windFromHRRR = false
        WildfireWhatIf.renderWindControls()
    })
    $hrrrBtn.on('click', function () {
        WildfireWhatIf.fetchHRRRWind()
    })

    // Initial render
    WildfireWhatIf.renderWindControls()

    // ── Simulation type ───────────────────────────────────────────────────────
    $root.append('<div class="ww-section-label">Simulation Type</div>')
    const $simRow = $('<div class="ww-sim-row"></div>')
    const $fireOpt = $('<label class="ww-sim-opt"><input type="radio" name="ww-sim-type" value="fire_spread" checked /> Fire Spread Perimeter</label>')
    const $smokeOpt = $('<label class="ww-sim-opt"><input type="radio" name="ww-sim-type" value="smoke_dispersion" /> Smoke Dispersion</label>')
    $simRow.append($fireOpt).append($smokeOpt)
    $root.append($simRow)
    $root.find('[name="ww-sim-type"]').on('change', function () {
        WildfireWhatIf.simType = $(this).val()
    })

    // ── Info note ─────────────────────────────────────────────────────────────
    $root.append('<div class="ww-info-note">ⓘ Current weather data is being used in modeling.</div>')

    // ── Run name + submit ─────────────────────────────────────────────────────
    $root.append('<div class="ww-section-label">Scenario Name</div>')
    const $nameInput = $('<input type="text" id="ww-run-name" class="ww-text-input" placeholder="e.g. Palisades – SE wind shift (required)" />')
    $root.append($nameInput)
    $nameInput.on('input', function () { $(this).removeClass('ww-input-error') })

    const $genBtn = $('<button type="button" class="ww-btn ww-btn-primary ww-full" id="ww-generate-btn">Generate Forecast</button>')
    $root.append($genBtn)
    $genBtn.on('click', function () { WildfireWhatIf.submit() })

    // ── Job history ───────────────────────────────────────────────────────────
    const $jobsSection = $('<div class="ww-jobs"></div>')
    const $jobsHeader = $('<div class="ww-jobs-header"><div class="ww-section-label">Past Scenarios</div></div>')
    $jobsSection.append($jobsHeader)
    $jobsSection.append('<div class="ww-jobs-list"></div>')
    $jobsSection.append('<div class="ww-pagination"></div>')
    $root.append($jobsSection)

    $root.find('.ww-jobs-list').on('click', '.ww-job-header', function () {
        const id = $(this).attr('data-job-id')
        if (!id) return
        if (WildfireWhatIf.expandedIds.has(id)) WildfireWhatIf.expandedIds.delete(id)
        else WildfireWhatIf.expandedIds.add(id)
        WildfireWhatIf.renderJobs()
    })

    WildfireWhatIf.renderJobs()
    WildfireWhatIf.renderPerimeterStatus()

    this.separateFromMMGIS = function () {}
}

export default WildfireWhatIf

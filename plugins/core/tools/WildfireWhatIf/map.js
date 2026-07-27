// All Leaflet/map concerns for the Wildfire What-If tool: perimeter + vertex
// handles, the auto-derived HRRR bbox, wind-vector arrows, and the interactive
// perimeter-drawing session.

import { getMap, closeRing, speedColor } from './utils'

export const COLOR_PERIM = '#ff6b35'
export const COLOR_BBOX = '#08aeea' // --color-mmgis
export const COLOR_SPREAD = '#00e5ff' // mock spread prediction — cyan, clearly distinct from orange perimeter and historic data

const MAX_EDIT_VERTICES = 60 // don't spawn drag handles on huge uploaded perimeters

// ─── Scenario layers ──────────────────────────────────────────────────────────

const refs = { perimeter: null, vertices: null, bbox: null, wind: null, mockSpread: null }

function remove(key) {
    const leafletMap = getMap()
    if (refs[key] && leafletMap) {
        try {
            leafletMap.removeLayer(refs[key])
        } catch (e) {}
        refs[key] = null
    }
}

// Draws a closed [lon,lat] ring as the perimeter polygon. When `onChange` is
// given (and the ring is small enough), draggable vertex handles are added:
// drag to reshape, right-click to delete. onChange receives the new closed ring.
export function showPerimeter(closedRing, { onChange } = {}) {
    const leafletMap = getMap()
    if (!leafletMap) return
    const L = window.L
    remove('perimeter')
    remove('vertices')
    const latlngs = closedRing.slice(0, -1).map(([lon, lat]) => [lat, lon])
    refs.perimeter = L.polygon(latlngs, {
        color: COLOR_PERIM,
        weight: 2,
        fillColor: COLOR_PERIM,
        fillOpacity: 0.1,
        interactive: false,
    }).addTo(leafletMap)
    if (onChange && latlngs.length <= MAX_EDIT_VERTICES)
        addVertexHandles(latlngs, onChange)
}

function addVertexHandles(latlngs, onChange) {
    const leafletMap = getMap()
    const L = window.L
    const commit = () =>
        onChange(closeRing(latlngs.map((ll) => [ll[1], ll[0]])))
    const markers = latlngs.map((ll, i) => {
        const m = L.marker(ll, {
            draggable: true,
            icon: L.divIcon({
                html: '<div class="ww-vertex-dot"></div>',
                className: 'ww-vertex',
                iconSize: [12, 12],
                iconAnchor: [6, 6],
            }),
        })
        m.on('drag', function () {
            const p = m.getLatLng()
            latlngs[i] = [p.lat, p.lng]
            if (refs.perimeter) refs.perimeter.setLatLngs(latlngs)
        })
        m.on('dragend', commit)
        m.on('contextmenu', function (e) {
            if (e.originalEvent) e.originalEvent.preventDefault()
            if (latlngs.length <= 3) return
            latlngs.splice(i, 1)
            commit()
        })
        return m
    })
    refs.vertices = L.layerGroup(markers).addTo(leafletMap)
}

// bounds: [[latMin, lonMin], [latMax, lonMax]]
export function showBbox(bounds) {
    const leafletMap = getMap()
    if (!leafletMap) return
    remove('bbox')
    refs.bbox = window.L.rectangle(bounds, {
        color: COLOR_BBOX,
        weight: 1.5,
        dashArray: '6,4',
        fillColor: COLOR_BBOX,
        fillOpacity: 0.03,
        interactive: false,
    }).addTo(leafletMap)
}

export function removeWindVectors() {
    remove('wind')
}

export function showMockSpread(ring) {
    const leafletMap = getMap()
    if (!leafletMap) return
    remove('mockSpread')
    const latlngs = ring.map(([lon, lat]) => [lat, lon])
    refs.mockSpread = window.L.polygon(latlngs, {
        color: COLOR_SPREAD,
        weight: 2,
        dashArray: '6,4',
        fillColor: COLOR_SPREAD,
        fillOpacity: 0.18,
        interactive: false,
    }).addTo(leafletMap)
}

export function removeMockSpread() {
    remove('mockSpread')
}

export function clearScenarioLayers() {
    remove('perimeter')
    remove('vertices')
    remove('bbox')
    remove('wind')
    remove('mockSpread')
}

// ─── Wind vectors ─────────────────────────────────────────────────────────────
// The HRRR field is rotated/scaled so its mean matches the edited target —
// preserving terrain-induced spatial variation in both speed and direction.

export function showWindVectors(points, base, target) {
    const leafletMap = getMap()
    if (!leafletMap) return
    const L = window.L
    remove('wind')

    const baseMathAng = (Math.PI / 180) * (270 - base.direction_deg)
    const targetMathAng = (Math.PI / 180) * (270 - target.direction_deg)
    const deltaAng = targetMathAng - baseMathAng
    const speedScale = target.speed_ms / (base.speed_ms || 1)

    const markers = points.map((pt) => {
        const localSpeed = Math.sqrt(pt.u * pt.u + pt.v * pt.v)
        const localAng = Math.atan2(pt.v, pt.u)
        const speed = localSpeed * speedScale
        const ang = localAng + deltaAng
        const u = speed * Math.cos(ang)
        const v = speed * Math.sin(ang)

        const color = speedColor(speed)
        const len = Math.max(10, Math.min(32, 8 + speed * 1.6))
        const half = len / 2
        const box = len + 12
        const angDeg = (Math.atan2(-v, u) * 180) / Math.PI
        const arrow = `M ${-half} 0 H ${half} M ${half} 0 L ${half - 6} -3.6 M ${half} 0 L ${half - 6} 3.6`
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="${-box / 2} ${-box / 2} ${box} ${box}" style="overflow:visible">` +
            `<g transform="rotate(${angDeg})" stroke-linecap="round" stroke-linejoin="round" fill="none">` +
            // dark halo for contrast on any basemap
            `<path d="${arrow}" stroke="rgba(10,14,20,0.85)" stroke-width="4"/>` +
            `<path d="${arrow}" stroke="${color}" stroke-width="1.8"/>` +
            `</g></svg>`
        return L.marker([pt.lat, pt.lon], {
            icon: L.divIcon({
                html: svg,
                className: 'ww-wind-arrow-icon',
                iconSize: [box, box],
                iconAnchor: [box / 2, box / 2],
            }),
            interactive: false,
        })
    })
    refs.wind = L.layerGroup(markers).addTo(leafletMap)
}

// ─── Interactive perimeter drawing ────────────────────────────────────────────
// Click to add vertices · mousemove for live preview · double-click / Enter /
// click-first-vertex to close · Backspace undoes · Escape cancels.

// Starts a session and returns { finish, cancel }. `onDone(ring|null)` is
// called exactly once — with a closed [lon,lat] ring, or null on cancel.
export function startDrawSession(leafletMap, { onDone }) {
    const L = window.L
    const container = leafletMap.getContainer()
    const hadDblClickZoom = leafletMap.doubleClickZoom.enabled()
    leafletMap.doubleClickZoom.disable()
    container.style.cursor = 'crosshair'

    const pts = [] // committed latlngs
    const committed = L.polyline([], { color: COLOR_PERIM, weight: 2 }).addTo(leafletMap)
    const preview = L.polygon([], {
        color: COLOR_PERIM,
        weight: 1,
        dashArray: '4,6',
        fillColor: COLOR_PERIM,
        fillOpacity: 0.06,
        interactive: false,
    }).addTo(leafletMap)
    const handles = L.layerGroup([]).addTo(leafletMap)
    let done = false

    function refresh(cursorLL) {
        committed.setLatLngs(pts)
        const all = cursorLL ? pts.concat([cursorLL]) : pts
        preview.setLatLngs(all.length >= 2 ? all : [])
    }

    function addHandle(ll, isFirst) {
        handles.addLayer(
            L.circleMarker(ll, {
                radius: isFirst ? 6 : 4,
                color: '#fff',
                weight: 1.5,
                fillColor: COLOR_PERIM,
                fillOpacity: 1,
            })
        )
    }

    function teardown() {
        leafletMap.off('click', onClick)
        leafletMap.off('mousemove', onMove)
        leafletMap.off('dblclick', onDblClick)
        try {
            leafletMap.removeLayer(committed)
            leafletMap.removeLayer(preview)
            leafletMap.removeLayer(handles)
        } catch (e) {}
        if (hadDblClickZoom) leafletMap.doubleClickZoom.enable()
        container.style.cursor = ''
        document.removeEventListener('keydown', onKey)
    }

    function end(ring) {
        if (done) return
        done = true
        teardown()
        onDone(ring)
    }

    function finish() {
        if (pts.length < 3) {
            end(null)
            return
        }
        end(closeRing(pts.map((ll) => [ll.lng, ll.lat])))
    }

    function cancel() {
        end(null)
    }

    function onClick(e) {
        // Close if clicking near the first vertex
        if (pts.length >= 3) {
            const p0 = leafletMap.latLngToContainerPoint(pts[0])
            if (e.containerPoint.distanceTo(p0) < 12) {
                finish()
                return
            }
        }
        // Ignore near-duplicate clicks (also swallows the pre-dblclick click)
        if (pts.length > 0) {
            const pl = leafletMap.latLngToContainerPoint(pts[pts.length - 1])
            if (e.containerPoint.distanceTo(pl) < 5) return
        }
        pts.push(e.latlng)
        addHandle(e.latlng, pts.length === 1)
        refresh()
    }

    function onMove(e) {
        refresh(e.latlng)
    }

    function onDblClick(e) {
        window.L.DomEvent.stop(e)
        finish()
    }

    function onKey(e) {
        if (e.key === 'Escape') cancel()
        else if (e.key === 'Enter') finish()
        else if (e.key === 'Backspace' || e.key === 'Delete') {
            e.preventDefault()
            pts.pop()
            handles.clearLayers()
            pts.forEach((ll, i) => addHandle(ll, i === 0))
            refresh()
        }
    }

    leafletMap.on('click', onClick)
    leafletMap.on('mousemove', onMove)
    leafletMap.on('dblclick', onDblClick)
    document.addEventListener('keydown', onKey)

    return { finish, cancel }
}

// Mirrors the Wildfire What-If tool's map layers onto the 3D globe, so the
// scenario reads the same in both views. map.js hands over GeoJSON for each
// part as it draws it on the map; everything is drawn as one terrain-draped
// layer, re-sent (batched) whenever a part changes.
//
// Shapes are outlines except the forecast fill: the globe hands a click that
// lands on any drawn shape to that shape's layer, so a filled perimeter or
// box would swallow clicks meant for the fire layer underneath.

import * as Cesium from 'cesium'
import L_ from '@basics/Layers_/Layers_'
import Globe_ from '@basics/Globe_/Globe_'

const LAYER = '_wildfireWhatIf'
const SYNC_MS = 120 // batches bursts (wind slider drags) into one globe update

// Drawn bottom to top
const ORDER = ['spread', 'bbox', 'perimeter', 'dozer', 'wind']
const parts = { spread: [], bbox: [], perimeter: [], dozer: [], wind: [] }
let timer = null

function globe() {
    return L_.hasGlobe && Globe_.litho ? Globe_.litho : null
}

export function setGlobePart(key, features) {
    parts[key] = features || []
    schedule()
}

export function clearGlobe() {
    ORDER.forEach((k) => (parts[k] = []))
    schedule()
}

function schedule() {
    if (timer) return
    timer = setTimeout(() => {
        timer = null
        sync()
    }, SYNC_MS)
}

function sync() {
    const g = globe()
    if (!g) return
    const features = ORDER.reduce((all, k) => all.concat(parts[k]), [])
    try {
        if (g.hasLayer(LAYER)) g.removeLayer(LAYER)
        if (features.length === 0) return
        Promise.resolve(
            g.addLayer('clamped', {
                name: LAYER,
                id: LAYER,
                on: true,
                opacity: 1,
                order: 10,
                minZoom: 0,
                maxZoom: 30,
                geojson: { type: 'FeatureCollection', features },
                style: {
                    letPropertiesStyleOverride: true,
                    // The spread is the only polygon; draped polygon outlines
                    // take the layer default, so it matches the spread.
                    default: {
                        color: '#d32f2f',
                        weight: 2,
                        fillColor: '#d32f2f',
                        fillOpacity: 0.28,
                    },
                },
            })
        ).catch(() => {})
    } catch (e) {}
}

// Move the globe camera over bounds ([[latMin, lonMin], [latMax, lonMax]]):
// framed to fit on Cesium, at the 2D map's zoom.
export function centerGlobeOn(bounds, zoom, framing = {}) {
    const g = globe()
    if (!g || !bounds) return
    try {
        const camera = g.rendererType !== 'lithosphere' && g.renderer?.camera
        if (camera) {
            camera.setView({
                destination: visibleFrameRectangle(
                    bounds,
                    g.renderer.container,
                    framing
                ),
                orientation: {
                    heading: camera.heading,
                    pitch: -Cesium.Math.PI_OVER_TWO,
                    roll: 0,
                },
            })
            return
        }
        if (typeof g.setCenter !== 'function') return
        g.setCenter({
            lat: (bounds[0][0] + bounds[1][0]) / 2,
            lng: (bounds[0][1] + bounds[1][1]) / 2,
            zoom,
        })
    } catch (e) {}
}

const METERS_PER_DEGREE = 111320

function visibleFrameRectangle(bounds, container, framing) {
    const [[south, west], [north, east]] = bounds
    const containerRect = container?.getBoundingClientRect()
    if (
        !containerRect ||
        !containerRect.width ||
        !containerRect.height ||
        typeof framing.coveredEdgesOf !== 'function'
    )
        return Cesium.Rectangle.fromDegrees(west, south, east, north)

    const pad = framing.pad ?? 0
    const edges = framing.coveredEdgesOf(container)
    const left = edges.left + pad
    const right = edges.right + pad
    const top = edges.top + pad
    const bottom = edges.bottom + pad
    const visibleWidth = Math.max(1, containerRect.width - left - right)
    const visibleHeight = Math.max(1, containerRect.height - top - bottom)

    const centerLat = (south + north) / 2
    const centerLon = (west + east) / 2
    const metersPerLonDegree =
        METERS_PER_DEGREE * Math.cos((centerLat * Math.PI) / 180)
    const metersPerPixel = Math.max(
        ((east - west) * metersPerLonDegree) / visibleWidth,
        ((north - south) * METERS_PER_DEGREE) / visibleHeight
    )
    const lonPerPixel = metersPerPixel / metersPerLonDegree
    const latPerPixel = metersPerPixel / METERS_PER_DEGREE

    const frameWest = centerLon - lonPerPixel * (left + visibleWidth / 2)
    const frameNorth = centerLat + latPerPixel * (top + visibleHeight / 2)
    return Cesium.Rectangle.fromDegrees(
        frameWest,
        frameNorth - latPerPixel * containerRect.height,
        frameWest + lonPerPixel * containerRect.width,
        frameNorth
    )
}

// ─── Feature builders ─────────────────────────────────────────────────────────

const styled = (geometry, style) => ({
    type: 'Feature',
    properties: { style },
    geometry,
})

// The globe drapes a line over terrain by sampling it only every ~10 km and
// joining those samples straight, so long edges come out kinked. Points every
// 1 km keep them smooth — and a box edge stays on its parallel/meridian,
// matching the map, instead of a great-circle arc.
const DENSIFY_KM = 1
const MAX_POINTS_PER_SEGMENT = 400

function densifyLine(coords) {
    const out = []
    for (let i = 0; i < coords.length - 1; i++) {
        const [x0, y0] = coords[i]
        const [x1, y1] = coords[i + 1]
        const kx = 111.32 * Math.cos((((y0 + y1) / 2) * Math.PI) / 180)
        const km = Math.hypot((x1 - x0) * kx, (y1 - y0) * 111.32)
        const n = Math.min(
            MAX_POINTS_PER_SEGMENT,
            Math.max(1, Math.ceil(km / DENSIFY_KM))
        )
        for (let j = 0; j < n; j++)
            out.push([x0 + ((x1 - x0) * j) / n, y0 + ((y1 - y0) * j) / n])
    }
    if (coords.length) out.push(coords[coords.length - 1])
    return out
}

export function lineFeature(coords, color, weight) {
    return styled(
        { type: 'LineString', coordinates: densifyLine(coords) },
        { color, weight }
    )
}

// bounds: [[latMin, lonMin], [latMax, lonMax]]
export function boxFeature(bounds, color) {
    const [[s, w], [n, e]] = bounds
    return lineFeature(
        [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
        ],
        color,
        2
    )
}

export function spreadFeature(spreadRing, perimRing, color) {
    const close = (r) =>
        r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]
            ? r
            : r.concat([r[0]])
    const rings = [close(spreadRing)]
    if (perimRing) rings.push(close(perimRing))
    return styled(
        { type: 'Polygon', coordinates: rings },
        { color, weight: 2, fillColor: color, fillOpacity: 0.28 }
    )
}

// One arrow per wind point, sized to the grid spacing so neighbours don't
// overlap. arrows: [{lon, lat, u, v, speed, color}] (u east, v north, m/s)
export function windFeatures(arrows) {
    if (!arrows.length) return []
    let latMin = Infinity
    let latMax = -Infinity
    let lonMin = Infinity
    let lonMax = -Infinity
    arrows.forEach((a) => {
        latMin = Math.min(latMin, a.lat)
        latMax = Math.max(latMax, a.lat)
        lonMin = Math.min(lonMin, a.lon)
        lonMax = Math.max(lonMax, a.lon)
    })
    const midLat = (latMin + latMax) / 2
    const kx = 111.32 * Math.cos((midLat * Math.PI) / 180)
    const areaKm2 = Math.max(1, (latMax - latMin) * 111.32 * (lonMax - lonMin) * kx)
    const spacingKm = Math.sqrt(areaKm2 / arrows.length)

    return arrows.map((a) => {
        const speed = a.speed || 0
        const lenKm = spacingKm * 0.75 * Math.min(1, Math.max(0.35, 0.35 + speed / 20))
        const ux = speed > 0 ? a.u / speed : 0
        const uy = speed > 0 ? a.v / speed : 0
        const toDeg = (dxKm, dyKm) => [
            dxKm / (111.32 * Math.cos((a.lat * Math.PI) / 180)),
            dyKm / 111.32,
        ]
        const [hx, hy] = toDeg((ux * lenKm) / 2, (uy * lenKm) / 2)
        const tail = [a.lon - hx, a.lat - hy]
        const tip = [a.lon + hx, a.lat + hy]
        const head = (sign) => {
            const ang = Math.atan2(uy, ux) + Math.PI + sign * 0.45
            const [dx, dy] = toDeg(Math.cos(ang) * lenKm * 0.3, Math.sin(ang) * lenKm * 0.3)
            return [tip[0] + dx, tip[1] + dy]
        }
        return styled(
            {
                type: 'MultiLineString',
                coordinates: [
                    [tail, tip],
                    [tip, head(1)],
                    [tip, head(-1)],
                ],
            },
            { color: a.color, weight: 2 }
        )
    })
}

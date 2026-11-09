// Drawing the open fire on the map: the input layers (bottom), the forecast's
// see-through fill, the ground truth's edge, the authored wind's arrows, the run's
// dozer lines and the spot marker; and framing the map on the fire beside the tool.
// The forecast is drawn as an arrival-time map: every cell burned by the current
// step, colored by when it burned.
import * as map from '../map'
import { getMap, coveredEdges } from '../utils'
import { S, STEPS, session, setRedraw, activeResult } from './session'
import { START_RGBA, OBSERVED_RGBA, stepColor, hexRgb, rampColor } from './colors'
import { decode, fieldOf, fireBounds } from './grids'
import { inputEntry, needLayer, inputOpacity } from './layers'
import { updateFlow, removeFlow } from './flow'
import { draftWind } from './wind'

let overlays = null // L.layerGroup of the fire's overlays

function canvasSized(cols, rows, paint) {
    const c = document.createElement('canvas')
    c.width = cols
    c.height = rows
    const ctx = c.getContext('2d')
    const img = ctx.createImageData(cols, rows)
    paint(img.data)
    ctx.putImageData(img, 0, 0)
    return c.toDataURL()
}

function canvasOf(res, paint) {
    return canvasSized(res.grid.cols, res.grid.rows, paint)
}

function forecastImage(res, step) {
    const f = fieldOf(res, 'arrival')
    const colors = Array.from({ length: STEPS + 1 }, (_, k) => stepColor(k))
    return canvasSized(f.cols, f.rows, (px) => {
        const a_ = f.codes
        for (let i = 0; i < a_.length; i++) {
            const a = a_[i]
            if (a === 0) continue
            const o = i * 4
            if (a === 255) {
                px[o] = START_RGBA[0]
                px[o + 1] = START_RGBA[1]
                px[o + 2] = START_RGBA[2]
                px[o + 3] = START_RGBA[3]
            } else if (a <= step) {
                const c = colors[a]
                px[o] = c[0]
                px[o + 1] = c[1]
                px[o + 2] = c[2]
                px[o + 3] = 255
            }
        }
    })
}

// The ground truth's edge at `step`: burned pixels with an unburned pixel within
// `width` (one cell's edge on the cells; half a cell's on the smoothed field)
function observedImage(res, step) {
    const f = fieldOf(res, 'observed')
    const { rows, cols, codes } = f
    const width = f.up > 1 ? 2 : 1
    const burned = (r, c) => {
        if (r < 0 || c < 0 || r >= rows || c >= cols) return false
        const v = codes[r * cols + c]
        return v === 255 || (v > 0 && v <= Math.max(step, 0))
    }
    return canvasSized(cols, rows, (px) => {
        for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++) {
                if (!burned(r, c)) continue
                let edge = false
                for (let d = 1; d <= width && !edge; d++)
                    edge = !burned(r - d, c) || !burned(r + d, c) || !burned(r, c - d) || !burned(r, c + d)
                if (!edge) continue
                const o = (r * cols + c) * 4
                px[o] = OBSERVED_RGBA[0]
                px[o + 1] = OBSERVED_RGBA[1]
                px[o + 2] = OBSERVED_RGBA[2]
                px[o + 3] = OBSERVED_RGBA[3]
            }
    })
}

// The inputs of the step that ends at `step` (the start's inputs at step 0)
function inputImage(res, data, entry, step) {
    const k = Math.min(Math.max(step, 1), data.steps.length) - 1
    if (!data._dec) data._dec = []
    const n = res.grid.rows * res.grid.cols
    if (!data._dec[k]) data._dec[k] = decode(data.steps[k], n)
    const v = data._dec[k]
    const lut = entry.cats
        ? [null, ...entry.colors.map(hexRgb)]
        : Array.from({ length: 256 }, (_, i) => (i === 0 ? null : rampColor(entry.ramp, (i - 1) / 254)))
    return canvasOf(res, (px) => {
        for (let i = 0; i < v.length; i++) {
            const c = lut[v[i]]
            if (!c) continue
            const o = i * 4
            px[o] = c[0]
            px[o + 1] = c[1]
            px[o + 2] = c[2]
            px[o + 3] = 255
        }
    })
}

// Wind arrows pointing where the wind blows, sized by speed (the setup view's
// HRRR arrow shape, in white so they read over the fire's colors)
const DRAFT_ARROW = '#ffdd5c' // the Wind card's arrow color

function windArrows(points, color = '#ffffff') {
    const L = window.L
    return (points || []).map(([lat, lon, u, v]) => {
        const speed = Math.sqrt(u * u + v * v)
        const len = Math.max(10, Math.min(32, 8 + speed * 1.6))
        const half = len / 2
        const box = len + 12
        const angDeg = (Math.atan2(-v, u) * 180) / Math.PI
        const arrow = `M ${-half} 0 H ${half} M ${half} 0 L ${half - 6} -3.6 M ${half} 0 L ${half - 6} 3.6`
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="${-box / 2} ${-box / 2} ${box} ${box}" style="overflow:visible">` +
            `<g transform="rotate(${angDeg})" stroke-linecap="round" stroke-linejoin="round" fill="none">` +
            `<path d="${arrow}" stroke="rgba(10,14,20,0.85)" stroke-width="4"/>` +
            `<path d="${arrow}" stroke="${color}" stroke-width="1.8"/>` +
            `</g></svg>`
        return L.marker([lat, lon], {
            icon: L.divIcon({ html: svg, className: 'ww-wind-arrow-icon', iconSize: [box, box], iconAnchor: [box / 2, box / 2] }),
            interactive: false,
        })
    })
}

export function removeDemoLayers() {
    const leafletMap = getMap()
    if (overlays && leafletMap) {
        try {
            leafletMap.removeLayer(overlays)
        } catch (e) {}
    }
    overlays = null
}

export function drawDemo({ fit } = {}) {
    const leafletMap = getMap()
    const res = activeResult()
    removeDemoLayers()
    if (session.hidden) return removeFlow() // the tool is closed; its redraw hook draws again on open
    if (!leafletMap || !res) return
    const L = window.L
    const s = S.getState()
    const g = res.grid
    const bounds = [
        [g.south, g.west],
        [g.north, g.east],
    ]
    overlays = L.layerGroup()
    // the list's top draws on top: drawn from the bottom of the list up
    ;[...s.addedInputKeys]
        .reverse()
        .filter((key) => s.visibleInputs.includes(key))
        .forEach((key) => {
            const entry = inputEntry(key)
            const data = entry && needLayer(key)
            if (data)
                L.imageOverlay(inputImage(res, data, entry, s.demoStep), bounds, {
                    className: 'ww-raster',
                    interactive: false,
                    opacity: inputOpacity(key),
                }).addTo(overlays)
        })
    // The forecast stays in sight over any input layer: its see-through fill, unless hidden
    if (s.showForecast)
        L.imageOverlay(forecastImage(res, s.demoStep), bounds, {
            className: 'ww-raster',
            interactive: false,
            opacity: s.fireOpacity,
        }).addTo(overlays)
    if (s.showObserved)
        L.imageOverlay(observedImage(res, s.demoStep), bounds, {
            className: 'ww-raster',
            interactive: false,
        }).addTo(overlays)
    if (s.windEditOpen) { // the yellow arrows: only while the Wind card's Modify is open
        // Authoring a what-if: the real wind at the shown step, scaled and turned the way the
        // what-if will be (the Wind card's Modify), drawn as the card's yellow arrows
        const real = needLayer('wind', { scale: 1, turn: 0 })
        if (real && real.arrows) {
            const d = draftWind()
            const pts = real.arrows[Math.min(Math.max(s.demoStep, 1), real.arrows.length) - 1].map(([lat, lon, u, v]) => {
                const t = (d.turn * Math.PI) / 180 // clockwise on the compass
                return [lat, lon, d.scale * (u * Math.cos(t) + v * Math.sin(t)), d.scale * (-u * Math.sin(t) + v * Math.cos(t))]
            })
            windArrows(pts, DRAFT_ARROW).forEach((m) => m.addTo(overlays))
        }
    }
    // The lines this run was made with (the draft's lines are drawn by map.js)
    ;(res.lines || []).forEach((coords) =>
        L.polyline(
            coords.map(([lon, lat]) => [lat, lon]),
            { color: '#111', weight: 4, opacity: 0.95, interactive: false }
        ).addTo(overlays)
    )
    if (s.probe)
        L.circleMarker([s.probe.lat, s.probe.lon], {
            radius: 6,
            color: '#ffffff',
            weight: 2,
            fillColor: '#0288d1',
            fillOpacity: 1,
            interactive: false,
        }).addTo(overlays)
    overlays.addTo(leafletMap)
    if (s.dozerLines.length) map.showDozerLines(s.dozerLines)
    updateFlow()
    if (fit) focusFire()
}

// ─── Bring the fire to the tool ───────────────────────────────────────────────
// The tool is fixed at the map's top right and never moves with the map. Opening a fire (and the
// "Center on the fire" button) frames the fire's six days in the map area left of the tool and of
// any open side panel, with its right edge close to the tool.
const TOOL_W = 296
const SIDE_COL_W = 300
const TOOL_GAP = 28

export function focusFire() {
    const m = getMap()
    const res = activeResult()
    if (!m || !res) return
    const s = S.getState()
    const f = fireBounds(res)
    const padLat = (f.north - f.south) * 0.12
    const padLon = (f.east - f.west) * 0.12
    const b = window.L.latLngBounds([f.south - padLat, f.west - padLon], [f.north + padLat, f.east + padLon])
    m.invalidateSize({ pan: false })
    const e = coveredEdges(m.getContainer())
    const size = m.getSize()
    const side = s.sidePanels && (s.sidePanels.area || s.sidePanels.whatif) ? SIDE_COL_W : 0
    const toolLeft = size.x - e.right - 56 - TOOL_W - side // in map pixels
    const room = { l: e.left + 40, t: e.top + 40, r: toolLeft - TOOL_GAP, b: size.y - e.bottom - 40 }
    const zoom = Math.min(
        m.getBoundsZoom(b, false, window.L.point(size.x - (room.r - room.l), size.y - (room.b - room.t))),
        m.getMaxZoom() || 18
    )
    // the fire's centre placed so its right edge sits just left of the tool, vertically in the room
    const nw = m.project(b.getNorthWest(), zoom)
    const se = m.project(b.getSouthEast(), zoom)
    const fireW = se.x - nw.x
    const centerScreen = window.L.point(room.r - fireW / 2, (room.t + room.b) / 2)
    const fireCenter = nw.add(se).divideBy(2)
    const mapCenter = fireCenter.add(size.divideBy(2)).subtract(centerScreen)
    m.setView(m.unproject(mapCenter, zoom), zoom, { animate: true })
}

setRedraw(drawDemo)

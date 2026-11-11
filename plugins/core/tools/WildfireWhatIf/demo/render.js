// Drawing the open fire on the map: the input layers (bottom), the forecast's
// see-through fill, the ground truth's edge, the run's dozer lines and the spot marker
// (the wind, the run's or the one being authored, is flow.js's moving streaks); and framing
// the map on the fire beside the tool.
// The forecast is drawn as an arrival-time map: every cell burned by the current
// step, colored by when it burned.
import * as map from '../map'
import { getMap, coveredEdges } from '../utils'
import { S, STEPS, session, setRedraw, activeResult, baselineOf } from './session'
import { START_RGBA, OBSERVED_RGBA, BASELINE_RGBA, stepColor, hexRgb, rampColor } from './colors'
import { decode, fieldOf, fireBounds } from './grids'
import { inputEntry, needLayer, inputOpacity, layerCacheKey } from './layers'
import { updateFlow, removeFlow } from './flow'

let overlays = null // L.layerGroup of the fire's overlays
// The raster overlays (input layers, forecast fill, ground truth edge), bottom first. They stay on the
// map from one redraw to the next: a redraw gives an image a new picture only when its content changed
// (the browser keeps showing the old picture until the new one has loaded), so stepping through the
// forecast neither blanks the map nor redraws a layer that does not change (fuel type, terrain).
let rasters = [] // [{id, sig, layer}]
const resIds = new WeakMap() // run -> a number that tells runs apart in a raster's signature
let nextResId = 1
function resId(res) {
    if (!resIds.has(res)) resIds.set(res, nextResId++)
    return resIds.get(res)
}

function removeRasters(leafletMap) {
    rasters.forEach((r) => {
        try {
            leafletMap.removeLayer(r.layer)
        } catch (e) {}
    })
    rasters = []
}

// wanted: [{id, sig, url: () => data URL, opacity}], bottom first
function syncRasters(wanted, bounds, leafletMap) {
    const L = window.L
    const sameStack = rasters.length === wanted.length && rasters.every((r, i) => r.id === wanted[i].id)
    if (!sameStack) {
        // a layer was added, removed or reordered: draw the stack afresh, in order
        removeRasters(leafletMap)
        rasters = wanted.map((w) => ({
            id: w.id,
            sig: w.sig,
            layer: L.imageOverlay(w.url(), bounds, { className: 'ww-raster', interactive: false, opacity: w.opacity }).addTo(
                leafletMap
            ),
        }))
        return
    }
    wanted.forEach((w, i) => {
        const r = rasters[i]
        if (r.sig !== w.sig) {
            r.layer.setBounds(bounds)
            r.layer.setUrl(w.url())
            r.sig = w.sig
        }
        r.layer.setOpacity(w.opacity)
    })
}

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

// The edge at `step` of a burned-by-step field (fieldOf): burned pixels with an unburned pixel within
// `width` (one cell's edge on the cells; half a cell's on the smoothed field), in `rgba`
function edgeImage(f, step, rgba) {
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
                px[o] = rgba[0]
                px[o + 1] = rgba[1]
                px[o + 2] = rgba[2]
                px[o + 3] = rgba[3]
            }
    })
}

// The ground truth's edge at `step`
function observedImage(res, step) {
    return edgeImage(fieldOf(res, 'observed', S.getState().truthSource), step, OBSERVED_RGBA)
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

export function removeDemoLayers() {
    const leafletMap = getMap()
    if (leafletMap) removeRasters(leafletMap)
    removeVectors()
}

// The redrawn-every-time part: the run's lines and the spot marker
function removeVectors() {
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
    if (session.hidden || !leafletMap || !res) removeDemoLayers()
    if (session.hidden) return removeFlow() // the tool is closed; its redraw hook draws again on open
    if (!leafletMap || !res) return
    removeVectors()
    const L = window.L
    const s = S.getState()
    const g = res.grid
    const bounds = [
        [g.south, g.west],
        [g.north, g.east],
    ]
    overlays = L.layerGroup()
    const wanted = []
    // the list's top draws on top: drawn from the bottom of the list up
    ;[...s.addedInputKeys]
        .reverse()
        .filter((key) => s.visibleInputs.includes(key))
        .forEach((key) => {
            const entry = inputEntry(key)
            const data = entry && needLayer(key)
            if (!data) return
            const frame = Math.min(Math.max(s.demoStep, 1), data.steps.length) - 1 // a fixed layer has one frame
            wanted.push({
                id: `input:${key}`,
                sig: `${layerCacheKey(key)}|${frame}`,
                url: () => inputImage(res, data, entry, s.demoStep),
                opacity: inputOpacity(key),
            })
        })
    // The forecast stays in sight over any input layer: its see-through fill, unless hidden
    if (s.showForecast)
        wanted.push({
            id: 'forecast',
            sig: `${resId(res)}|${s.demoStep}`,
            url: () => forecastImage(res, s.demoStep),
            opacity: s.fireOpacity,
        })
    // The ground truth's edge stays under a what-if too, as an outline only (its acres are not set
    // against a what-if: that wind or those lines never happened)
    if (s.showObserved)
        wanted.push({
            id: 'observed',
            sig: `${resId(res)}|${s.demoStep}|${s.truthSource}`,
            url: () => observedImage(res, s.demoStep),
            opacity: 1,
        })
    // Under a what-if: the model forecast's edge at the same step, so the difference the changed wind or
    // the drawn lines make is what the eye sees
    const base = baselineOf(s)
    if (base && s.showBaseline)
        wanted.push({
            id: 'baseline',
            sig: `${resId(base)}|${s.demoStep}`,
            url: () => edgeImage(fieldOf(base, 'arrival'), s.demoStep, BASELINE_RGBA),
            opacity: 1,
        })
    syncRasters(wanted, bounds, leafletMap)
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

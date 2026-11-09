// A forecast's grids: decoding the server's base64 cell grids, the display-only
// edge smoothing, and the fire's own extent (what the tool frames on the map).
import { STEPS } from './session'

const grids = new WeakMap() // result -> decoded grids

export function decode(b64, n) {
    const bin = atob(b64)
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i)
    return out
}

export function gridsOf(res) {
    let g = grids.get(res)
    if (!g) {
        const n = res.grid.rows * res.grid.cols
        g = { arrival: decode(res.arrival, n), observed: decode(res.observed, n) }
        grids.set(res, g)
    }
    return g
}

// ─── Smooth edges (display only) ──────────────────────────────────────────────
// The model forecasts ~300 m cells; drawn as they are, every edge is a staircase.
// So each step's burned area is blurred by about one cell, read
// at SMOOTH_UP x the resolution and kept where the blur is at least half: the same
// fire with rounded edges (the area hardly changes; one-cell spikes and pinholes
// round off; a narrow finger keeps a rounded core inside its own cells). The
// cells, the acres and the scores stay the model's.

const SMOOTH_UP = 4
const BLUR = [0.054, 0.244, 0.403, 0.244, 0.054] // a Gaussian of one cell

// codes: 255 burning at the start, k first burned in step k, 0 never
function smoothCodes(codes, rows, cols) {
    const n = rows * cols
    const lv = new Uint8Array(n)
    let maxL = 0
    for (let i = 0; i < n; i++) {
        const a = codes[i]
        lv[i] = a === 255 ? 0 : a === 0 ? 99 : a
        if (lv[i] < 99 && lv[i] > maxL) maxL = lv[i]
    }
    const R = rows * SMOOTH_UP
    const C = cols * SMOOTH_UP
    const out = new Uint8Array(R * C)
    const m = new Float32Array(n)
    const tmp = new Float32Array(n)
    const b = new Float32Array(n)
    const clampI = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v)
    for (let L = 0; L <= maxL; L++) {
        let any = false
        for (let i = 0; i < n; i++) {
            m[i] = lv[i] <= L ? 1 : 0
            if (m[i]) any = true
        }
        if (!any) continue
        for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++) {
                let v = 0
                for (let k = -2; k <= 2; k++) v += BLUR[k + 2] * m[r * cols + clampI(c + k, cols - 1)]
                tmp[r * cols + c] = v
            }
        for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++) {
                let v = 0
                for (let k = -2; k <= 2; k++) v += BLUR[k + 2] * tmp[clampI(r + k, rows - 1) * cols + c]
                b[r * cols + c] = v
            }
        const code = L === 0 ? 255 : L
        for (let y = 0; y < R; y++) {
            const fy = (y + 0.5) / SMOOTH_UP - 0.5
            const y0 = clampI(Math.floor(fy), rows - 1)
            const y1 = clampI(y0 + 1, rows - 1)
            const wy = Math.min(Math.max(fy - y0, 0), 1)
            const cellR = clampI(Math.floor(y / SMOOTH_UP), rows - 1)
            for (let x = 0; x < C; x++) {
                const p = y * C + x
                if (out[p]) continue
                const fx = (x + 0.5) / SMOOTH_UP - 0.5
                const x0 = clampI(Math.floor(fx), cols - 1)
                const x1 = clampI(x0 + 1, cols - 1)
                const wx = Math.min(Math.max(fx - x0, 0), 1)
                const v =
                    (1 - wy) * ((1 - wx) * b[y0 * cols + x0] + wx * b[y0 * cols + x1]) +
                    wy * ((1 - wx) * b[y1 * cols + x0] + wx * b[y1 * cols + x1])
                const own = m[cellR * cols + clampI(Math.floor(x / SMOOTH_UP), cols - 1)] > 0
                if (v >= 0.5 || (own && v >= 0.15)) out[p] = code
            }
        }
    }
    return out
}

// The codes drawn for `which` ('arrival' or 'observed'): the smoothed version of the model's cells
export function fieldOf(res, which) {
    const g = gridsOf(res)
    const { rows, cols } = res.grid
    const key = which + 'Smooth'
    if (!g[key]) g[key] = smoothCodes(g[which], rows, cols)
    return { codes: g[key], rows: rows * SMOOTH_UP, cols: cols * SMOOTH_UP, up: SMOOTH_UP }
}

// The fire's own extent in a run up to `step` (default: all six days): the start fire, every cell
// the forecast has burned by then and the ground truth by then, as {south, north, west, east}.
// The tool sits beside this, not beside the much larger data window. Falls back to the window.
const fireExtents = new WeakMap()
export function fireBounds(res, step = STEPS) {
    if (!res || !res.grid) return null
    let byStep = fireExtents.get(res)
    if (!byStep) fireExtents.set(res, (byStep = {}))
    let b = byStep[step]
    if (b) return b
    const { arrival, observed } = gridsOf(res)
    const { rows, cols, south, north, west, east } = res.grid
    let r0 = rows, r1 = -1, c0 = cols, c1 = -1
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
            const i = r * cols + c
            const a = arrival[i]
            const o = observed[i]
            const burned = a === 255 || (a > 0 && a <= step) || o === 255 || (o > 0 && o <= step)
            if (!burned) continue
            if (r < r0) r0 = r
            if (r > r1) r1 = r
            if (c < c0) c0 = c
            if (c > c1) c1 = c
        }
    if (r1 < 0) b = { south, north, west, east }
    else {
        const dy = (north - south) / rows
        const dx = (east - west) / cols
        b = { north: north - r0 * dy, south: north - (r1 + 1) * dy, west: west + c0 * dx, east: west + (c1 + 1) * dx }
    }
    byStep[step] = b
    return b
}

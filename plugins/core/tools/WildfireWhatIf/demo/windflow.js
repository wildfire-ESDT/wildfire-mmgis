// Wind flow: the wind as moving streaks over one fire's box, drawn on a canvas
// over the map. Built for the demo fires instead of leaflet-velocity, which
// stops, clears and re-samples the whole screen on every new field: here the
// streaks keep moving when the field changes (the new wind blends in over
// BLEND_MS), the first frame draws at once, and the streaks stay pinned to the
// ground when the map pans or zooms.
//
// A field is one step of the model server's /demos/<id>/flow answer: a U and a
// V record in leaflet-velocity's gribjson form (header lo1, la1 at the
// north-west sample, dx, dy in degrees, nx, ny; values row by row from north to
// south, west to east, m/s).

const BLEND_MS = 600 // a new field blends in over this long
// Each streak is a comet: its last TRAIL_S seconds of path, drawn as a tapered line (bright head,
// fading tail) and cleared every frame, so it never smears into dots. Screen speed grows gently
// with the wind so light air still draws a readable streak: 2 m/s ~ 40 px/s, 10 m/s ~ 75 px/s.
const BASE_PX = 15 // screen px per second at any wind
const SPEED_PX = 18 // plus this many per sqrt(m/s)
const TRAIL_S = 0.9 // seconds of path in a tail
const SAMPLE_MS = 45 // a tail point every this long
const LIFE_S = [2.5, 4.5] // a streak lives this long (random in the range), then starts again elsewhere
const PX_PER_STREAK = 1100 // one streak per this many square pixels of the box on screen
const MIN_STREAKS = 50
const MAX_STREAKS = 420
const SEGS = 6 // tail drawn in this many alpha / width steps
const M_PER_DEG = 111320

function toArrays(records) {
    const [u, v] = records
    const h = u.header
    return {
        lo1: h.lo1,
        la1: h.la1,
        dx: h.dx,
        dy: h.dy,
        nx: h.nx,
        ny: h.ny,
        u: Float32Array.from(u.data),
        v: Float32Array.from(v.data),
    }
}

// The wind (u east, v north, m/s) at lat, lon, by bilinear interpolation; null outside the field
function sample(f, lat, lon) {
    const i = (lon - f.lo1) / f.dx
    const j = (f.la1 - lat) / f.dy
    if (i < 0 || j < 0 || i > f.nx - 1 || j > f.ny - 1) return null
    const i0 = Math.min(Math.floor(i), f.nx - 2)
    const j0 = Math.min(Math.floor(j), f.ny - 2)
    const a = i - i0
    const b = j - j0
    const p = j0 * f.nx + i0
    const q = p + f.nx
    const u = (1 - b) * ((1 - a) * f.u[p] + a * f.u[p + 1]) + b * ((1 - a) * f.u[q] + a * f.u[q + 1])
    const v = (1 - b) * ((1 - a) * f.v[p] + a * f.v[p + 1]) + b * ((1 - a) * f.v[q] + a * f.v[q + 1])
    return [u, v]
}

// box: {south, north, west, east} of the fire's window
export function createWindFlow(map, box) {
    const L = window.L
    const container = map.getContainer()
    const canvas = L.DomUtil.create('canvas', 'ww-windflow leaflet-zoom-hide')
    canvas.style.position = 'absolute'
    canvas.style.left = '0'
    canvas.style.top = '0'
    canvas.style.pointerEvents = 'none'
    canvas.style.zIndex = '450' // over the overlays, under the markers and popups
    container.appendChild(canvas)
    const ctx = canvas.getContext('2d')

    let field = null // the field drawn
    let color = [250, 252, 255] // the streaks' colour (white: the run's wind; setColor for a wind being authored)
    let blendMs = BLEND_MS // how long the field now blending in takes
    let from = null // the field blending out, and when the blend began
    let blendStart = 0
    let streaks = []
    let raf = null
    let last = 0

    const ratio = window.devicePixelRatio || 1
    function resize() {
        const s = map.getSize()
        canvas.width = s.x * ratio
        canvas.height = s.y * ratio
        canvas.style.width = s.x + 'px'
        canvas.style.height = s.y + 'px'
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    }

    function wind(lat, lon, now) {
        const b = field && sample(field, lat, lon)
        if (!b) return null
        if (!from) return b
        const t = Math.min((now - blendStart) / blendMs, 1)
        if (t >= 1) {
            from = null
            return b
        }
        const a = sample(from, lat, lon)
        if (!a) return b
        return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
    }

    function spawn(s, now = performance.now()) {
        s.lat = box.south + Math.random() * (box.north - box.south)
        s.lon = box.west + Math.random() * (box.east - box.west)
        s.born = now - Math.random() * 1000 * LIFE_S[0] // staggered, so they do not all restart together
        s.life = 1000 * (LIFE_S[0] + Math.random() * (LIFE_S[1] - LIFE_S[0]))
        s.trail = [[s.lat, s.lon, now]]
        s.speed = 0
        return s
    }

    function fitCount() {
        const a = map.latLngToContainerPoint([box.north, box.west])
        const b = map.latLngToContainerPoint([box.south, box.east])
        const area = Math.abs(b.x - a.x) * Math.abs(b.y - a.y)
        const n = Math.round(Math.min(MAX_STREAKS, Math.max(MIN_STREAKS, area / PX_PER_STREAK)))
        while (streaks.length < n) streaks.push(spawn({}))
        if (streaks.length > n) streaks.length = n
    }

    function clear() {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
    }

    function frame(now) {
        raf = requestAnimationFrame(frame)
        const dt = Math.min((now - (last || now)) / 1000, 0.1)
        last = now
        clear()
        if (!field) return
        // metres per screen pixel at the box's latitude and this zoom
        const lat0 = (box.north + box.south) / 2
        const mpp = (40075016.686 * Math.cos((lat0 * Math.PI) / 180)) / Math.pow(2, map.getZoom() + 8)
        const halo = Array.from({ length: SEGS }, () => new Path2D())
        const core = Array.from({ length: SEGS }, () => new Path2D())
        for (const s of streaks) {
            const w = wind(s.lat, s.lon, now)
            if (!w || now - s.born > s.life) {
                spawn(s, now)
                continue
            }
            const speed = Math.hypot(w[0], w[1])
            s.speed = speed
            if (speed > 0.05) {
                const px = BASE_PX + SPEED_PX * Math.sqrt(speed) // screen px per second
                const m = (px * dt * mpp) / speed // metres per (m/s of wind) this frame
                s.lat += (w[1] * m) / M_PER_DEG
                s.lon += (w[0] * m) / (M_PER_DEG * Math.cos((s.lat * Math.PI) / 180))
            }
            const lastPt = s.trail[s.trail.length - 1]
            if (now - lastPt[2] >= SAMPLE_MS) s.trail.push([s.lat, s.lon, now])
            else {
                lastPt[0] = s.lat
                lastPt[1] = s.lon
            }
            while (s.trail.length > 2 && now - s.trail[0][2] > TRAIL_S * 1000) s.trail.shift()
            // fade in after a start and out before the end of a life
            const age = now - s.born
            const fade = Math.min(1, age / 400, (s.life - age) / 500)
            if (fade <= 0 || s.trail.length < 2) continue
            const pts = s.trail.map(([la, lo]) => map.latLngToContainerPoint([la, lo]))
            const n = pts.length - 1
            for (let k = 0; k < n; k++) {
                // k = 0 is the tail's end: its step from faint to the bright head
                const g = Math.min(SEGS - 1, Math.floor((((k + 1) / n) * fade) * SEGS))
                halo[g].moveTo(pts[k].x, pts[k].y)
                halo[g].lineTo(pts[k + 1].x, pts[k + 1].y)
                core[g].moveTo(pts[k].x, pts[k].y)
                core[g].lineTo(pts[k + 1].x, pts[k + 1].y)
            }
        }
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        for (let g = 0; g < SEGS; g++) {
            const t01 = (g + 1) / SEGS
            ctx.lineWidth = 1 + 3 * t01 // the dark outline, so streaks read over the fire's light colours
            ctx.strokeStyle = `rgba(10, 14, 20, ${0.28 * t01})`
            ctx.stroke(halo[g])
        }
        for (let g = 0; g < SEGS; g++) {
            const t01 = (g + 1) / SEGS
            ctx.lineWidth = 0.6 + 1.6 * t01
            ctx.strokeStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${0.95 * t01})`
            ctx.stroke(core[g])
        }
    }

    // panning or zooming moves the ground under the trails: wipe them, keep the streaks
    const onMove = () => {}
    const onResize = () => {
        resize()
        clear()
    }
    const onZoomEnd = () => {
        clear()
        fitCount()
    }
    map.on('move zoom', onMove)
    map.on('zoomend', onZoomEnd)
    map.on('resize', onResize)
    resize()
    fitCount()
    raf = requestAnimationFrame(frame)

    return {
        // records: [U, V] of one step. The streaks keep going; the new wind blends in over `ms`.
        setField(records, ms = BLEND_MS) {
            const next = toArrays(records)
            blendMs = ms
            if (field) {
                from = field
                blendStart = performance.now()
            }
            field = next
        },
        // [r, g, b] of the streaks
        setColor(rgb) {
            color = rgb
        },
        destroy() {
            if (raf) cancelAnimationFrame(raf)
            map.off('move zoom', onMove)
            map.off('zoomend', onZoomEnd)
            map.off('resize', onResize)
            if (canvas.parentNode) canvas.parentNode.removeChild(canvas)
        },
    }
}

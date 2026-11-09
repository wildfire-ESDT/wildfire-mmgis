// Times: FEDS half-days shown as the satellite passes they hold, and the optional
// sync of MMGIS's own clock to the forecast (off by default).
import { S, session, activeResult } from './session'

function isoUtc(t) {
    const x = String(t).replace(' ', 'T')
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(x) ? x : x + 'Z')
    return isNaN(d.getTime()) ? null : d
}

// ─── Times: FEDS half-days, shown as the satellite passes they hold ───────────
// FEDS names each half-day of a LOCAL (solar) date "00:00" (the night pass, VIIRS
// ~01:30 local) or "12:00" (the afternoon pass, ~13:30 local): fire-pipeline
// DECISIONS.md, fireatlas FireGpkg.py. "Jan 7 12:00" is the afternoon of Jan 7 at
// the fire, not noon UTC. Local solar time = UTC + longitude / 15 hours.
const PASS_AFTER_H = 1.5

function fireLon(grid) {
    return grid ? (grid.west + grid.east) / 2 : 0
}

// The UTC instant of the satellite pass a FEDS half-day label stands for
export function passTime(label, grid) {
    const d = isoUtc(label)
    if (!d) return null
    const t = d.getTime() + (PASS_AFTER_H - fireLon(grid) / 15) * 3600e3
    return new Date(Math.round(t / 1800e3) * 1800e3) // to the half hour: the pass time is approximate
}

// "Jan 7, about 1:30 PM local"
export function fmtPass(label, grid, { year = false } = {}) {
    const t = passTime(label, grid)
    if (!t) return ''
    // the local solar clock, read as UTC, to the half hour
    const local = new Date(Math.round((t.getTime() + (fireLon(grid) / 15) * 3600e3) / 1800e3) * 1800e3)
    const day = local.toLocaleDateString([], { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' })
    const hour = local.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
    return `${day}, about ${hour} local`
}

// ─── The platform's time (optional): MMGIS's clock follows the forecast ──────
// Off by default: the forecast is a forecast and leaves the platform's timeline alone. With the
// window's clock toggle on, MMGIS's time (its time bar and every time-aware layer) is set to the
// shown step's satellite pass, keeping the length of its time window, and put back as it was
// when the toggle goes off or the fire closes.

let savedTime = null // MMGIS's time before the forecast took it over
let timeTimer = null

function mmgisTime() {
    const api = window.mmgisAPI
    return api && api.setTime && api.getStartTime && api.getEndTime ? api : null
}

export function takeTime() {
    const api = mmgisTime()
    if (!api || savedTime) return
    savedTime = { start: api.getStartTime(), end: api.getEndTime(), current: api.getTime ? api.getTime() : null }
}

export function giveTimeBack() {
    if (timeTimer) clearTimeout(timeTimer)
    timeTimer = null
    const api = mmgisTime()
    if (api && savedTime && savedTime.start && savedTime.end)
        api.setTime(savedTime.start, savedTime.end, false, '00:00:00', savedTime.current || savedTime.end)
    savedTime = null
}

export function syncTime(now = false) {
    if (timeTimer) clearTimeout(timeTimer)
    timeTimer = null
    if (!S.getState().syncMapTime) return
    const go = () => {
        const s = S.getState()
        const res = activeResult()
        const api = mmgisTime()
        if (session.hidden || !api || !res || !s.activeDemo || !s.syncMapTime) return
        const when = passTime(s.demoStep === 0 ? res.start_time : res.steps[s.demoStep - 1].time, res.grid)
        if (!when) return
        const span =
            savedTime && savedTime.start && savedTime.end
                ? Math.max(3600e3, new Date(savedTime.end).getTime() - new Date(savedTime.start).getTime())
                : 24 * 3600e3
        const end = when.toISOString().split('.')[0] + 'Z'
        const start = new Date(when.getTime() - span).toISOString().split('.')[0] + 'Z'
        try {
            api.setTime(start, end, false, '00:00:00', end)
        } catch (e) {}
    }
    if (now) go()
    else timeTimer = setTimeout(go, 400)
}

export function setSyncMapTime(on) {
    S.setState({ syncMapTime: !!on })
    if (on) {
        takeTime()
        syncTime(true)
    } else giveTimeBack()
}

// The what-if wind being authored, compared with the real wind.
import { S } from './session'

// The what-if wind: the six-day mean speed and direction the run should have
// (null = the real wind). The server scales and turns the real hourly winds to it.
export function observedWind() {
    const s = S.getState()
    const list = s.activeDemo && s.demoResults[s.activeDemo]
    return (list && list[0] && list[0].wind_observed) || null
}

// The authored what-if wind as the server applies it: the real winds scaled by the ratio of the
// six-day mean speeds and turned (clockwise) by the change of the mean direction
export function draftWind() {
    const w = S.getState().demoWind
    const b = observedWind()
    if (!w || !b || !(b.speed_ms > 0)) return { scale: 1, turn: 0 }
    return { scale: w.speed_ms / b.speed_ms, turn: ((((w.direction_deg - b.direction_deg + 180) % 360) + 360) % 360) - 180 }
}

export function windEdited() {
    const w = S.getState().demoWind
    const b = observedWind()
    return !!(w && b && (Math.abs(w.speed_ms - b.speed_ms) > 0.05 || Math.abs(w.direction_deg - b.direction_deg) > 0.5))
}

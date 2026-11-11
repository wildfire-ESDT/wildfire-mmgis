// What the demo modules share: the store, the forecast's length, whether the tool is
// hidden, the run on screen, and a redraw hook (render.js registers drawDemo), so
// the modules that load data can ask for a redraw without importing the renderer.
import useWhatIfStore from '../store'

export const S = useWhatIfStore

export const STEPS = 12 // twelve 12-hour steps: six days

// the tool closed (or signed out): answers still arriving must not draw on the map
export const session = { hidden: false }

let redrawFn = () => {}
export function setRedraw(fn) {
    redrawFn = fn
}
export function redraw(opts) {
    redrawFn(opts)
}

// The model forecast a what-if is compared with (the fire's first run); null when the run on screen is
// that forecast itself. `s` = a store state (a component's selector passes its own).
export function baselineOf(s = S.getState()) {
    const list = s.activeDemo && s.demoResults[s.activeDemo]
    const res = list ? list[Math.min(s.demoIdx, list.length - 1)] : null
    return res && res.kind === 'whatif' && list[0] !== res ? list[0] : null
}

export function activeResult() {
    const s = S.getState()
    const list = s.activeDemo && s.demoResults[s.activeDemo]
    return list ? list[Math.min(s.demoIdx, list.length - 1)] : null
}

// The spot readout: a click on the map inside the fire's window reads every input
// there (shown in Area conditions), at the shown step and with the shown run's wind.
import { getMap } from '../utils'
import { S, redraw, activeResult } from './session'
import { modelFetch } from './api'
import { runWind } from './layers'

let clickMap = null // the map the spot readout listens on
let probeSeq = 0 // the latest spot reading asked for (older answers are dropped)

// A spot reading still on its way is dropped (another fire opened)
export function dropProbe() {
    probeSeq++
}

// The mouse-up that finishes a drawn line also clicks: skip clicks right after a drawing ends
let drawEndedAt = 0
S.subscribe((st, prev) => {
    if ((prev.drawingDozerLine && !st.drawingDozerLine) || (prev.drawing && !st.drawing)) drawEndedAt = Date.now()
})

// A click on one of the map's own features (a fire perimeter, ...) is that
// layer's: MMGIS shows its info, so the readout stays closed. MMGIS tells the
// tool about the feature (setActiveFeature) during that same click.
let featureClickedAt = 0
export function noteMapFeatureClick() {
    featureClickedAt = Date.now()
}

function onMapClick(e) {
    // MMGIS reports a clicked feature during the same click; look once it has
    setTimeout(() => readCell(e), 60)
}

function readCell(e) {
    const s = S.getState()
    const res = activeResult()
    if (!s.activeDemo || !res || s.drawingDozerLine || s.drawing || Date.now() - drawEndedAt < 400) return
    if (Date.now() - featureClickedAt < 500) return
    const target = e.originalEvent && e.originalEvent.target
    if (target && target.classList && target.classList.contains('leaflet-interactive')) return
    const g = res.grid
    const { lat, lng } = e.latlng
    if (lat < g.south || lat > g.north || lng < g.west || lng > g.east) return
    S.setState({ probe: { lat, lon: lng }, probeData: null, probeError: null, sidePanels: { ...S.getState().sidePanels, area: true } }) // read in Area conditions
    redraw()
    readProbe()
}

// Every input at the marked spot, at the shown step and with the shown run's wind
export function readProbe() {
    const s = S.getState()
    if (!s.activeDemo || !s.probe) return
    const w = runWind('wind')
    const seq = ++probeSeq
    S.setState({ probeLoading: true })
    modelFetch(
        `demos/${encodeURIComponent(s.activeDemo)}/cell?lat=${s.probe.lat.toFixed(5)}&lon=${s.probe.lon.toFixed(5)}&step=${Math.max(
            s.demoStep,
            1
        )}&scale=${w.scale}&turn=${w.turn}`
    )
        .then((d) => seq === probeSeq && S.setState({ probeData: d, probeLoading: false, probeError: null }))
        .catch((err) => seq === probeSeq && S.setState({ probeLoading: false, probeError: err.message }))
}

export function clearProbe() {
    probeSeq++
    S.setState({ probe: null, probeData: null, probeError: null, probeLoading: false })
    redraw()
}

export function listenForClicks() {
    const m = getMap()
    if (!m || clickMap === m) return
    stopListeningForClicks()
    clickMap = m
    clickMap.on('click', onMapClick)
}

export function stopListeningForClicks() {
    if (clickMap) clickMap.off('click', onMapClick)
    clickMap = null
}

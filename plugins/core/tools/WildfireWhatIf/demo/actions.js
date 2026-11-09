// The open fire's actions: opening and closing it, stepping and playing through
// its six days, picking and removing runs, authoring and running what-ifs, and
// the switches of the Fire analysis window and its panels.
import * as map from '../map'
import { restoreScenario, cancelMapDraw, cancelDozerLineDraw } from '../actions'
import { S, STEPS } from './session'
import { modelFetch } from './api'
import { drawDemo, removeDemoLayers } from './render'
import { removeFlow } from './flow'
import { loadInputCatalog } from './layers'
import { listenForClicks, stopListeningForClicks, readProbe, dropProbe } from './probe'
import { takeTime, giveTimeBack, syncTime } from './time'
import { observedWind, windEdited } from './wind'

const PLAY_MS = 800
const whatifsRunning = new Set() // the fires with a what-if run on the model server
let playTimer = null
let stashedDozerLines = null // the draft's dozer lines while a demo is open

export function loadDemos() {
    const s = S.getState()
    if (s.demosLoading) return
    S.setState({ demosLoading: true, demosError: null })
    modelFetch('demos')
        .then((d) => {
            S.setState({ demos: d.demos || [], demoModel: d.model || null, demosLoading: false })
        })
        .catch((err) =>
            S.setState({
                demosLoading: false,
                demosError: `Couldn't reach the model server (${err.message}).`,
            })
        )
}

export function openDemo(id) {
    cancelMapDraw()
    cancelDozerLineDraw()
    pauseDemo()
    const s = S.getState()
    if (stashedDozerLines === null) stashedDozerLines = s.dozerLines
    map.clearScenarioLayers()
    // the fire open before (if any) leaves the map now, not when this one's forecast arrives
    removeDemoLayers()
    removeFlow()
    dropProbe() // a spot reading of the fire open before is dropped
    S.setState({
        activeDemo: id,
        demoIdx: 0,
        demoStep: 0,
        demoError: null,
        demoBusy: whatifsRunning.has(id),
        dozerLines: [],
        demoWind: null,
        visibleInputs: [],
        probe: null,
        probeData: null,
        probeError: null,
        probeLoading: false,
        addedInputKeys: [],
        windEditOpen: false,
        showObserved: true, // the ground truth's edge shows from the start
        sidePanels: { area: false, whatif: false },
        toolCollapsed: false,
    })
    listenForClicks()
    loadInputCatalog(id)
    if (s.syncMapTime) takeTime()
    const have = s.demoResults[id]
    if (have && have.length) {
        drawDemo({ fit: true })
        syncTime(true)
        return
    }
    S.setState({ demoBusy: true })
    modelFetch(`demos/${encodeURIComponent(id)}`)
        .then((res) => {
            const st = S.getState()
            // another fire opened meanwhile: keep this one's forecast, leave that fire's window alone
            S.setState({ demoResults: { ...st.demoResults, [id]: [res] }, ...(st.activeDemo === id ? { demoBusy: false } : {}) })
            if (st.activeDemo === id) {
                drawDemo({ fit: true })
                syncTime(true)
            }
        })
        .catch((err) => {
            if (S.getState().activeDemo === id)
                S.setState({ demoBusy: false, demoError: `Couldn't load this fire: ${err.message}` })
        })
}

export function closeDemo() {
    pauseDemo()
    cancelDozerLineDraw()
    removeDemoLayers()
    removeFlow()
    stopListeningForClicks()
    map.removeDozerLines()
    S.setState({ activeDemo: null, demoError: null, dozerLines: stashedDozerLines || [] })
    stashedDozerLines = null
    giveTimeBack()
    restoreScenario()
}

export function selectDemoRun(i) {
    pauseDemo()
    // the same step, so runs compare at the same moment; the Wind card (and its arrows) take this run's wind
    const list = S.getState().demoResults[S.getState().activeDemo] || []
    const run = list[i]
    const w = run && run.kind === 'whatif' && run.wind_mean ? { ...run.wind_mean } : null
    const lines = ((run && run.lines) || []).map((coords, n) => ({ id: `run${i}-${n}-${Date.now()}`, coords }))
    S.setState({ demoIdx: i, demoWind: w, dozerLines: lines })
    if (lines.length) map.showDozerLines(lines)
    else map.removeDozerLines()
    drawDemo()
    readProbe()
    syncTime(true)
}

export function removeDemoRun(i) {
    const s = S.getState()
    const list = s.demoResults[s.activeDemo]
    if (!list || i === 0) return
    const next = list.filter((_, j) => j !== i)
    S.setState({
        demoResults: { ...s.demoResults, [s.activeDemo]: next },
        demoIdx: s.demoIdx === i ? 0 : s.demoIdx > i ? s.demoIdx - 1 : s.demoIdx,
    })
    // the shown run removed: the model forecast shows, with its wind and no lines (as when it is picked)
    if (s.demoIdx === i) selectDemoRun(0)
    else drawDemo()
}

export function setDemoStep(k) {
    const before = S.getState().demoStep
    S.setState({ demoStep: Math.min(Math.max(Math.round(k), 0), STEPS) })
    drawDemo()
    if (Math.max(S.getState().demoStep, 1) !== Math.max(before, 1)) readProbe() // the spot's weather is per step
    syncTime(!!playTimer)
}

export function stepDemo(delta) {
    pauseDemo()
    setDemoStep(S.getState().demoStep + delta)
}

export function playDemo() {
    if (playTimer) return
    if (S.getState().demoStep >= STEPS) setDemoStep(0)
    S.setState({ demoPlaying: true })
    playTimer = setInterval(() => {
        const k = S.getState().demoStep
        if (k >= STEPS) return pauseDemo()
        setDemoStep(k + 1)
    }, PLAY_MS)
}

export function pauseDemo() {
    if (playTimer) clearInterval(playTimer)
    playTimer = null
    if (S.getState().demoPlaying) S.setState({ demoPlaying: false })
}

export function setShowObserved(on) {
    S.setState({ showObserved: !!on })
    drawDemo()
}

export function setDemoWind(field, value) {
    const base = observedWind()
    if (!base) return
    const cur = S.getState().demoWind || { ...base }
    S.setState({ demoWind: { ...cur, [field]: Number(value) } })
    drawDemo()
}

export function resetDemoWind() {
    S.setState({ demoWind: null })
    drawDemo()
}

export function runDemoWhatIf() {
    const s = S.getState()
    if (!s.activeDemo || s.demoBusy) return
    pauseDemo()
    cancelDozerLineDraw()
    const id = s.activeDemo
    whatifsRunning.add(id)
    S.setState({ demoBusy: true, demoError: null })
    // A GET: MMGIS's adjacent-server proxy passes other methods only to admins
    const w = windEdited() ? s.demoWind : null
    const q = JSON.stringify({
        demo: s.activeDemo,
        ...(w ? { wind_speed_ms: Number(w.speed_ms.toFixed(2)), wind_from_deg: Number(w.direction_deg.toFixed(1)) } : {}),
        lines: s.dozerLines.map((l) => thin(l.coords)),
        line_kind: 'dozer',
    })
    modelFetch(`whatif?q=${encodeURIComponent(q)}`)
        .then((res) => {
            whatifsRunning.delete(id)
            const st = S.getState()
            const list = [...(st.demoResults[res.demo] || []), res]
            S.setState({ demoResults: { ...st.demoResults, [res.demo]: list } })
            if (st.activeDemo === res.demo) {
                S.setState({
                    demoBusy: false,
                    demoIdx: list.length - 1,
                    windEditOpen: false,
                    sidePanels: { ...S.getState().sidePanels, whatif: false }, // done: the new run shows
                })
                readProbe() // the spot's wind is this run's
                drawDemo()
                syncTime(true)
            }
        })
        .catch((err) => {
            whatifsRunning.delete(id)
            // only the fire the run was for shows its failure
            if (S.getState().activeDemo === id) S.setState({ demoBusy: false, demoError: `The model run failed: ${err.message}` })
        })
}

// A drawn line's points, thinned to at most 60 (the model's cells are ~300 m,
// so this loses nothing) and rounded, to keep the request URL short
function thin(coords) {
    const n = coords.length
    const every = Math.max(1, Math.ceil(n / 60))
    const kept = coords.filter((_, i) => i % every === 0 || i === n - 1)
    return kept.map(([lon, lat]) => [Number(lon.toFixed(5)), Number(lat.toFixed(5))])
}

// Any number of input layers can be on; they stack in the order added (the last on top), the forecast over them
export function addInput(key) {
    const s = S.getState()
    S.setState({
        addedInputKeys: s.addedInputKeys.includes(key) ? s.addedInputKeys : [key, ...s.addedInputKeys], // new on top
        visibleInputs: s.visibleInputs.includes(key) ? s.visibleInputs : [...s.visibleInputs, key],
    })
    drawDemo()
}

// Drag in the layer list: the layer at `from` moves to `to` (0 = the top, drawn over the others)
export function moveInput(from, to) {
    const keys = [...S.getState().addedInputKeys]
    if (from < 0 || from >= keys.length || to < 0 || to >= keys.length) return
    const [k] = keys.splice(from, 1)
    keys.splice(to, 0, k)
    S.setState({ addedInputKeys: keys })
    drawDemo()
}

export function removeInput(key) {
    const s = S.getState()
    S.setState({
        addedInputKeys: s.addedInputKeys.filter((k) => k !== key),
        visibleInputs: s.visibleInputs.filter((k) => k !== key),
    })
    drawDemo()
}

export function setInputVisible(key, visible) {
    const s = S.getState()
    const rest = s.visibleInputs.filter((k) => k !== key)
    S.setState({ visibleInputs: visible ? [...rest, key] : rest })
    drawDemo()
}

// The Wind card's Modify: while it is open (or the wind is changed) the map shows the authored wind
export function setWindEditOpen(open) {
    S.setState({ windEditOpen: !!open })
    drawDemo()
}

// The tool folded to a slim bar (fire and time) so the map can be seen; the side panels hide with it
export function setToolCollapsed(on) {
    S.setState({ toolCollapsed: !!on })
}

// The fire's incident details (county, incident number, WFIGS record): folded away unless asked for
export function setDetailsOpen(open) {
    S.setState({ detailsOpen: !!open })
}

// The panels slid out beside the Fire analysis window, each open or closed: area (Area conditions), whatif
export function setSidePanel(kind, open) {
    S.setState({ sidePanels: { ...S.getState().sidePanels, [kind]: !!open } })
}

// The Fire analysis window's drawers: open or closed
export function toggleDrawer(id) {
    const closed = S.getState().drawersClosed
    S.setState({ drawersClosed: { ...closed, [id]: !closed[id] } })
}

export function setWindFlow(on) {
    S.setState({ windFlow: !!on })
    drawDemo()
}

export function setShowForecast(on) {
    S.setState({ showForecast: !!on })
    drawDemo()
}

// The forecast-vs-ground-truth difference on the Forecast card (off unless asked for)
export function setCompareTruth(on) {
    S.setState({ compareTruth: !!on })
}

export function setFireOpacity(v) {
    S.setState({ fireOpacity: v })
    drawDemo()
}

export function setInputOpacity(key, v) {
    S.setState({ inputOpacities: { ...S.getState().inputOpacities, [key]: v } })
    drawDemo()
}

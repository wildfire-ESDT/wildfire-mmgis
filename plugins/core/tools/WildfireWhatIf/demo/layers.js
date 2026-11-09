// The fire's input layers (weather, terrain, fuel): the catalog, the cached layer
// data from the model server, and which wind a layer is drawn with.
import { S, redraw, activeResult } from './session'
import { modelFetch } from './api'

const layerCache = new Map() // "<demo>|<layer>|<scale>|<turn>" -> layer data, or 'loading'

export function loadInputCatalog(id) {
    const s = S.getState()
    if (s.inputCatalogs[id]) return
    modelFetch(`demos/${encodeURIComponent(id)}/layers`)
        .then((d) => S.setState({ inputCatalogs: { ...S.getState().inputCatalogs, [id]: d.layers || [] } }))
        .catch((err) => S.getState().activeDemo === id && S.setState({ demoError: `Couldn't load the fire's inputs: ${err.message}` }))
}

export function inputEntry(key) {
    const s = S.getState()
    return ((s.activeDemo && s.inputCatalogs[s.activeDemo]) || []).find((l) => l.key === key) || null
}

// The wind layer follows the shown run's what-if wind; the others are the same for every run
export function runWind(key) {
    const res = activeResult()
    if (key !== 'wind' || !res) return { scale: 1, turn: 0 }
    return { scale: res.wind_scale == null ? 1 : res.wind_scale, turn: res.wind_turn_deg || 0 }
}

export function layerCacheKey(key, w = runWind(key)) {
    return `${S.getState().activeDemo}|${key}|${w.scale}|${w.turn}`
}

// The layer's data if loaded; otherwise starts loading it and redraws when it arrives
export function needLayer(key, w = runWind(key)) {
    const s = S.getState()
    const ck = layerCacheKey(key, w)
    const have = layerCache.get(ck)
    if (have && have !== 'loading') return have
    if (have === 'loading') return null
    layerCache.set(ck, 'loading')
    S.setState({ inputLoading: key })
    modelFetch(`demos/${encodeURIComponent(s.activeDemo)}/layer/${key}?scale=${w.scale}&turn=${w.turn}`)
        .then((d) => {
            layerCache.set(ck, d)
            const st = S.getState()
            S.setState({
                ...(st.inputLoading === key ? { inputLoading: null } : {}), // another layer may still be loading
                inputRanges: { ...st.inputRanges, [ck]: { min: d.min, max: d.max } },
            })
            redraw()
        })
        .catch((err) => {
            layerCache.delete(ck)
            const st = S.getState()
            S.setState({
                ...(st.inputLoading === key ? { inputLoading: null } : {}),
                ...(st.activeDemo === s.activeDemo ? { demoError: `Couldn't load that input: ${err.message}` } : {}),
            })
        })
    return null
}

export function inputOpacity(key) {
    const v = S.getState().inputOpacities[key]
    return v == null ? 0.75 : v
}

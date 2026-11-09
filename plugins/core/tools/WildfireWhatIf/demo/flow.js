// The Wind vectors layer: the shown run's wind at the shown step, from the model
// server (/demos/<id>/flow, every third cell), animated by windflow.js. One animator
// per open fire; a new step or run only hands it a new field, which blends in while
// the streaks keep moving.
import { getMap } from '../utils'
import { S, session, activeResult } from './session'
import { modelFetch } from './api'
import { runWind } from './layers'
import { createWindFlow } from './windflow'

let flowLayer = null
let flowKey = null // demo | run wind | step of the field the animator shows
let flowDemo = null // the fire the animator was made for (its box)
const flowCache = new Map() // demo | scale | turn -> the per-step fields, or 'loading'

export function removeFlow() {
    if (flowLayer) flowLayer.destroy()
    flowLayer = null
    flowKey = null
    flowDemo = null
}

export function updateFlow() {
    const s = S.getState()
    const m = getMap()
    const res = activeResult()
    if (session.hidden || !s.windFlow || !m || !res) return removeFlow()
    const w = runWind('wind')
    const ck = `${s.activeDemo}|${w.scale}|${w.turn}`
    const have = flowCache.get(ck)
    if (!have) {
        flowCache.set(ck, 'loading')
        S.setState({ flowLoading: true })
        modelFetch(`demos/${encodeURIComponent(s.activeDemo)}/flow?scale=${w.scale}&turn=${w.turn}`)
            .then((d) => {
                flowCache.set(ck, d.steps)
                S.setState({ flowLoading: false })
                updateFlow()
            })
            .catch((err) => {
                flowCache.delete(ck)
                S.setState({
                    flowLoading: false,
                    ...(S.getState().activeDemo === s.activeDemo ? { demoError: `Couldn't load the wind flow: ${err.message}` } : {}),
                })
            })
        return
    }
    if (have === 'loading') return
    if (flowLayer && flowDemo !== s.activeDemo) removeFlow()
    if (!flowLayer) {
        flowLayer = createWindFlow(m, res.grid)
        flowDemo = s.activeDemo
    }
    const k = Math.min(Math.max(s.demoStep, 1), have.length) - 1
    const key = `${ck}|${k}`
    if (key !== flowKey) flowLayer.setField(have[k])
    flowKey = key
}

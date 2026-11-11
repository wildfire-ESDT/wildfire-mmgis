// The Wind vectors layer: the shown run's wind at the shown step, from the model
// server (/demos/<id>/flow, every third cell), animated by windflow.js. One animator
// per open fire; a new step or run only hands it a new field, which blends in while
// the streaks keep moving. While the Wind card's Modify is open the streaks show the
// wind being authored instead (the real wind turned and scaled here, in yellow).
import { getMap } from '../utils'
import { S, session, activeResult } from './session'
import { modelFetch } from './api'
import { runWind } from './layers'
import { createWindFlow } from './windflow'
import { draftWind } from './wind'

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

const RUN_RGB = [250, 252, 255] // the run's wind: white streaks
const DRAFT_RGB = [255, 221, 92] // the wind being authored: the Wind card's yellow
const DRAFT_BLEND_MS = 150 // the authored wind follows the dial closely

// One step's [U, V] records scaled and turned (degrees, clockwise on the compass): the what-if wind as the
// server will apply it, worked out here so the streaks follow the Wind card's Modify without a request
function turned(records, scale, turnDeg) {
    const [u, v] = records
    const t = (turnDeg * Math.PI) / 180
    const c = Math.cos(t)
    const sn = Math.sin(t)
    const U = new Array(u.data.length)
    const V = new Array(u.data.length)
    for (let i = 0; i < U.length; i++) {
        U[i] = scale * (u.data[i] * c + v.data[i] * sn)
        V[i] = scale * (-u.data[i] * sn + v.data[i] * c)
    }
    return [
        { header: u.header, data: U },
        { header: v.header, data: V },
    ]
}

export function updateFlow() {
    const s = S.getState()
    const m = getMap()
    const res = activeResult()
    // Authoring a what-if (the Wind card's Modify is open): the streaks show the wind being set, whether
    // or not the Wind vectors layer is on; closing Modify gives the layer back its own switch
    const editing = !!s.windEditOpen
    if (session.hidden || !(s.windFlow || editing) || !m || !res) return removeFlow()
    const w = editing ? { scale: 1, turn: 0 } : runWind('wind') // the draft is turned from the REAL wind
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
    const d = editing ? draftWind() : null
    const key = d ? `${ck}|${k}|draft|${d.scale}|${d.turn}` : `${ck}|${k}`
    if (key !== flowKey) {
        if (d) flowLayer.setField(turned(have[k], d.scale, d.turn), DRAFT_BLEND_MS)
        else flowLayer.setField(have[k])
    }
    flowLayer.setColor(d ? DRAFT_RGB : RUN_RGB)
    flowKey = key
}

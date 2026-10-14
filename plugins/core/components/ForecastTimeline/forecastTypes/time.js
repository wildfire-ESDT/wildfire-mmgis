/**
 * `time`, the default forecast type. What a layer gets when it names none: a
 * tick moves the layer's query end time to that step and the layer refetches
 * itself. Works for any time-enabled layer.
 */

import { STEP_UNITS, hasInitHour, isoSeconds } from '../shared/common'

// The end instant a tick queries. Monthly items are the forecast for their own
// month. Items stamped at valid time are queried at the tick's own instant.
// Otherwise the tick is labeled with the VALID period but queries the ISSUE
// period, one step earlier.
export function queryEnd(forecast, stepTime, nowIso, stampedAtValidTime) {
    const unit = forecast.stepUnit || 'hour'
    if (unit === 'month') {
        const nowMs = Date.parse(nowIso)
        const future = stepTime > nowMs
        return { iso: future ? isoSeconds(stepTime) : nowIso, futureMonth: future }
    }
    if (stampedAtValidTime) return { iso: new Date(stepTime).toISOString(), futureMonth: false }
    const unitMs = STEP_UNITS[unit] || STEP_UNITS.hour
    return { iso: new Date(stepTime - unitMs).toISOString(), futureMonth: false }
}

// Point the layer at queryEndIso, refresh or reload it, then put its own time
// window back so the main timeline still owns it.
export function shiftLayerTime({ layer, mapLayer, forecast, engine }, queryEndIso, futureMonth) {
    const prevStart = layer.time.start
    const prevEnd = layer.time.end
    layer.time.end = queryEndIso

    if (layer.type === 'tile') {
        engine.applyTimeParams(layer)
        // Core reloads this layer itself during a timeline change with the same
        // current-month request; skip the duplicate.
        const coreCovers =
            engine.duringTimelineChange && forecast.stepUnit === 'month' && !futureMonth
        if (mapLayer && !coreCovers) mapLayer.refresh(null, true)
    } else {
        engine.reloadLayer(layer)
    }

    layer.time.start = prevStart
    layer.time.end = prevEnd
}

const timeForecastType = {
    name: 'time',

    showStep(call) {
        const { layer, forecast, stepTime, isOn, engine } = call
        if (!layer || !isOn) return
        const { iso, futureMonth } = queryEnd(
            forecast,
            stepTime,
            engine.currentTime || layer.time.end,
            hasInitHour(forecast)
        )
        shiftLayerTime(call, iso, futureMonth)
    },
}

export default timeForecastType

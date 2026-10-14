/**
 * Generic forecast type. Ships with the plugin; any mission can use it as is.
 *
 * `stac`: a titiler-pgstac collection with one item per forecast period. Ticks
 * shift the query time like `time`; the items endpoint says which periods have
 * data, and those with none render dark.
 *
 * perRun: the collection holds every run's forecast, each item stamped at its
 * valid hour and tagged forecast:reference_datetime = run. Tiles and checks
 * then ask for the selected run only.
 */

import {
    hasInitHour,
    isoSeconds,
    runQueryParameter,
    stacCollectionUrl,
} from '../shared/common'
import { periodBounds, stepTime } from '../shared/timeMath'
import { queryEnd, shiftLayerTime } from './time'

export function perRun(forecast) {
    return forecast?.perRun === true || forecast?.itemsPerRun === true
}

function stampedAtValidTime(forecast) {
    return hasInitHour(forecast) || perRun(forecast)
}

// The period a tick's query targets.
export function queryPeriodStart(forecast, step, run) {
    if ((forecast.stepUnit || 'hour') === 'month') return stepTime(forecast, step, run)
    return stepTime(forecast, stampedAtValidTime(forecast) ? step : step - 1, run)
}

export function itemsUrl(layer, forecast, run, steps) {
    const stacUrl = stacCollectionUrl(layer)
    if (!stacUrl) return null
    const unit = forecast.stepUnit || 'hour'
    const first = queryPeriodStart(forecast, 0, run)
    const lastStart = queryPeriodStart(forecast, steps - 1, run)
    const endMs = periodBounds(unit, lastStart)[1] - 1000
    const runQuery = perRun(forecast) ? `&query=${runQueryParameter(run)}` : ''
    return `${stacUrl}/items?limit=200&datetime=${isoSeconds(first)}/${isoSeconds(endMs)}${runQuery}`
}

// Steps whose query period holds at least one of these items.
export function stepsWithItems(features, forecast, run, steps) {
    const unit = forecast.stepUnit || 'hour'
    const stepByPeriod = new Map()
    for (let i = 0; i < steps; i++) stepByPeriod.set(queryPeriodStart(forecast, i, run), i)
    const present = new Set()
    for (const f of features || []) {
        const t = Date.parse(f?.properties?.datetime)
        if (isNaN(t)) continue
        const step = stepByPeriod.get(periodBounds(unit, t)[0])
        if (step != null) present.add(step)
    }
    return present
}

// Tiles ask for one instant, not the open epoch window, so the mosaic holds
// the one item the tick means.
export function tileTimeWindow({ layer, forecast, run, step, stepTime: stepMs, uninitialized, requestedEnd }) {
    if (layer?.type !== 'tile') return null
    const t0 = Date.parse(requestedEnd)
    if (isNaN(t0)) return null
    if (perRun(forecast)) return [isoSeconds(stepMs), isoSeconds(stepMs + 1000)]
    // No run at this hour: a zero-length window draws nothing.
    if (uninitialized) return [isoSeconds(t0), isoSeconds(t0)]
    const unit = forecast?.stepUnit || 'hour'
    if (unit === 'month') {
        const d = new Date(t0)
        const atBoundary =
            d.getUTCDate() === 1 && d.getUTCHours() === 0 &&
            d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0
        return [isoSeconds(t0), isoSeconds(t0 + (atBoundary ? 3600000 : 1000))]
    }
    const [start] = periodBounds(unit, t0)
    return [isoSeconds(start), isoSeconds(start + 1000)]
}

const stacForecastType = {
    name: 'stac',

    showStep(call) {
        const { layer, forecast, stepTime: stepMs, isOn, engine } = call
        if (!layer || !isOn) return
        const { iso, futureMonth } = queryEnd(
            forecast,
            stepMs,
            engine.currentTime || layer.time.end,
            stampedAtValidTime(forecast)
        )
        shiftLayerTime(call, iso, futureMonth)
    },

    // One spanning items request per run. Fails open: a broken items API must
    // not blank a working card.
    findAvailableSteps({ name, layer, forecast, run, steps, engine }) {
        const url = itemsUrl(layer, forecast, run, steps)
        if (!url) return Promise.resolve(null)
        engine.debug('stac items', name, url)
        return fetch(url, engine.fetchOptions())
            .then((r) => {
                if (!r.ok) throw new Error(r.status)
                return r.json()
            })
            .then((j) => stepsWithItems(j?.features, forecast, run, steps))
            .catch((e) => {
                engine.debug('stac items ERROR (failing open)', name, e)
                return null
            })
    },

    buildTileUrl({ forecast, run, url }) {
        if (!perRun(forecast)) return url
        return `${url}${url.includes('?') ? '&' : '?'}query=${runQueryParameter(run)}`
    },

    timeWindow: tileTimeWindow,
}

export default stacForecastType

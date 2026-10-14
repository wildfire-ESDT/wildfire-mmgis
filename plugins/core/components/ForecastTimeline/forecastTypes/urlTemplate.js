/**
 * Generic forecast type. Ships with the plugin; any mission can use it as is.
 *
 * `url-template`: the layer URL carries __FSTEP__, replaced with the 1-based
 * step number. Made for WMS services that publish one layer per forecast step.
 *
 * The availability check is a 1x1 GetMap of step 1 with {time} as a date
 * (YYYY-MM-DD). Options: probeBbox, an EPSG:3857 bbox string for that GetMap
 * (default: the whole world).
 */

import { resolveUrlTokens } from '../shared/common'

function baseUrl(layer, forecast) {
    if (!forecast._baseUrl) forecast._baseUrl = layer.url
    return forecast._baseUrl
}

function showStepNumber({ layer, mapLayer, forecast, isOn, engine }, stepNumber) {
    if (!layer) return
    const newUrl = baseUrl(layer, forecast).replace(/__FSTEP__/g, String(stepNumber))
    layer.url = newUrl

    if (mapLayer && layer.tileformat === 'wms') {
        // Substitute even while off: the pre-built layer carries the raw token.
        const [newBase, query] = newUrl.split('?')
        const params = new URLSearchParams(query || '')
        mapLayer._url = newBase
        const layersValue = params.get('layers') || params.get('LAYERS')
        if (layersValue) mapLayer.setParams({ LAYERS: layersValue }, true)
        if (engine.currentTime) {
            layer.time.end = engine.currentTime
            if (engine.startTime) layer.time.start = engine.startTime
            engine.applyTimeParams(layer)
        }
        if (isOn) mapLayer.redraw()
    } else if (isOn) {
        engine.reloadLayer(layer, { forceRequery: true })
    }
}

// A 1x1 GetMap of step 1, judged by content type: GeoServer answers a missing
// TIME with HTTP 200 and an XML body. Step 1 answers for the run because these
// products publish a whole run at once.
const WORLD_BBOX_3857 = '-20037508,-20037508,20037508,20037508'

export function probeUrl(layer, forecast, run) {
    const base = forecast._baseUrl || layer?.url || ''
    if (!base.includes('__FSTEP__')) return null
    const dateStr = new Date(run).toISOString().slice(0, 10)
    let url = resolveUrlTokens(base.replace(/__FSTEP__/g, '1'), dateStr)
    if (!/[?&]width=/i.test(url)) url += '&width=1&height=1'
    if (!/[?&]bbox=/i.test(url)) url += `&bbox=${forecast.options?.probeBbox || WORLD_BBOX_3857}`
    return url
}

const urlTemplateForecastType = {
    name: 'url-template',

    prepareLayer(call) {
        showStepNumber(call, 1)
    },

    showStep(call) {
        showStepNumber(call, call.step + 1)
    },

    findAvailableSteps({ name, layer, forecast, run, engine }) {
        const url = probeUrl(layer, forecast, run)
        if (!url) return Promise.resolve(null)
        engine.debug('wms GetMap', name, url)
        return fetch(url, engine.fetchOptions()).then((r) => {
            const type = (r.headers.get('content-type') || '').toLowerCase()
            return r.ok && type.startsWith('image/') ? null : new Set()
        })
    },
}

export default urlTemplateForecastType

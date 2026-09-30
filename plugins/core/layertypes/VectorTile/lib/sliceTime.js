import { utcFormat } from 'd3-time-format'
import L_ from '@basics/Layers_/Layers_'
import TimeControl from '@basics/TimeControl_/TimeControl'

const DEFAULT_TIME_FORMAT = '%Y-%m-%dT%H:%M:%SZ'

const slicedGlobeLayers = {}
const appliedSliceUrls = {}
const latestSliceRequests = {}

function layerTimeFormat(layerObj) {
    const format = layerObj.time?.format
    return utcFormat(format == null || format === '' ? DEFAULT_TIME_FORMAT : format)
}

export function timeResolvedSliceUrl(layerObj, template, timeFormat) {
    const url = L_.getUrl(layerObj.type, template ?? layerObj.url, layerObj)
    if (layerObj.time?.enabled !== true) return url

    const format = timeFormat || layerTimeFormat(layerObj)
    const start = format(
        Date.parse(layerObj.time.start || TimeControl.getStartTime())
    )
    const end = format(Date.parse(layerObj.time.end || TimeControl.getEndTime()))

    return url
        .replace(/{starttime}/g, start)
        .replace(/{endtime}/g, end)
        .replace(/{time}/g, end)
}

export function registerSlicedGlobeLayer(layerName, slicedLayer) {
    slicedGlobeLayers[layerName] = slicedLayer
}

export function unregisterSlicedGlobeLayer(layerName, slicedLayer) {
    if (slicedGlobeLayers[layerName] === slicedLayer)
        delete slicedGlobeLayers[layerName]
}

export function slicedGlobeLayer(layerName) {
    return slicedGlobeLayers[layerName] || null
}

export function appliedSliceUrl(layerName) {
    return appliedSliceUrls[layerName] || null
}

export function setAppliedSliceUrl(layerName, url) {
    const previousUrl = appliedSliceUrls[layerName] || null
    appliedSliceUrls[layerName] = url
    return previousUrl
}

export function beginSliceRequest(layerName) {
    latestSliceRequests[layerName] = (latestSliceRequests[layerName] || 0) + 1
    return latestSliceRequests[layerName]
}

export function isLatestSliceRequest(layerName, request) {
    return latestSliceRequests[layerName] === request
}

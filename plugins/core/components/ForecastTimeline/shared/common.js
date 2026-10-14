/**
 * Shared constants and small utilities.
 */

export const STEP_UNITS = {
    hour: 3600000,
    day: 86400000,
    month: null, // variable length, see time.js
}

// Labels render in the viewer's browser zone (same as the LocalTimezone plugin).
export const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

export const PLAY_INTERVAL_MS = 700

// Delay before a re-check shows "Loading" (fast checks skip the flash).
export const PROBE_LOADING_DELAY_MS = 150

// How long a miss is trusted before asking the network again.
export const PROBE_MISS_TTL_MS = 60000

// The STAC `query` value restricting a per-run collection to one run, URL
// encoded. titiler-pgstac's tile endpoint and the STAC items endpoint both
// take it; neither honours a CQL2 `filter` on tiles.
export function runQueryParameter(runMs) {
    const runIso = new Date(runMs).toISOString().split('.')[0] + 'Z'
    return encodeURIComponent(
        JSON.stringify({ 'forecast:reference_datetime': { eq: runIso } })
    )
}

// The STAC API address of a layer's collection, or null if it can't be worked
// out. An external layer names its titiler-pgstac collection URL, whose /stac/
// twin serves the items. A local layer names only the collection, served by
// this MMGIS's own /stac.
export function stacCollectionUrl(ld) {
    const collectionReference = (ld?.url || '').replace(/^stac-collection:/i, '')
    if (!collectionReference) return null
    if (collectionReference.includes('/titilerpgstac/'))
        return collectionReference.replace('/titilerpgstac/', '/stac/')
    if (collectionReference.includes('/')) return null
    const collectionName = collectionReference.split('?')[0]
    const pathname = window.location.pathname.replace(/\/$/, '')
    return `${window.location.origin}${pathname}/stac/collections/${encodeURIComponent(collectionName)}`
}

// True when an hourly card declares the one UTC hour a day its model
// initializes (runHourUTC). Such cards are gated to that hour.
export function hasInitHour(fc) {
    return (
        (fc?.stepUnit || 'hour') === 'hour' &&
        Number.isFinite(fc?.runHourUTC)
    )
}

export function showWindow(fc) {
    return fc?.showWindow === true
}

export function isoSeconds(ms) {
    return new Date(ms).toISOString().split('.')[0] + 'Z'
}

export function escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

// For a value inside a quoted CSS attribute selector. Build from the RAW name.
export function escSel(s) {
    return String(s == null ? '' : s).replace(/["\\]/g, '\\$&')
}

// Call-time require avoids a circular import (the store's chain reaches TimeUI).
export function isMobile() {
    try {
        return require('@basics/UserInterface_/store/uiStore').default.getState().isMobile === true
    } catch (e) {
        return false
    }
}

// Resolve {time}/{endtime}/{starttime} tokens. start falls back to end.
export function resolveUrlTokens(u, end, start) {
    return String(u)
        .replace(/{time}/g, end)
        .replace(/{endtime}/g, end)
        .replace(/{starttime}/g, start != null ? start : end)
}

// Run tasks with a small concurrency cap so a 49-step run can't swamp the
// connection pool and stall the map's own tiles.
export function pooled(tasks, onDone, limit = 4) {
    return new Promise((resolve) => {
        if (!tasks.length) return resolve()
        let next = 0
        let active = 0
        let finished = 0
        const settle = () => {
            active--
            finished++
            if (onDone) onDone(finished, tasks.length)
            if (finished === tasks.length) resolve()
            else pump()
        }
        const runOne = () => {
            const task = tasks[next++]
            active++
            Promise.resolve().then(task).catch(() => {}).then(settle)
        }
        const pump = () => {
            while (active < limit && next < tasks.length) runOne()
        }
        pump()
    })
}

// Cache keys are `name:base`. Layer names routinely contain colons
// (e.g. "COG:https://…"), so the layer part ends at the LAST colon.
export function cacheKeyLayer(key) {
    return key.slice(0, key.lastIndexOf(':'))
}

export function invalidateCacheLayer(cache, name) {
    if (!cache) return
    Object.keys(cache).forEach((k) => {
        if (cacheKeyLayer(k) === name) delete cache[k]
    })
}

export function pruneCacheInactive(cache, activeNames) {
    if (!cache) return
    Object.keys(cache).forEach((k) => {
        if (!activeNames.has(cacheKeyLayer(k))) delete cache[k]
    })
}

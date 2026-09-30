/**
 * Shared constants, layer-kind predicates and small utilities.
 */

// ── Constants ──────────────────────────────────────────────

export const STEP_UNITS = {
    hour: 3600000,
    day: 86400000,
    month: null, // variable length, use time.js helpers, never a fixed ms
}

// Labels render through the viewer's browser zone (same space as the
// LocalTimezone plugin) so hours stay DST-correct on their own.
export const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

// fxx run-length defaults, following HRRR's schedule (every run reaches
// +18h, 00/06/12/18 UTC runs reach +48h). Another model overrides them in
// time.forecast via fxxMax, fxxMaxExtended and extendedRunHoursUTC.
export const FXX_MAX_DEFAULT = 18
export const FXX_MAX_EXTENDED_DEFAULT = 48
export const EXTENDED_RUN_HOURS_UTC_DEFAULT = [0, 6, 12, 18]

// Delay between playback frames.
export const PLAY_INTERVAL_MS = 700

// Delay before a probe re-check shows "Loading" (fast probes skip the flash).
export const PROBE_LOADING_DELAY_MS = 150

// How long a probe miss is trusted before re-probing over the network.
export const PROBE_MISS_TTL_MS = 60000

// ── Layer-kind predicates ──────────────────────────────────

// A layer opts into fxx stepping by carrying ?fxx= in its configured URL.
export function isFxxLayer(ld) {
    return /[?&]fxx=/i.test(ld?.url || '')
}

export function isFxxVelocity(ld) {
    return ld?.type === 'velocity' && isFxxLayer(ld)
}

export function isCogFxx(ld) {
    return (
        ld?.type === 'tile' &&
        (ld.url || '').toUpperCase().startsWith('COG:') &&
        isFxxLayer(ld)
    )
}

export function isStacForecast(ld) {
    return (
        ld?.sourceType === 'stac-collection' &&
        ld.time?.forecast?.enabled === true
    )
}

// True when a STAC forecast's collection holds every run's forecast rather
// than one forecast per hour (time.forecast.itemsPerRun): each item is stamped
// at its valid hour and tagged with its run (forecast:reference_datetime), and
// the card asks for the selected run's items only.
export function hasItemsPerRun(fc) {
    return fc?.itemsPerRun === true
}

// The STAC `query` value restricting a per-run collection to one run, URL
// encoded. titiler-pgstac's tile endpoint and the STAC items endpoint both
// take it; neither honours a CQL2 `filter` on tiles.
export function runQueryParameter(runMs) {
    const runIso = new Date(runMs).toISOString().split('.')[0] + 'Z'
    return encodeURIComponent(
        JSON.stringify({ 'forecast:reference_datetime': { eq: runIso } })
    )
}

// The STAC API address of a layer's collection, for availability probes, or
// null if it can't be worked out. An external layer names its titiler-pgstac
// collection URL, whose /stac/ twin serves the items. A local layer names only
// the collection, served by this MMGIS's own /stac, beside the /titilerpgstac
// the tiles come from (the same base core's transformStacUrl builds).
export function stacCollectionUrl(ld) {
    const collectionReference = (ld?.url || '').replace(/^stac-collection:/i, '')
    if (!collectionReference) return null
    if (collectionReference.includes('/titilerpgstac/'))
        return collectionReference.replace('/titilerpgstac/', '/stac/')
    // Any other URL or path isn't a collection we know how to ask about.
    if (collectionReference.includes('/')) return null
    const collectionName = collectionReference.split('?')[0]
    const pathname = window.location.pathname.replace(/\/$/, '')
    return `${window.location.origin}${pathname}/stac/collections/${encodeURIComponent(collectionName)}`
}

// True when an hourly card declares the one UTC hour a day its model
// initializes (runHourUTC). Such cards are gated to that hour, and their
// STAC items are stamped at VALID hours, not issue hours.
export function hasInitHour(fc) {
    return (
        (fc?.stepUnit || 'hour') === 'hour' &&
        Number.isFinite(fc?.runHourUTC)
    )
}

// True when a daily card should show per-step valid windows ("5 PM – 5 PM")
// instead of a plain UTC date. Opt in via showWindow: true in time.forecast.
export function showWindow(fc) {
    return fc?.showWindow === true
}

// ── Small shared utilities ─────────────────────────────────

// For HTML text nodes and double-quoted attribute values.
export function escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

// For a value inside a quoted CSS attribute selector. Build from the RAW name,
// not escHtml output; the DOM stores decoded values, so only " and \ matter.
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

// Set (or add) the ?fxx=N param on a URL.
export function setFxx(u, idx) {
    return /[?&]fxx=/i.test(u)
        ? u.replace(/([?&]fxx=)[^&]*/i, `$1${idx}`)
        : `${u}${u.indexOf('?') === -1 ? '?' : '&'}fxx=${idx}`
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

// ── Keyed-cache helpers ────────────────────────────────────
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

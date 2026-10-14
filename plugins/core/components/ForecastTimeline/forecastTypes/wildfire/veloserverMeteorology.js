/**
 * Wildfire mission forecast type `veloserver-meteorology`: veloserver's
 * forecast-hour weather products (HRRR COGs, HRRR and GFS winds).
 *
 * The layer URL carries ?fxx=N, the forecast hour. COG tiles rewrite fxx inside
 * titiler's url= source and refresh; velocity layers fetch the hour's gribjson
 * and setData in place. Step count follows the HRRR run schedule.
 *
 * Availability: for HRRR products, every hour's .idx sidecar in NOAA's public
 * bucket says whether the hour is published and carries the layer's field, so
 * missing hours render dark with a retry button. Hours are shared across every
 * HRRR card on the run. The bucket sends CORS headers on GET only, so no HEAD
 * and no custom headers beyond Range. A sweep that never reached the bucket
 * stands down for the session. Other products (GFS winds) get one check of
 * forecast hour 0.
 *
 * Options: fxxMax (18), fxxMaxExtended (48), extendedRunHoursUTC ([0,6,12,18]),
 * perHourAvailability (true), product (derived from the URL).
 */

import { PROBE_MISS_TTL_MS, pooled, resolveUrlTokens } from '../../shared/common'

export const FXX_MAX_DEFAULT = 18
export const FXX_MAX_EXTENDED_DEFAULT = 48
export const EXTENDED_RUN_HOURS_UTC_DEFAULT = [0, 6, 12, 18]

const IDX_HOST = 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com'

// The GRIB field each veloserver product is cut from (HRRR_PRODUCTS in its config.py).
export const PRODUCT_FIELDS = {
    winds: [':UGRD:10 m above ground:', ':VGRD:10 m above ground:'],
    temp_2m: [':TMP:2 m above ground:'],
    pbl_height: [':HPBL:surface:'],
    smoke_massden: [':MASSDEN:8 m above ground:'],
    rh_2m: [':RH:2 m above ground:'],
    wind_gust: [':GUST:surface:'],
    dewpoint_2m: [':DPT:2 m above ground:'],
}

// ── Stepping ───────────────────────────────────────────────

export function setFxx(u, idx) {
    return /[?&]fxx=/i.test(u)
        ? u.replace(/([?&]fxx=)[^&]*/i, `$1${idx}`)
        : `${u}${u.indexOf('?') === -1 ? '?' : '&'}fxx=${idx}`
}

export function isCog(layer) {
    return layer?.type === 'tile' && (layer.url || '').toUpperCase().startsWith('COG:')
}

export function isVelocity(layer) {
    return layer?.type === 'velocity'
}

export function runSchedule(forecast) {
    const options = forecast?.options || {}
    const hours = options.extendedRunHoursUTC ?? forecast?.extendedRunHoursUTC
    return {
        fxxMax: options.fxxMax ?? forecast?.fxxMax ?? FXX_MAX_DEFAULT,
        fxxMaxExtended: options.fxxMaxExtended ?? forecast?.fxxMaxExtended ?? FXX_MAX_EXTENDED_DEFAULT,
        // Configure's list field saves text ("0,6"), so compare as numbers.
        extendedRunHoursUTC: Array.isArray(hours) ? hours.map(Number) : EXTENDED_RUN_HOURS_UTC_DEFAULT,
    }
}

export function countSteps({ forecast, run }) {
    const schedule = runSchedule(forecast)
    const extended = schedule.extendedRunHoursUTC.includes(new Date(run).getUTCHours())
    return (extended ? schedule.fxxMaxExtended : schedule.fxxMax) + 1
}

const iso = (ms) => new Date(ms).toISOString()

function cogSource(layer, run, fxx) {
    return setFxx(resolveUrlTokens(layer.url.slice(4), iso(run)), fxx)
}

function velocitySource(layer, run, fxx) {
    return setFxx(resolveUrlTokens(layer.url, iso(run)), fxx)
}

// The titiler the MAP uses, read off the built layer's tile template.
function titilerBase(mapLayer) {
    const m = /^(.*\/titiler)\/cog\//.exec(mapLayer?._url || '')
    if (m) return m[1]
    const path = (window.location.pathname || '').replace(/\/$/g, '')
    return `${window.location.origin}${path}/titiler`
}

const visited = new Set()
const frames = {}

function frameKey(name, run) {
    return `${name}:${run}`
}

function showCogStep({ name, layer, mapLayer, run, step, engine }) {
    layer.url = setFxx(layer.url, step)
    if (!mapLayer || typeof mapLayer._url !== 'string') return
    // fxx must change INSIDE the titiler url= source; veloserver drops a
    // sibling fxx and serves the analysis hour instead.
    const newUrl = mapLayer._url.replace(
        /([?&]url=)([^&]*)/i,
        (_m, pre, src) => pre + setFxx(src, step)
    )
    if (newUrl === mapLayer._url) return
    const key = `${name}:${run}:${step}`
    if (!visited.has(key)) {
        visited.add(key)
        if (!engine.playing) engine.setTickLoading(step, true, 2500)
    }
    mapLayer.refresh(newUrl, true)
}

function showVelocityStep({ name, layer, mapLayer, run, step, engine }) {
    layer.url = setFxx(layer.url, step)
    const canSetData =
        mapLayer &&
        typeof mapLayer.setData === 'function' &&
        /^https?:\/\//i.test(layer.url) &&
        layer.time?.end
    if (!canSetData) {
        engine.reloadLayer(layer)
        return
    }
    const cached = frames[frameKey(name, run)]?.[step]
    if (cached) {
        mapLayer.setData(cached)
        if (step === 0) engine.markRunPresent()
        return
    }
    const fetchUrl = resolveUrlTokens(layer.url, layer.time.end, layer.time.start)
    engine.setTickLoading(step, true)
    fetch(fetchUrl)
        .then((r) => {
            if (!r.ok) throw new Error(r.status)
            return r.json()
        })
        .then((data) => {
            engine.setTickLoading(step, false)
            mapLayer.setData(data)
            const fk = frameKey(name, run)
            if (!frames[fk]) frames[fk] = {}
            frames[fk][step] = data
            engine.markRunPresent()
        })
        .catch((e) => {
            engine.setTickLoading(step, false)
            console.warn('[ForecastTimeline] velocity fxx update failed', e)
            engine.failCard()
        })
}

// Viewport tile coords, capped so zoomed-out views can't fan out.
function visibleTileCoords(mapLayer) {
    const map = mapLayer?._map
    if (!map || typeof mapLayer.getTileUrl !== 'function') return []
    const z = Math.round(map.getZoom())
    const size = mapLayer.getTileSize ? mapLayer.getTileSize().x : 256
    const b = map.getBounds()
    const nw = map.project(b.getNorthWest(), z).divideBy(size).floor()
    const se = map.project(b.getSouthEast(), z).divideBy(size).floor()
    const coords = []
    for (let x = nw.x; x <= se.x; x++) {
        for (let y = nw.y; y <= se.y; y++) {
            coords.push({ x, y, z })
            if (coords.length >= 48) return coords
        }
    }
    return coords
}

// One witness: forecast hour 0. COG asks titiler /cog/info, velocity HEADs the
// gribjson. Present → null (no verdict on single hours).
function probeHourZero({ name, layer, mapLayer, run, engine }) {
    let url = null
    let init
    if (isCog(layer)) {
        url = `${titilerBase(mapLayer)}/cog/info?url=${encodeURIComponent(cogSource(layer, run, 0))}`
    } else if (isVelocity(layer)) {
        url = velocitySource(layer, run, 0)
        init = { method: 'HEAD' }
    }
    if (!url) return Promise.resolve(null)
    return fetch(url, engine.fetchOptions(init))
        .then((r) => {
            engine.debug('probe fxx 0', name, r.status)
            return r.ok ? null : new Set()
        })
        .catch(() => new Set())
}

// ── NOAA index ─────────────────────────────────────────────

const p2 = (n) => String(n).padStart(2, '0')

export function gribUrl(runMs, fxx) {
    const d = new Date(runMs)
    const ymd = `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`
    return `${IDX_HOST}/hrrr.${ymd}/conus/hrrr.t${p2(d.getUTCHours())}z.wrfsfcf${p2(fxx)}.grib2`
}

export function idxUrl(runMs, fxx) {
    return `${gribUrl(runMs, fxx)}.idx`
}

// Which veloserver product a layer draws. Path-based on purpose: the GFS
// velocity layer sits next to the HRRR one and must not match.
export function hrrrProduct(layer, options) {
    if (options?.product) return options.product
    const url = layer?.url || ''
    if (isCog(layer)) {
        const m = /\/cog\/([^/?#]+)\//.exec(url)
        return m ? m[1] : null
    }
    if (isVelocity(layer) && /\/hrrr\/gribjson\//i.test(url)) return 'winds'
    return null
}

const idxCache = {}
const idxMissAt = {}
const idxPending = {}
const gribCache = {}
const gribMissAt = {}
const gribPending = {}
let broken = false

function indexEnabled(options) {
    if (broken) return false
    if (typeof window !== 'undefined' && window.FTL_HRRR_IDX === false) return false
    return options?.perHourAvailability !== false
}

export function fieldsFor(layer, options) {
    if (!indexEnabled(options)) return null
    return PRODUCT_FIELDS[hrrrProduct(layer, options)] || null
}

// Index text, or null when the hour is not published. Rejects only when the
// request never got an answer.
function fetchIdx(runMs, fxx, fetchOptions) {
    const key = `${runMs}:${fxx}`
    const hit = idxCache[key]
    if (hit) return Promise.resolve(hit)
    if (hit === null && Date.now() - idxMissAt[key] < PROBE_MISS_TTL_MS) return Promise.resolve(null)
    if (idxPending[key]) return idxPending[key]
    const p = fetch(idxUrl(runMs, fxx), fetchOptions())
        .then((r) => {
            if (!r.ok) {
                idxCache[key] = null
                idxMissAt[key] = Date.now()
                return null
            }
            return r.text().then((text) => {
                idxCache[key] = text
                delete idxMissAt[key]
                return text
            })
        })
        .finally(() => {
            delete idxPending[key]
        })
    idxPending[key] = p
    return p
}

// The sidecar can lag the GRIB it describes; one ranged byte of the GRIB
// settles whether the hour can be served.
function gribExists(runMs, fxx, fetchOptions) {
    const key = `${runMs}:${fxx}`
    const hit = gribCache[key]
    if (hit === true) return Promise.resolve(true)
    if (hit === false && Date.now() - gribMissAt[key] < PROBE_MISS_TTL_MS) return Promise.resolve(false)
    if (gribPending[key]) return gribPending[key]
    const p = fetch(gribUrl(runMs, fxx), fetchOptions({ headers: { Range: 'bytes=0-0' } }))
        .then((r) => {
            gribCache[key] = r.ok
            if (!r.ok) gribMissAt[key] = Date.now()
            return r.ok
        })
        .finally(() => {
            delete gribPending[key]
        })
    gribPending[key] = p
    return p
}

function hourUsable(runMs, fxx, fields, fetchOptions) {
    return fetchIdx(runMs, fxx, fetchOptions).then((text) =>
        text ? fields.every((f) => text.includes(f)) : gribExists(runMs, fxx, fetchOptions)
    )
}

function forgetMisses() {
    Object.keys(idxCache).forEach((k) => {
        if (idxCache[k] === null) {
            delete idxCache[k]
            delete idxMissAt[k]
        }
    })
    Object.keys(gribCache).forEach((k) => {
        if (gribCache[k] === false) {
            delete gribCache[k]
            delete gribMissAt[k]
        }
    })
}

// ── The forecast type ──────────────────────────────────────

const veloserverMeteorologyForecastType = {
    name: 'veloserver-meteorology',

    countSteps,

    showStep(call) {
        const { layer, isOn } = call
        if (!layer || !isOn) return
        if (isCog(layer)) showCogStep(call)
        else if (isVelocity(layer)) showVelocityStep(call)
    },

    // Which hours of the run carry the layer's field. A sweep with any hour
    // unanswered is no verdict, and the hour 0 probe answers instead.
    findAvailableSteps(call) {
        const { name, layer, options, run, steps, fresh, engine } = call
        const fields = fieldsFor(layer, options)
        if (!fields) return probeHourZero(call)
        if (fresh) forgetMisses()
        const hours = new Set()
        let unreached = 0
        const tasks = Array.from({ length: steps }, (_, n) => () =>
            hourUsable(run, n, fields, engine.fetchOptions).then(
                (usable) => {
                    if (usable) hours.add(n)
                },
                () => {
                    unreached++
                }
            )
        )
        return pooled(tasks).then(() => {
            if (unreached === steps) {
                broken = true
                engine.debug('idx sweep unreachable, falling back for the session', name)
            }
            engine.debug('idx sweep', name, { steps, present: [...hours], unreached })
            return unreached === 0 ? hours : probeHourZero(call)
        })
    },

    retryStep({ layer, options, run, step, engine }) {
        broken = false
        const fields = fieldsFor(layer, options)
        if (!fields) return Promise.resolve(false)
        const key = `${run}:${step}`
        delete idxCache[key]
        delete idxMissAt[key]
        delete gribCache[key]
        delete gribMissAt[key]
        return hourUsable(run, step, fields, engine.fetchOptions).catch(() => false)
    },

    prefetchStep({ name, layer, mapLayer, run, step }) {
        if (isVelocity(layer)) {
            const fk = frameKey(name, run)
            if (frames[fk]?.[step]) return Promise.resolve()
            const url = resolveUrlTokens(
                setFxx(layer.url, step),
                layer.time?.end || iso(Date.now()),
                layer.time?.start
            )
            return fetch(url)
                .then((r) => {
                    if (!r.ok) throw new Error(r.status)
                    return r.json()
                })
                .then((data) => {
                    if (!frames[fk]) frames[fk] = {}
                    frames[fk][step] = data
                })
        }
        if (isCog(layer)) {
            const coords = visibleTileCoords(mapLayer)
            return Promise.all(
                coords.map((c) => {
                    let u
                    try {
                        u = mapLayer.getTileUrl(c)
                    } catch (e) {
                        return null
                    }
                    if (typeof u !== 'string') return null
                    return fetch(setFxx(u, step), { mode: 'no-cors' }).catch(() => {})
                })
            )
        }
        return Promise.resolve()
    },
}

export default veloserverMeteorologyForecastType

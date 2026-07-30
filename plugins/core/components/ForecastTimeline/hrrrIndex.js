/**
 * PROTOTYPE. Per-forecast-hour availability for HRRR cards, read from NOAA's
 * GRIB index files.
 *
 * availability.js answers "is this run out?" with one probe at forecast hour 0,
 * on the assumption that HRRR publishes a run's hours together. It does not:
 * hours arrive one at a time, so a card can read available while most of its
 * ticks 404, or read unavailable because hour 0 alone is missing or does not
 * carry the card's field.
 *
 * Every HRRR GRIB has a small .idx sidecar next to it in NOAA's public bucket,
 * listing every field in that file. Reading it answers both questions for one
 * hour, is it published and is this card's field in it, without downloading a
 * GRIB or making veloserver build a COG. One plain GET, about 9 KB. HEAD is not
 * an option: the bucket sends CORS headers on GET only, which is also why the
 * request must carry no custom headers.
 *
 * Every product lives in the same wrfsfc file, so one hour's index answers for
 * every card on the run. _idxCache is keyed by run and hour with no layer in
 * the key, which is what keeps a ten-card mission at 19 requests instead of 190.
 *
 * Opt in per mission with the perHourAvailability component variable; without
 * it the older fxx 0 probe answers, unchanged. A sweep whose requests never
 * reached the bucket also stands down on its own, since a blocked fetch is not
 * an answer about the run. A dark hour's retry button clears both.
 */

import L_ from '@basics/Layers_/Layers_'

import {
    PROBE_MISS_TTL_MS,
    isCogFxx,
    isFxxVelocity,
    pooled,
} from './common'

// NOAA's public HRRR bucket.
const IDX_HOST = 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com'

// The GRIB field each veloserver COG product is cut from, mirroring
// HRRR_PRODUCTS in the server's config.py. One table so a product added on one
// side and not the other is visible in a single place.
const PRODUCT_FIELDS = {
    winds: [':UGRD:10 m above ground:', ':VGRD:10 m above ground:'],
    temp_2m: [':TMP:2 m above ground:'],
    pbl_height: [':HPBL:surface:'],
    smoke_massden: [':MASSDEN:8 m above ground:'],
    precip_rate: [':PRATE:surface:'],
    rh_2m: [':RH:2 m above ground:'],
    wind_gust: [':GUST:surface:'],
    dewpoint_2m: [':DPT:2 m above ground:'],
}

const p2 = (n) => String(n).padStart(2, '0')

// The sfc file, matching veloserver's own download: _download_hrrr_native
// passes no product, so Herbie uses its 'sfc' default.
function gribUrl(baseMs, fxx) {
    const d = new Date(baseMs)
    const ymd = `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`
    return (
        `${IDX_HOST}/hrrr.${ymd}/conus/` +
        `hrrr.t${p2(d.getUTCHours())}z.wrfsfcf${p2(fxx)}.grib2`
    )
}

function idxUrl(baseMs, fxx) {
    return `${gribUrl(baseMs, fxx)}.idx`
}

// Which veloserver product a layer draws, by URL path. Path-based on purpose:
// the GFS velocity layer sits next to the HRRR one and must not match.
function hrrrProduct(ld) {
    const url = ld?.url || ''
    if (isCogFxx(ld)) {
        const m = /\/cog\/([^/?#]+)\//.exec(url)
        return m ? m[1] : null
    }
    if (isFxxVelocity(ld) && /\/hrrr\/gribjson\//i.test(url)) return 'winds'
    return null
}

const hrrrIndexMethods = {
    // Raw index text per run hour, keyed `base:fxx` with NO layer part, so all
    // cards on a run share one fetch. null means a definitive 404.
    _idxCache: {},
    _idxMissAt: {},
    _idxPending: {},

    // Whether the GRIB itself is there, keyed the same way. Only consulted when
    // the index is missing, so it stays empty on a healthy run.
    _gribCache: {},
    _gribMissAt: {},
    _gribPending: {},

    // Per-card resolved hours, keyed `name:base`.
    // { hours: Set|null, at: ms, pending: bool, promise }
    _idxSweep: {},

    // Set once when a whole sweep failed to reach the bucket at all.
    _idxBroken: false,

    // Opt in per mission through the component's config page, the same way
    // experimentalPlayback works. window.FTL_HRRR_IDX = false is a runtime
    // override for debugging without touching the mission config.
    _idxEnabled: function () {
        if (this._idxBroken) return false
        if (typeof window !== 'undefined' && window.FTL_HRRR_IDX === false)
            return false
        return this.vars?.perHourAvailability === true
    },

    // The fields a card needs, or null when the index doesn't apply to it (not
    // an HRRR fxx layer, unknown product, or the sweep is off). Null is the
    // signal everywhere in here that the old probe should answer instead.
    _hrrrIdxFields: function (name) {
        if (!this._idxEnabled()) return null
        return PRODUCT_FIELDS[hrrrProduct(L_.layers.data[name])] || null
    },

    // One hour's index. Resolves the text, or null when the hour is not
    // published. REJECTS only when the request never got an answer, which the
    // sweep treats as "no verdict" rather than "not published".
    _fetchIdx: function (baseMs, fxx) {
        const key = `${baseMs}:${fxx}`
        const hit = this._idxCache[key]
        if (hit) return Promise.resolve(hit)
        // A published hour never unpublishes, so a hit is kept for the session
        // and only misses carry a TTL.
        if (hit === null && Date.now() - this._idxMissAt[key] < PROBE_MISS_TTL_MS)
            return Promise.resolve(null)
        if (this._idxPending[key]) return this._idxPending[key]

        const p = fetch(idxUrl(baseMs, fxx), this._probeFetchOpts())
            .then((r) => {
                if (!r.ok) {
                    this._idxCache[key] = null
                    this._idxMissAt[key] = Date.now()
                    return null
                }
                return r.text().then((text) => {
                    this._idxCache[key] = text
                    delete this._idxMissAt[key]
                    return text
                })
            })
            .finally(() => {
                delete this._idxPending[key]
            })
        this._idxPending[key] = p
        return p
    },

    // Is the GRIB for this hour there? One byte is enough to answer, and the
    // bucket allows a ranged GET from the browser (its CORS preflight lists
    // the range header). This is the file veloserver downloads, so it is the
    // real definition of "can this hour be served".
    _gribExists: function (baseMs, fxx) {
        const key = `${baseMs}:${fxx}`
        const hit = this._gribCache[key]
        if (hit === true) return Promise.resolve(true)
        if (hit === false && Date.now() - this._gribMissAt[key] < PROBE_MISS_TTL_MS)
            return Promise.resolve(false)
        if (this._gribPending[key]) return this._gribPending[key]

        const p = fetch(
            gribUrl(baseMs, fxx),
            this._probeFetchOpts({ headers: { Range: 'bytes=0-0' } })
        )
            .then((r) => {
                this._gribCache[key] = r.ok
                if (!r.ok) this._gribMissAt[key] = Date.now()
                this._dbg('probe grib', 'fxx=' + fxx, r.status)
                return r.ok
            })
            .finally(() => {
                delete this._gribPending[key]
            })
        this._gribPending[key] = p
        return p
    },

    // Can this hour be served? The index answers both questions at once when
    // it is there: the hour exists AND it carries the card's field. When it is
    // not there the hour is not necessarily missing, because the sidecar can
    // lag the data file it describes, so fall back to asking the GRIB. Being
    // wrong the other way would darken an hour veloserver can serve.
    _hourUsable: function (baseMs, fxx, fields) {
        return this._fetchIdx(baseMs, fxx).then((text) =>
            text ? fields.every((f) => text.includes(f)) : this._gribExists(baseMs, fxx)
        )
    },

    // Which forecast hours of this run carry the card's field. One pass per
    // card per run; the hour fetches underneath are shared with every other
    // card, and hours already known present are never re-asked.
    // Resolves a Set, or null when the index has no verdict.
    _resolveFxxPresence: function (name, fc) {
        const fields = this._hrrrIdxFields(name)
        if (!fields) return Promise.resolve(null)

        const base = this._forecastBase(fc)
        const key = `${name}:${base}`
        const rec = this._idxSweep[key]
        if (rec?.promise) return rec.promise
        if (rec && !rec.pending && Date.now() - rec.at < PROBE_MISS_TTL_MS)
            return Promise.resolve(rec.hours)

        const steps = this._effectiveSteps(fc, name)
        const hours = new Set()
        let unreached = 0
        const tasks = Array.from({ length: steps }, (_, n) => () =>
            this._hourUsable(base, n, fields).then(
                (usable) => {
                    if (usable) hours.add(n)
                },
                () => {
                    unreached++
                }
            )
        )

        const promise = pooled(tasks).then(() => {
            // Nothing got through: the bucket is unreachable from here, so stop
            // asking for the rest of the session and let the probe answer.
            if (unreached === steps) {
                this._idxBroken = true
                this._dbg('idx sweep unreachable, falling back for the session', name)
            }
            // A partial failure is an incomplete strip, which would darken
            // ticks that are really there. No verdict; the TTL retries it.
            const hoursOut = unreached === 0 ? hours : null
            this._idxSweep[key] = { hours: hoursOut, at: Date.now(), pending: false }
            this._dbg('idx sweep', name, {
                steps,
                present: hoursOut ? [...hoursOut] : null,
                unreached,
            })
            this._refreshAllCards()
            return hoursOut
        })

        this._idxSweep[key] = {
            hours: rec ? rec.hours : null,
            at: Date.now(),
            pending: true,
            promise,
        }
        // The record must not keep a settled promise, or the TTL never applies.
        promise.finally(() => {
            const cur = this._idxSweep[key]
            if (cur?.promise === promise) delete cur.promise
        })
        return promise
    },

    // Run verdict: present when ANY hour of the run carries the field. This is
    // the fxx 0 assumption dropped, so a run whose analysis hour is missing or
    // field-less still reads as the real run it is.
    // null = no verdict, availability.js falls back to its own probe.
    _idxRunPresent: function (name, fc) {
        return this._resolveFxxPresence(name, fc).then((hours) =>
            hours === null ? null : hours.size > 0
        )
    },

    // True when a tick's forecast hour holds nothing for this card. Fails open
    // on every uncertainty, so a missing verdict never darkens a live tick.
    _fxxMissingStep: function (name, fc, idx) {
        if (!fc) return false
        const rec = this._idxSweep?.[`${name}:${this._forecastBase(fc)}`]
        if (!rec?.hours) return false
        return !rec.hours.has(idx)
    },

    // The one "this tick has no data" test. STAC cards answer from their own
    // presence sweep, HRRR fxx cards from the index sweep, everything else no.
    _missingStep: function (name, fc, idx) {
        return (
            this._stacMissingStep(name, fc, idx) ||
            this._fxxMissingStep(name, fc, idx)
        )
    },

    // True once this card's per-step presence is settled. Until then ticks
    // render skeleton rather than active, to avoid a blue flash on hours that
    // turn out to be missing.
    _presenceReady: function (name, fc) {
        if (!this._stacPresenceReady(name, fc)) return false
        if (!this._hrrrIdxFields(name)) return true
        const rec = this._idxSweep?.[`${name}:${this._forecastBase(fc)}`]
        return !!rec && !rec.pending
    },

    // Ask NOAA again about one forecast hour, behind a dark tick's retry button.
    // Drops what we remember about that hour first, so the request really goes
    // out, and clears the session giveup: a user pressing retry is asking us to
    // try everything again. Resolves true when the hour is now usable.
    _retryFxxStep: function (name, fc, idx) {
        this._idxBroken = false
        const fields = this._hrrrIdxFields(name)
        if (!fields) return Promise.resolve(false)

        const base = this._forecastBase(fc)
        const hourKey = `${base}:${idx}`
        delete this._idxCache[hourKey]
        delete this._idxMissAt[hourKey]
        delete this._gribCache[hourKey]
        delete this._gribMissAt[hourKey]
        this._setTickLoading(name, idx, true)

        return this._hourUsable(base, idx, fields)
            .catch(() => false)
            .then((present) => {
                const rec = this._idxSweep?.[`${name}:${base}`]
                if (rec?.hours) {
                    if (present) rec.hours.add(idx)
                    else rec.hours.delete(idx)
                }
                this._setTickLoading(name, idx, false)
                this._dbg('idx retry', name, { fxx: idx, present })
                // One hour is enough for the run to exist, so a card still
                // saying "run not yet generated" has to come back on.
                if (present) this._applyRunPresent(name, true)
                this._refreshAllCards()
                return present
            })
    },

    // Drop remembered 404s so a layer toggle is a real retry (patches.js).
    // Present hours are facts and stay.
    _forgetIdxMisses: function () {
        Object.keys(this._idxCache || {}).forEach((k) => {
            if (this._idxCache[k] === null) {
                delete this._idxCache[k]
                delete this._idxMissAt[k]
            }
        })
        Object.keys(this._gribCache || {}).forEach((k) => {
            if (this._gribCache[k] === false) {
                delete this._gribCache[k]
                delete this._gribMissAt[k]
            }
        })
    },
}

export default hrrrIndexMethods

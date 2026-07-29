/**
 * Availability. One probe engine, one cache, one verdict flow.
 *
 * A run is either out or it is not; one probe per model run answers for every
 * step. Per kind: COG fxx asks titiler /cog/info at fxx 0, velocity HEADs the
 * gribjson, WMS __FSTEP__ template layers issue a 1x1 GetMap of step 1, and
 * STAC asks the items endpoint.
 * Probes hit the same services the map renders through, never the Leaflet
 * tiles (the tile pipeline hides failures behind transparent PNGs).
 *
 * Caching, keyed name:base. Present is kept all session (a published run
 * does not unpublish). Missing is kept for PROBE_MISS_TTL_MS, then re-probed
 * until the run appears. A layer toggle off/on clears its misses (patches.js).
 * Two safety rules: evidence beats the probe (data that loaded proves the run
 * exists), and STAC probes fail open (only a definitive 200 with no features
 * counts as missing).
 */

import L_ from '@basics/Layers_/Layers_'

import {
    PROBE_LOADING_DELAY_MS,
    PROBE_MISS_TTL_MS,
    hasInitHour,
    isFxxLayer,
    isFxxVelocity,
    isStacForecast,
    setFxx,
    resolveUrlTokens,
} from './common'
import { periodBounds, stepTime } from './time'

const availabilityMethods = {
    // Run cache keyed `name:base`. 1 = present (kept all session), 'pending',
    // or a negative timestamp = recent miss (trusted for PROBE_MISS_TTL_MS).
    _edgeCache: {},

    // Pending "Loading" debounce timers, keyed by layer name.
    _probeLoadingTimers: {},

    // Set window.FTL_DEBUG = true to trace the whole availability chain.
    _dbg: function (...args) {
        if (typeof window !== 'undefined' && window.FTL_DEBUG) {
            console.log('[FTL]', ...args)
        }
    },

    _probeFetchOpts: function (extra) {
        const opts = { cache: 'no-store', ...extra }
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
            opts.signal = AbortSignal.timeout(20000)
        }
        return opts
    },

    // Check each visible card's run, once per forecast base.
    _probeAllAnchors: function () {
        if (!this._edgeCache) this._edgeCache = {}
        this._detectForecastLayers().forEach(({ name, config: fc }) => {
            // Not the model's init hour: no run exists to probe. Render the
            // "Model not initialized" card and skip the network entirely.
            if (this._initHourMismatch(fc)) {
                this._cancelLoading(name)
                this._setCardState(name, 'uninitialized')
                return
            }
            if (isStacForecast(L_.layers.data[name]))
                this._resolveStacPresence(name, fc)
            const base = this._forecastBase(fc)
            const key = `${name}:${base}`
            const cached = this._edgeCache[key]

            if (cached === 1) {
                this._dbg('run (cache hit)', name, { key, present: true })
                this._applyRunPresent(name, true)
                return
            }
            // A cached miss only KEEPS an already-unavailable card steady
            // (anti-flicker). A fresh or available card always re-probes, so a
            // stale miss never blanks a card whose tiles are loading fine.
            const cardStateNow = this.state.cards[name]?.cardState
            if (
                typeof cached === 'number' &&
                cached < 0 &&
                Date.now() + cached < PROBE_MISS_TTL_MS &&
                (cardStateNow === 'unavailable' || cardStateNow === 'failed')
            ) {
                this._dbg('run (miss cache hit)', name, { key, present: false })
                this._applyRunPresent(name, false)
                return
            }
            if (cached === 'pending') return

            this._edgeCache[key] = 'pending'
            if (this.state.cards[name]?.cardState === 'unavailable') {
                // Debounce the flip to "Loading" so a fast re-check doesn't flash.
                this._scheduleLoading(name)
            } else {
                this._setCardState(name, 'loading')
            }

            const baseAtFire = base
            const stillCurrent = () => this._forecastBase(fc) === baseAtFire

            const commit = (ok) => {
                this._cancelLoading(name)
                const cs = this.state.cards[name]
                // Evidence beats the probe: data that actually loaded proves
                // the run exists, whatever a slower failed probe says.
                if (!ok && cs?.evidenceBase === baseAtFire) {
                    this._dbg('probe failed but data evidence wins', name, { key })
                    ok = true
                }
                if (ok) this._edgeCache[key] = 1
                else this._edgeCache[key] = -Date.now()
                this._dbg('run RESULT', name, { key, present: ok, applied: stillCurrent() })
                if (stillCurrent()) this._applyRunPresent(name, ok)
            }

            this._dbg('run RESOLVE', name, { key, base: new Date(base).toISOString() })
            this._resolveRunPresent(name, fc)
                .then(commit)
                .catch((e) => {
                    // A thrown probe is a network failure, the case the card
                    // exists to report. Fail closed.
                    this._dbg('run ERROR', name, e)
                    commit(false)
                })
        })
    },

    // Show "Loading" after a short delay unless the probe resolves first.
    _scheduleLoading: function (name) {
        if (!this._probeLoadingTimers) this._probeLoadingTimers = {}
        if (this._probeLoadingTimers[name]) return
        this._probeLoadingTimers[name] = setTimeout(() => {
            delete this._probeLoadingTimers[name]
            this._setCardState(name, 'loading')
        }, PROBE_LOADING_DELAY_MS)
    },

    _cancelLoading: function (name) {
        const t = this._probeLoadingTimers?.[name]
        if (t) {
            clearTimeout(t)
            delete this._probeLoadingTimers[name]
        }
    },

    // Route the run check to the right probe for this layer's kind.
    _resolveRunPresent: function (name, fc) {
        if (fc.urlTemplate) {
            return this._probeWmsTime(name, fc).then((v) => v === 'available')
        }
        const ld = L_.layers.data[name]
        if (isStacForecast(ld)) {
            // An init-hour run has no item at the init instant itself; its
            // first valid hour answers for the run.
            const base = this._forecastBase(fc)
            return this._probeStacStepPresent(
                name,
                hasInitHour(fc) ? stepTime(fc, 0, base) : base
            )
        }
        if (!isFxxLayer(ld)) return Promise.resolve(true)
        return this._probeFxx(name, fc, 0)
    },

    // Turn a run verdict into card state.
    _applyRunPresent: function (name, present) {
        const cs = this.state.cards[name]
        if (!cs) return
        // A probe launched at the init hour can resolve after the timeline
        // left it; the pinned base can't change, so stillCurrent won't catch
        // it. The mismatch state wins over a stale verdict.
        const fcNow = L_.layers.data[name]?.time?.forecast
        if (fcNow && this._initHourMismatch(fcNow)) {
            this._setCardState(name, 'uninitialized')
            return
        }
        // A STAC card stepped off its base period is governed by that step's
        // own probe; don't overwrite its state from the anchor verdict.
        if (isStacForecast(L_.layers.data[name]) && (cs.stepIndex ?? 0) !== 0)
            return
        const wasDisabled =
            cs.cardState === 'unavailable' || cs.cardState === 'failed'
        if (!present) {
            const fc = L_.layers.data[name]?.time?.forecast
            const failed =
                cs.failedBase != null &&
                fc != null &&
                cs.failedBase === this._forecastBase(fc)
            this._setCardState(name, failed ? 'failed' : 'unavailable')
        } else {
            this._setCardState(name, 'available')
            // Re-apply the step so a card the check had blanked recovers.
            if (wasDisabled) this._reapplyAllSteps()
        }
    },

    // A step's data loaded: direct proof this run exists.
    _markRunPresent: function (name, fc) {
        const cs = this.state.cards[name]
        if (!cs) return
        const base = this._forecastBase(fc)
        cs.evidenceBase = base
        cs.failedBase = null
        this._edgeCache[`${name}:${base}`] = 1
        if (cs.cardState !== 'available') this._applyRunPresent(name, true)
    },

    // A step fetch failed although the run probed present (services briefly
    // desynced). Show the distinct "Forecast not available" state; don't cache
    // the miss so the next probe can recover the card on its own.
    _failCard: function (name, fc) {
        const cs = this.state.cards[name]
        if (!cs) return
        const base = this._forecastBase(fc)
        cs.failedBase = base
        delete this._edgeCache[`${name}:${base}`]
        this._applyRunPresent(name, false)
    },

    // ── The probes themselves ──────────────────────────────

    // Does forecast hour n exist? COG asks titiler /cog/info; velocity HEADs
    // the gribjson.
    _probeFxx: function (name, fc, n) {
        const ld = L_.layers.data[name]
        const url = ld?.url || ''

        if (url.toUpperCase().startsWith('COG:')) {
            const info = this._cogInfoUrl(name, fc, n)
            if (!info) return Promise.resolve(true)
            return fetch(info, this._probeFetchOpts())
                .then((r) => {
                    this._dbg('probe cog/info', name, 'fxx=' + n, r.status)
                    return r.ok
                })
                .catch(() => false)
        }

        if (isFxxVelocity(ld)) {
            const src = this._velocitySourceForFxx(ld, fc, n)
            if (!src) return Promise.resolve(true)
            return fetch(src, this._probeFetchOpts({ method: 'HEAD' }))
                .then((r) => {
                    this._dbg('probe velocity HEAD', name, 'fxx=' + n, r.status)
                    return r.ok
                })
                .catch(() => false)
        }

        return Promise.resolve(true)
    },

    // Does the STAC collection hold an item in the period containing ms?
    // Uses the items endpoint (limit=1) so the answer matches the mosaic.
    _probeStacStepPresent: function (name, ms) {
        const ld = L_.layers.data[name]
        // Strip the stac-collection: protocol prefix or fetch() rejects the URL.
        const tilerUrl = (ld?.url || '').replace(/^stac-collection:/i, '')
        const stacUrl = tilerUrl.replace('/titilerpgstac/', '/stac/')
        if (!stacUrl || stacUrl === tilerUrl) return Promise.resolve(true)
        const unit = ld.time?.forecast?.stepUnit || 'hour'
        const [startMs, nextMs] = periodBounds(unit, ms)
        const endMs = nextMs - 1000
        if (!this._stacStepCache) this._stacStepCache = {}
        if (!this._stacStepMiss) this._stacStepMiss = {}
        const key = `${name}:${startMs}`
        if (this._stacStepCache[key]) return Promise.resolve(true)
        const missAt = this._stacStepMiss[key]
        if (missAt != null && Date.now() - missAt < PROBE_MISS_TTL_MS)
            return Promise.resolve(false)
        const iso = (t) => new Date(t).toISOString().split('.')[0] + 'Z'
        const url = `${stacUrl}/items?limit=1&datetime=${iso(startMs)}/${iso(endMs)}`
        this._dbg('probe STAC step', name, url)
        return fetch(url, this._probeFetchOpts())
            .then((r) => {
                if (!r.ok) throw new Error(r.status)
                return r.json()
            })
            .then((j) => {
                const present = (j?.features?.length || 0) > 0
                if (present) {
                    this._stacStepCache[key] = true
                    delete this._stacStepMiss[key]
                } else {
                    this._stacStepMiss[key] = Date.now()
                }
                return present
            })
            .catch((e) => {
                // Fail OPEN: only a definitive 200 with no features means
                // missing. A broken items API must not blank a working card.
                this._dbg('probe STAC step ERROR (failing open)', name, e)
                return true
            })
    },

    // Which of a STAC card's periods have items, in ONE spanning request.
    // Missing steps render dark per tick; present steps stay live.
    _resolveStacPresence: function (name, fc) {
        const ld = L_.layers.data[name]
        if (!isStacForecast(ld)) return
        if (!this._stacPresence) this._stacPresence = {}
        const base = this._forecastBase(fc)
        const key = `${name}:${base}`
        const rec = this._stacPresence[key]
        if (rec && (rec.pending || Date.now() - rec.at < PROBE_MISS_TTL_MS))
            return
        const tilerUrl = (ld.url || '').replace(/^stac-collection:/i, '')
        const stacUrl = tilerUrl.replace('/titilerpgstac/', '/stac/')
        if (!stacUrl || stacUrl === tilerUrl) return
        const unit = fc.stepUnit || 'hour'
        const steps = this._effectiveSteps(fc, name)
        const first = this._stacQueryPeriodStart(fc, 0, base)
        const lastStart = this._stacQueryPeriodStart(fc, steps - 1, base)
        const endMs = periodBounds(unit, lastStart)[1] - 1000
        const iso = (ms) => new Date(ms).toISOString().split('.')[0] + 'Z'
        const url = `${stacUrl}/items?limit=200&datetime=${iso(first)}/${iso(endMs)}`
        this._stacPresence[key] = {
            present: rec ? rec.present : null,
            at: Date.now(),
            pending: true,
        }
        this._dbg('resolve STAC presence', name, url)
        fetch(url, this._probeFetchOpts())
            .then((r) => {
                if (!r.ok) throw new Error(r.status)
                return r.json()
            })
            .then((j) => {
                const present = new Set()
                for (const f of j?.features || []) {
                    const t = Date.parse(f?.properties?.datetime)
                    if (!isNaN(t)) present.add(periodBounds(unit, t)[0])
                }
                this._stacPresence[key] = { present, at: Date.now() }
                this._refreshAllCards()
            })
            .catch((e) => {
                // Fail open: a null presence set means no per-tick darkening.
                this._dbg('resolve STAC presence ERROR', name, e)
                const cur = this._stacPresence[key]
                if (cur) cur.pending = false
            })
    },

    // The period a tick's QUERY targets: its own month for monthly cards,
    // its own VALID hour for init-hour cards (their items are stamped at
    // valid hours), the issue period (one step earlier) for the rest.
    _stacQueryPeriodStart: function (fc, idx, base) {
        if ((fc.stepUnit || 'hour') === 'month') return stepTime(fc, idx, base)
        return stepTime(fc, hasInitHour(fc) ? idx : idx - 1, base)
    },

    // True once this base's presence sweep resolved (always true for non-STAC).
    // Until then ticks render skeleton, never active, to avoid a blue flash.
    _stacPresenceReady: function (name, fc) {
        const ld = L_.layers.data[name]
        if (!isStacForecast(ld)) return true
        const rec = this._stacPresence?.[`${name}:${this._forecastBase(fc)}`]
        return !!rec?.present
    },

    // True when a STAC tick targets a period with no item. Fails open.
    _stacMissingStep: function (name, fc, idx) {
        if (!fc) return false
        const base = this._forecastBase(fc)
        const rec = this._stacPresence?.[`${name}:${base}`]
        if (!rec || !rec.present) return false
        return !rec.present.has(this._stacQueryPeriodStart(fc, idx, base))
    },

    // WMS availability: a real 1x1 GetMap judged by CONTENT TYPE. GeoServer
    // answers a missing TIME with HTTP 200 + an XML exception body, so only
    // an image content type means the run is there.
    _probeWmsTime: function (name, fc) {
        const url = this._wmsProbeUrl(name, fc)
        if (!url) return Promise.resolve('available')

        this._dbg('probe WMS GetMap', name, url)
        return fetch(url, this._probeFetchOpts()).then((r) => {
            const ct = (r.headers.get('content-type') || '').toLowerCase()
            const verdict = r.ok && ct.startsWith('image/') ? 'available' : 'unavailable'
            this._dbg('probe WMS ->', verdict, name, r.status, ct)
            return verdict
        })
    },

    // ── Probe URL builders ─────────────────────────────────

    // The titiler base the MAP uses, read off the built layer's tile template,
    // so we probe the exact host the map renders through.
    _titilerBase: function (name) {
        const layer = L_.layers.layer[name]
        const m = /^(.*\/titiler)\/cog\//.exec(layer?._url || '')
        if (m) return m[1]
        const origin = window.location.origin
        const path = (window.location.pathname || '').replace(/\/$/g, '')
        return `${origin}${path}/titiler`
    },

    _cogInfoUrl: function (name, fc, n) {
        const ld = L_.layers.data[name]
        const url = ld?.url || ''
        if (!url.toUpperCase().startsWith('COG:')) return null
        const timeStr = new Date(this._forecastBase(fc)).toISOString()
        const src = setFxx(resolveUrlTokens(url.slice(4), timeStr), n)
        return `${this._titilerBase(name)}/cog/info?url=${encodeURIComponent(src)}`
    },

    // {time} resolves to the RUN this card is anchored to, never ld.time.end,
    // which can be empty or point at a different instant at probe time.
    _velocitySourceForFxx: function (ld, fc, n) {
        const timeStr = new Date(this._forecastBase(fc)).toISOString()
        return setFxx(resolveUrlTokens(ld?.url || '', timeStr), n)
    },

    // Run probe for WMS __FSTEP__ template layers. ALWAYS asks forecast step
    // 1: these products publish a whole run atomically, so step 1 answers
    // for every step, and a later step is dishonest anyway (the WMS serves
    // the same valid date from an OLDER run's projection, returning an image
    // for a run that doesn't exist). BBOX and 1x1 size are
    // appended because without a real render GeoServer never raises the
    // out-of-extent exception.
    _wmsProbeUrl: function (name, fc) {
        const ld = L_.layers.data[name]
        const base = fc._baseUrl || ld?.url || ''
        if (!base.includes('__FSTEP__')) return null

        const timeStr = new Date(this._forecastBase(fc)).toISOString().slice(0, 10)
        let url = resolveUrlTokens(base.replace(/__FSTEP__/g, '1'), timeStr)
        // CONUS in EPSG:3857.
        if (!/[?&]width=/i.test(url)) url += '&width=1&height=1'
        if (!/[?&]bbox=/i.test(url)) {
            url += '&bbox=-13884991,2870341,-7455049,6338219'
        }
        return url
    },
}

export default availabilityMethods

/**
 * Availability. One flow for every forecast type: findAvailableSteps answers which
 * steps of a run have data, the engine keeps the answer per card and run, and
 * derives card state from it. An empty Set is "run not yet generated", a Set
 * with gaps darkens those ticks, null is "no verdict" (everything shown).
 *
 * Answers are re-asked after PROBE_MISS_TTL_MS so a run that is still
 * publishing fills in. Data that actually loaded proves the run exists,
 * whatever a slower failed check says.
 */

import { PROBE_LOADING_DELAY_MS, PROBE_MISS_TTL_MS } from '../shared/common'

const availabilityMethods = {
    // Keyed `name:run`: { steps: Set|null|undefined, at, pending, promise }
    _presence: {},

    // Layers whose next check must ignore remembered misses (a toggle, a retry).
    _freshProbe: new Set(),

    _probeLoadingTimers: {},

    // Set window.FTL_DEBUG = true to trace the availability chain.
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

    _presenceKey: function (name, fc) {
        return `${name}:${this._forecastBase(fc)}`
    },

    _probeAllAnchors: function () {
        this._detectForecastLayers().forEach(({ name, config: fc }) => {
            if (this._initHourMismatch(fc)) {
                this._cancelLoading(name)
                this._setCardState(name, 'uninitialized')
                return
            }
            if (!this._forecastTypeFor(name)) {
                this._cancelLoading(name)
                this._setCardState(name, 'notype')
                return
            }
            this._resolvePresence(name, fc)
        })
    },

    _resolvePresence: function (name, fc) {
        const key = this._presenceKey(name, fc)
        const rec = this._presence[key]
        const fresh = this._freshProbe.has(name)
        if (rec?.pending) return rec.promise
        if (rec && !fresh && Date.now() - rec.at < PROBE_MISS_TTL_MS) {
            this._applyPresence(name, fc, rec.steps)
            return Promise.resolve(rec.steps)
        }
        this._freshProbe.delete(name)

        const cardState = this.state.cards[name]?.cardState
        if (rec?.steps === undefined) {
            this._setCardState(name, 'loading')
        } else if (cardState === 'unavailable' || cardState === 'failed') {
            this._scheduleLoading(name)
        }

        const run = this._forecastBase(fc)
        const steps = this._effectiveSteps(fc, name)
        const forecastType = this._forecastTypeFor(name)
        const promise = Promise.resolve()
            .then(() =>
                forecastType.findAvailableSteps
                    ? forecastType.findAvailableSteps(this._forecastTypeCall(name, fc, { steps, fresh }))
                    : null
            )
            .then(
                (result) => (result instanceof Set ? result : null),
                (e) => {
                    this._dbg('findAvailableSteps ERROR', name, e)
                    return new Set()
                }
            )
            .then((result) => {
                if (this._presence[key]?.promise !== promise) return result
                this._presence[key] = { steps: result, at: Date.now(), pending: false }
                this._dbg('presence', name, { run: new Date(run).toISOString(), steps: result && [...result] })
                if (this._forecastBase(fc) === run) this._applyPresence(name, fc, result)
                return result
            })
        this._presence[key] = { steps: rec?.steps, at: Date.now(), pending: true, promise }
        return promise
    },

    _applyPresence: function (name, fc, steps) {
        this._cancelLoading(name)
        const cs = this.state.cards[name]
        if (!cs) return
        if (this._initHourMismatch(fc)) {
            this._setCardState(name, 'uninitialized')
            return
        }
        const run = this._forecastBase(fc)
        let present = steps === null || steps === undefined || steps.size > 0
        if (!present && cs.evidenceBase === run) present = true
        const wasDisabled = cs.cardState === 'unavailable' || cs.cardState === 'failed'
        if (!present) {
            const failed = cs.failedBase != null && cs.failedBase === run
            this._setCardState(name, failed ? 'failed' : 'unavailable')
        } else {
            this._setCardState(name, 'available')
            if (wasDisabled) this._reapplyAllSteps()
        }
    },

    _scheduleLoading: function (name) {
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

    // A step's data loaded: direct proof this run exists.
    _markRunPresent: function (name, fc) {
        const cs = this.state.cards[name]
        if (!cs) return
        const run = this._forecastBase(fc)
        cs.evidenceBase = run
        cs.failedBase = null
        const rec = this._presence[this._presenceKey(name, fc)]
        if (rec?.steps instanceof Set && rec.steps.size === 0) rec.steps = null
        if (cs.cardState !== 'available') this._applyPresence(name, fc, rec ? rec.steps : null)
    },

    // A step fetch failed although the run checked present. Show "Forecast not
    // available" and forget the check so the next one can recover the card.
    _failCard: function (name, fc) {
        const cs = this.state.cards[name]
        if (!cs) return
        cs.failedBase = this._forecastBase(fc)
        delete this._presence[this._presenceKey(name, fc)]
        if (!this._initHourMismatch(fc)) this._setCardState(name, 'failed')
    },

    _missingStep: function (name, fc, idx) {
        if (!fc) return false
        const rec = this._presence[this._presenceKey(name, fc)]
        return rec?.steps instanceof Set && !rec.steps.has(idx)
    },

    // True once this run's check has answered at least once. Until then ticks
    // render skeleton, never active.
    _presenceReady: function (name, fc) {
        const rec = this._presence[this._presenceKey(name, fc)]
        return !!rec && rec.steps !== undefined
    },

    _canRetryStep: function (name) {
        return typeof this._forecastTypeFor(name)?.retryStep === 'function'
    },

    // Behind a dark tick's retry button. Resolves true when the step has data now.
    _retryStep: function (name, fc, idx) {
        const forecastType = this._forecastTypeFor(name)
        const key = this._presenceKey(name, fc)
        this._setTickLoading(name, idx, true)
        const steps = this._effectiveSteps(fc, name)
        const check = forecastType?.retryStep
            ? Promise.resolve(
                  forecastType.retryStep(this._forecastTypeCall(name, fc, { step: idx, steps }))
              ).then((present) => {
                  const rec = this._presence[key]
                  if (rec?.steps instanceof Set) {
                      if (present) rec.steps.add(idx)
                      else rec.steps.delete(idx)
                  }
                  return !!present
              })
            : (this._freshProbe.add(name),
              this._resolvePresence(name, fc).then(
                  (result) => result === null || result.has(idx)
              ))
        return check
            .catch(() => false)
            .then((present) => {
                this._setTickLoading(name, idx, false)
                if (present) this._applyPresence(name, fc, this._presence[key]?.steps ?? null)
                this._refreshAllCards()
                return present
            })
    },
}

export default availabilityMethods

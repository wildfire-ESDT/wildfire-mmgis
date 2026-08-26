/**
 * Step application. What happens when a card's active step changes, one
 * function per layer kind, plus the main-timeline change flow.
 *
 * How each kind carries its step:
 *   COG fxx        rewrite fxx inside the titiler url= source, refresh tiles
 *   velocity fxx   fetch the step's gribjson and setData in place
 *   urlTemplate    substitute __FSTEP__ (1-based) into the WMS URL and LAYERS
 *   STAC/generic   shift the layer's query end time, refresh or reload
 */

import TimeControl from '@basics/TimeControl_/TimeControl'
import L_ from '@basics/Layers_/Layers_'

import {
    STEP_UNITS,
    hasInitHour,
    isCogFxx,
    isFxxVelocity,
    isStacForecast,
    setFxx,
    resolveUrlTokens,
} from './common'
import { stepTime } from './time'

const stepMethods = {
    // ── Step entry points ──────────────────────────────────

    _setCardStep: function (name, fc, idx) {
        if (!this.state.cards[name]) return
        this.state.cards[name].stepIndex = idx
        this._refreshAllCards()
        this._applyCardStep(name, fc, idx)
    },

    // Re-apply every visible card's step. The guard flag MUST clear in a
    // finally: stuck true it makes _onTimeChange bail forever, and the cards
    // silently stop tracking the timeline for the rest of the session. Layers
    // are isolated too, so one not-yet-built layer can't stop the others.
    _reapplyAllSteps: function () {
        if (this._reapplying) return
        this._reapplying = true
        try {
            this._detectForecastLayers().forEach(({ name, config: fc }) => {
                const idx = this.state.cards[name]?.stepIndex ?? 0
                try {
                    this._applyCardStep(name, fc, idx)
                } catch (e) {
                    console.warn(
                        '[ForecastTimeline] applying step failed for', name, e
                    )
                }
            })
        } finally {
            this._reapplying = false
        }
    },

    // Apply step idx of a card to its layer, dispatched by layer kind.
    _applyCardStep: function (name, fc, idx) {
        // Not the model's init hour: the card is 'uninitialized' and the main
        // timeline owns the layer; applying a step would fight it.
        if (this._initHourMismatch(fc)) return
        // Clamp so a stale index never requests an unavailable hour.
        idx = Math.max(0, Math.min(idx, this._effectiveSteps(fc, name) - 1))
        // An hour with no data behind it must never reach the layer. The tick
        // click already refuses, but a step also arrives from playback, a run
        // recovery re-apply and the main timeline, and a hole can open under a
        // step that was fine when it was picked.
        if (this._missingStep(name, fc, idx)) return
        const originMs = this._forecastBase(fc)
        const stepMs = stepTime(fc, idx, originMs)

        // Mark stepIndex on the layer data so the main TimeControl loop skips
        // this layer while a forecast step is active.
        fc.stepIndex = idx

        if (fc.urlTemplate) {
            // URL templates are 1-based (forecast-1, forecast-2, ...).
            this._applyUrlTemplate(name, idx + 1)
            return
        }
        const ld = L_.layers.data[name]
        if (!ld || !L_.layers.on[name]) return
        if (isCogFxx(ld)) this._applyCogFxxStep(name, fc, idx)
        else if (isFxxVelocity(ld)) this._applyVelocityFxxStep(name, fc, idx)
        else this._applyTimeShiftStep(name, fc, idx, stepMs)
    },

    // ── COG fxx rasters (hourly forecast COGs, e.g. HRRR) ──
    _applyCogFxxStep: function (name, fc, idx) {
        const ld = L_.layers.data[name]
        // Keep ld.url in sync so a later rebuild starts from the right fxx.
        ld.url = setFxx(ld.url, idx)

        const leafletLayer = L_.layers.layer[name]
        if (leafletLayer && typeof leafletLayer._url === 'string') {
            // CRITICAL: fxx must be rewritten INSIDE the titiler `url=` source.
            // veloserver silently drops a sibling fxx on the titiler request
            // and serves the fxx=0 analysis instead (verified live).
            const newUrl = leafletLayer._url.replace(
                /([?&]url=)([^&]*)/i,
                (_m, pre, src) => pre + setFxx(src, idx)
            )
            if (newUrl !== leafletLayer._url) {
                // Spin the clicked tick on the FIRST visit only; revisits are
                // served from the tile cache and a spinner reads as a false
                // loading flash. The anti-flicker refresh has no completion
                // event, so the spinner rides its auto-clear.
                if (!this._visitedSteps) this._visitedSteps = new Set()
                const visitKey = `${name}:${this._forecastBase(fc)}:${idx}`
                if (!this._visitedSteps.has(visitKey)) {
                    this._visitedSteps.add(visitKey)
                    if (!this._isPlaying(name))
                        this._setTickLoading(name, idx, true, 2500)
                }
                leafletLayer.refresh(newUrl, true)
            }
        }
    },

    // ── Velocity fxx (gribjson winds, e.g. HRRR) ───────────
    // setData refreshes the streamlines in place. A reloadLayer toggle would
    // blink the layer off, which also removes the card mid-step.
    _applyVelocityFxxStep: function (name, fc, idx) {
        const ld = L_.layers.data[name]
        ld.url = setFxx(ld.url, idx)

        const leafletLayer = L_.layers.layer[name]
        const canSetData =
            leafletLayer &&
            typeof leafletLayer.setData === 'function' &&
            /^https?:\/\//i.test(ld.url) &&
            ld.time &&
            ld.time.end
        if (canSetData) {
            // Prefetched or previously fetched frame: serve from memory.
            const cached = this._frameCache?.[this._frameKey(name, fc)]?.[idx]
            if (cached) {
                leafletLayer.setData(cached)
                if (idx === 0) this._setCardState(name, 'available')
                return
            }
            const fetchUrl = resolveUrlTokens(ld.url, ld.time.end, ld.time.start)
            // Spin the clicked tick while the grib is in flight (1 to 3s).
            this._setTickLoading(name, idx, true)
            fetch(fetchUrl)
                .then((r) => {
                    if (!r.ok) throw new Error(r.status)
                    return r.json()
                })
                .then((data) => {
                    this._setTickLoading(name, idx, false)
                    leafletLayer.setData(data)
                    // Cache per run so revisits are instant and a new model
                    // run never serves stale frames.
                    const fk = this._frameKey(name, fc)
                    if (!this._frameCache[fk]) this._frameCache[fk] = {}
                    this._frameCache[fk][idx] = data
                    this._markRunPresent(name, fc)
                })
                .catch((e) => {
                    this._setTickLoading(name, idx, false)
                    console.warn('ForecastTimeline: velocity fxx update failed', e)
                    this._failCard(name, fc)
                })
        } else {
            // Fallback: reload via toggle, guarded so the toggle's rebuild
            // doesn't reset the card to step 0.
            this._reloadingLayer = true
            Promise.resolve(
                TimeControl.reloadLayer(ld, false, false, false)
            ).finally(() => {
                this._reloadingLayer = false
            })
        }
    },

    // ── STAC / generic time shift ──────────────────────────
    _applyTimeShiftStep: function (name, fc, idx, stepMs) {
        const ld = L_.layers.data[name]

        let queryEndIso
        let isFutureMonth = false
        if (fc.stepUnit === 'month') {
            // A monthly item IS the forecast for its own month, so a tick
            // queries the month it is labeled with. The current month shares
            // core's canonical request; a future month queries its boundary
            // instant (widened by _pinStacInstant).
            const nowMs = Date.parse(TimeControl.currentTime || ld.time.end)
            isFutureMonth = stepMs > nowMs
            queryEndIso = isFutureMonth
                ? new Date(stepMs).toISOString().split('.')[0] + 'Z'
                : TimeControl.currentTime || ld.time.end
        } else if (hasInitHour(fc)) {
            // Init-hour collections stamp an item at each VALID hour: the
            // tick queries the hour it is labeled with. One step back would
            // serve the PREVIOUS run's tail (its last valid hour sits exactly
            // on this run's init instant).
            queryEndIso = new Date(stepMs).toISOString()
        } else {
            // The tick is labeled with the VALID day but queries the ISSUE
            // day (one step earlier), because a forecast for day T is issued
            // on T minus one.
            const prevStepMs = stepMs - (STEP_UNITS[fc.stepUnit] || STEP_UNITS.hour)
            queryEndIso = new Date(prevStepMs).toISOString()
        }

        // Per-step availability: a period with no item shows the warning for
        // THAT period while the card stays navigable.
        if (isStacForecast(ld)) {
            this._probeStacStepPresent(name, Date.parse(queryEndIso)).then(
                (present) => {
                    if (this.state.cards[name]?.stepIndex !== idx) return
                    // Stale resolve: the timeline left the init hour while
                    // this probe was in flight; the gate's state stands.
                    if (this._initHourMismatch(fc)) return
                    this._setCardState(
                        name,
                        present ? 'available' : 'unavailable'
                    )
                }
            )
        }

        const prevStart = ld.time.start
        const prevEnd = ld.time.end

        // Keep the open epoch START. Narrowing it excluded earlier items, so
        // any missing forecast day yielded an empty mosaic and a blank layer.
        ld.time.end = queryEndIso

        if (ld.type === 'tile') {
            TimeControl.applyTimeParams(ld)
            const leafletLayer = L_.layers.layer[name]
            // During a main-timeline change core reloads this layer itself
            // with the identical current-month request; skip the duplicate.
            const coreCovers =
                this._reapplying &&
                fc.stepUnit === 'month' &&
                !isFutureMonth
            if (leafletLayer && !coreCovers)
                leafletLayer.refresh(null, true)
        } else {
            TimeControl.reloadLayer(ld, false, false, false)
        }

        ld.time.start = prevStart
        ld.time.end = prevEnd
    },

    // ── urlTemplate (WMS __FSTEP__) ────────────────────────
    _applyUrlTemplate: function (name, stepNumber) {
        const ld = L_.layers.data[name]
        if (!ld) return

        if (!ld.time.forecast._baseUrl) {
            ld.time.forecast._baseUrl = ld.url
        }

        const newUrl = ld.time.forecast._baseUrl.replace(/__FSTEP__/g, String(stepNumber))
        ld.url = newUrl

        const leafletLayer = L_.layers.layer[name]
        if (leafletLayer && ld.tileformat === 'wms') {
            // Substitute even while the layer is OFF: the pre-built layer
            // carries the raw __FSTEP__ token, and gating on on-state made
            // every tile 404 on the first toggle-on. Only redraw when on.
            const urlSplit = newUrl.split('?')
            const newBase = urlSplit[0]
            const urlParams = new URLSearchParams(urlSplit[1] || '')

            leafletLayer._url = newBase

            const layersVal = urlParams.get('layers') || urlParams.get('LAYERS')
            if (layersVal) {
                leafletLayer.setParams({ LAYERS: layersVal }, true)
            }

            // Core notifies subscribers BEFORE updating layer times on a
            // timeline change, so sync time off TimeControl.currentTime first
            // or the card trails a full run across the run boundary.
            if (TimeControl.currentTime) {
                ld.time.end = TimeControl.currentTime
                if (TimeControl.startTime) ld.time.start = TimeControl.startTime
                TimeControl.applyTimeParams(ld)
            }
            if (L_.layers.on[name]) leafletLayer.redraw()
        } else if (TimeControl?.reloadLayer && L_.layers.on[name]) {
            TimeControl.reloadLayer(ld, false, false, true)
        }
    },

    // Given a queried end, returns [start, end] pinned to that instant
    // (start == end, widened by a second) instead of the wide [epoch, end].
    // Returns null if ld isn't a pinnable STAC forecast tile.
    _stacPin: function (ld, endIso) {
        if (!isStacForecast(ld) || ld.type !== 'tile') return null
        const t0 = Date.parse(endIso)
        if (isNaN(t0)) return null
        const fc = ld.time?.forecast
        const iso = (ms) => new Date(ms).toISOString().split('.')[0] + 'Z'
        // Not the model's init hour: items exist at every valid hour, so the
        // timeline would render one. A zero-length window draws nothing.
        if (this._initHourMismatch(fc)) return [iso(t0), iso(t0)]
        const unit = fc?.stepUnit || 'hour'
        if (unit === 'month') {
            const d = new Date(t0)
            const atBoundary =
                d.getUTCDate() === 1 &&
                d.getUTCHours() === 0 &&
                d.getUTCMinutes() === 0 &&
                d.getUTCSeconds() === 0
            return [iso(t0), iso(t0 + (atBoundary ? 3600000 : 1000))]
        }
        const unitMs = STEP_UNITS[unit] || STEP_UNITS.hour
        const t = Math.floor(t0 / unitMs) * unitMs
        // Widened by one second: a true zero-length interval answers 204
        // instead of matching the item stamped at that instant.
        return [iso(t), iso(t + 1000)]
    },

    // Narrow a live layer's Leaflet options. Fine for a param-only change,
    // but can't fix an instance a rebuild already baked the epoch start
    // into; see _pinStacTimeBeforeRebuild for that.
    _pinStacInstant: function (ld) {
        const l = L_.layers.layer[ld?.name]
        const pin = this._stacPin(ld, l?.options?.endtime)
        if (!pin || !l) return
        l.options.starttime = pin[0]
        l.options.endtime = pin[1]
    },

    // Narrow ld.time itself before the tile type's own timeChange rebuilds
    // or refreshes the layer, since it reads layerObj.time.start/end straight
    // into the new options (Tile/map.js). Pinning after the fact races the
    // moment those options get baked in. Returns a restore(), or null if
    // there's nothing to pin.
    _pinStacTimeBeforeRebuild: function (ld) {
        const pin = this._stacPin(ld, ld?.time?.end)
        if (!pin) return null
        const prevStart = ld.time.start
        const prevEnd = ld.time.end
        ld.time.start = pin[0]
        ld.time.end = pin[1]
        return () => {
            ld.time.start = prevStart
            ld.time.end = prevEnd
        }
    },

    // ── Main-timeline change ───────────────────────────────
    _onTimeChange: function (timeData) {
        if (this._applyingStep || this._reapplying) return
        if (timeData?.currentTime) {
            this.state.originMs = new Date(timeData.currentTime).getTime()
            // A new selected time is a new model run: snap cards to step 0.
            Object.keys(this.state.cards).forEach((n) => {
                this.state.cards[n].stepIndex = 0
            })
            // Probe first so state is correct before rendering. Rebuild only
            // when a card's tick count changed (fxx run-length boundary,
            // e.g. HRRR F18/F48).
            this._probeAllAnchors()
            if (this._stepCountsStale()) {
                this._rebuildCards()
            } else {
                this._refreshAllCards()
            }
            this._reapplyAllSteps()
            this._updateNextButtonState()
        }
    },
}

export default stepMethods

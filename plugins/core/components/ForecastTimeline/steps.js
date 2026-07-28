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
        // Clamp so a stale index never requests an unavailable hour.
        idx = Math.max(0, Math.min(idx, this._effectiveSteps(fc, name) - 1))
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

    // ── COG fxx (HRRR rasters) ─────────────────────────────
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

    // ── Velocity fxx (HRRR gribjson winds) ─────────────────
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
            TimeControl.setLayerWmsParams(ld)
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

    // ── urlTemplate (WFPI WMS __FSTEP__) ───────────────────
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
            // or WFPI trails a full run across the 00:00Z boundary.
            if (
                typeof TimeControl?.setLayerWmsParams === 'function' &&
                TimeControl.currentTime
            ) {
                ld.time.end = TimeControl.currentTime
                if (TimeControl.startTime) ld.time.start = TimeControl.startTime
                TimeControl.setLayerWmsParams(ld)
            }
            if (L_.layers.on[name]) leafletLayer.redraw()
        } else if (TimeControl?.reloadLayer && L_.layers.on[name]) {
            TimeControl.reloadLayer(ld, false, false, true)
        }
    },

    // ── STAC datetime pinning ──────────────────────────────
    // Pin STAC forecast tile requests to an instant (start == end, widened by
    // one second; a true zero-length interval answers 204). Without this the
    // open [epoch, end] query matched every item up to the end and composited
    // a nondeterministic multi-item mosaic. Monthly pins to the requested end
    // (boundary ends get the boundary's first hour); day/hour floor to the
    // period start because their items are stamped at a single point.
    _pinStacInstant: function (ld) {
        if (!isStacForecast(ld) || ld.type !== 'tile') return
        const l = L_.layers.layer[ld.name]
        const t0 = Date.parse(l?.options?.endtime)
        if (isNaN(t0)) return
        const unit = ld.time?.forecast?.stepUnit || 'hour'
        const iso = (ms) => new Date(ms).toISOString().split('.')[0] + 'Z'
        if (unit === 'month') {
            const d = new Date(t0)
            const atBoundary =
                d.getUTCDate() === 1 &&
                d.getUTCHours() === 0 &&
                d.getUTCMinutes() === 0 &&
                d.getUTCSeconds() === 0
            l.options.starttime = iso(t0)
            l.options.endtime = iso(t0 + (atBoundary ? 3600000 : 1000))
        } else {
            const unitMs = STEP_UNITS[unit] || STEP_UNITS.hour
            const t = Math.floor(t0 / unitMs) * unitMs
            l.options.starttime = iso(t)
            l.options.endtime = iso(t + 1000)
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
            // when a card's tick count changed (HRRR F18 to F48 boundary).
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

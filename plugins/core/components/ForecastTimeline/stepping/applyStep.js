/**
 * Applies a step. Resolves a card's forecast type, builds the object every
 * forecast type method receives, and calls showStep. Also reacts to the main
 * timeline changing.
 */

import TimeControl from '@basics/TimeControl_/TimeControl'
import L_ from '@basics/Layers_/Layers_'

import { stepTime } from '../shared/timeMath'
import { resolveForecastType } from '../forecastTypes/registry'

const stepMethods = {
    _forecastTypeFor: function (name) {
        return resolveForecastType(L_.layers.data[name]).forecastType
    },

    // What a forecast type may ask of the engine. Nothing else is reachable.
    _engineFor: function (name, fc) {
        return {
            currentTime: TimeControl.currentTime,
            startTime: TimeControl.startTime,
            duringTimelineChange: !!this._reapplying,
            playing: this._isPlaying(name),
            applyTimeParams: (layer) => TimeControl.applyTimeParams(layer),
            reloadLayer: (layer, { forceRequery = false } = {}) => {
                this._reloadingLayer = true
                return Promise.resolve(
                    TimeControl.reloadLayer(layer, false, false, forceRequery)
                ).finally(() => {
                    this._reloadingLayer = false
                })
            },
            setTickLoading: (step, on, ms) => this._setTickLoading(name, step, on, ms),
            markRunPresent: () => this._markRunPresent(name, fc),
            failCard: () => this._failCard(name, fc),
            refreshCards: () => this._refreshAllCards(),
            fetchOptions: (extra) => this._probeFetchOpts(extra),
            debug: (...args) => this._dbg(...args),
        }
    },

    _forecastTypeCall: function (name, fc, extra) {
        return {
            name,
            layer: L_.layers.data[name],
            mapLayer: L_.layers.layer[name],
            forecast: fc,
            options: fc.options || {},
            run: this._forecastBase(fc),
            isOn: L_.layers.on[name] === true,
            uninitialized: this._initHourMismatch(fc),
            engine: this._engineFor(name, fc),
            ...extra,
        }
    },

    _effectiveSteps: function (fc, name) {
        const forecastType = name ? this._forecastTypeFor(name) : null
        if (forecastType?.countSteps) {
            const n = forecastType.countSteps(this._forecastTypeCall(name, fc))
            if (Number.isFinite(n) && n > 0) return n
        }
        return fc.steps || 1
    },

    _setCardStep: function (name, fc, idx) {
        if (!this.state.cards[name]) return
        this.state.cards[name].stepIndex = idx
        this._refreshAllCards()
        this._applyCardStep(name, fc, idx)
    },

    // Re-apply every visible card's step. The guard flag MUST clear in a
    // finally: stuck true it makes _onTimeChange bail forever.
    _reapplyAllSteps: function () {
        if (this._reapplying) return
        this._reapplying = true
        try {
            this._detectForecastLayers().forEach(({ name, config: fc }) => {
                const idx = this.state.cards[name]?.stepIndex ?? 0
                try {
                    this._applyCardStep(name, fc, idx)
                } catch (e) {
                    console.warn('[ForecastTimeline] applying step failed for', name, e)
                }
            })
        } finally {
            this._reapplying = false
        }
    },

    _applyCardStep: function (name, fc, idx) {
        // Not the model's init hour: the main timeline owns the layer.
        if (this._initHourMismatch(fc)) return
        const forecastType = this._forecastTypeFor(name)
        if (!forecastType) return
        const steps = this._effectiveSteps(fc, name)
        idx = Math.max(0, Math.min(idx, steps - 1))
        // A step with no data behind it must never reach the layer.
        if (this._missingStep(name, fc, idx)) return
        const run = this._forecastBase(fc)
        const stepMs = stepTime(fc, idx, run)
        document.dispatchEvent(
            new CustomEvent('forecasttimeline:step', {
                detail: { layerName: name, time: stepMs, run, stepUnit: fc.stepUnit || 'hour' },
            })
        )
        // The main TimeControl loop skips this layer while a step is active.
        fc.stepIndex = idx
        if (!L_.layers.data[name]) return
        forecastType.showStep(this._forecastTypeCall(name, fc, { step: idx, stepTime: stepMs, steps }))
    },

    // Another component asks to show a forecast hour (forecasttimeline:show-time).
    // Steps each visible card whose run has that hour, or only layerName's card
    // when one is given.
    _showForecastTime: function ({ time, layerName } = {}) {
        if (!Number.isFinite(time)) return
        this._detectForecastLayers().forEach(({ name, config: fc }) => {
            if (layerName && name !== layerName) return
            if (this._initHourMismatch(fc)) return
            const run = this._forecastBase(fc)
            const steps = this._effectiveSteps(fc, name)
            const step = Array.from({ length: steps }, (_, index) => index).find(
                (index) => stepTime(fc, index, run) === time
            )
            if (step == null || this._missingStep(name, fc, step)) return
            this._setCardStep(name, fc, step)
        })
    },

    _onTimeChange: function (timeData) {
        if (this._applyingStep || this._reapplying) return
        if (timeData?.currentTime) {
            this.state.originMs = new Date(timeData.currentTime).getTime()
            // A new selected time is a new model run: snap cards to step 0.
            Object.keys(this.state.cards).forEach((n) => {
                this.state.cards[n].stepIndex = 0
            })
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

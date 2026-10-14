/**
 * ForecastTimeline. Forecast stepper cards inside TimeUI's expanded content;
 * the main timeline stays visible and owns the selected time.
 *
 * A layer opts in with a time.forecast config block and names its forecast
 * type. README.md documents every setting and the forecast type interface.
 *
 * This file is the plugin entry point: lifecycle (init/cleanup),
 * subscriptions, and the console/debug surface (window.ForecastTimeline,
 * window.FTL_DEBUG).
 */

import TimeControl from '@basics/TimeControl_/TimeControl'
import L_ from '@basics/Layers_/Layers_'

import './forecastTypes/allTypes'
import timeMathMixin from './shared/timeMath'
import stepsMixin from './stepping/applyStep'
import availabilityMixin from './stepping/availability'
import patchesMixin from './stepping/patches'
import cardsMixin from './ui/cards'
import playbackMixin from './ui/playback'

import './ui/ForecastTimeline.css'

const ForecastTimeline = {
    // ── State ──────────────────────────────────────────────
    state: {
        cards: {},
        originMs: null,
    },

    // Mission config variables (plugin.json → config.rows).
    vars: {},

    // Selected time floored to the hour. The timeline's time, never the clock.
    _originBase: function () {
        let t = NaN
        if (TimeControl.currentTime) t = new Date(TimeControl.currentTime).getTime()
        if (isNaN(t)) t = this.state.originMs || Date.now()
        const d = new Date(t)
        d.setMinutes(0, 0, 0)
        return d.getTime()
    },

    // ── Lifecycle ──────────────────────────────────────────

    init: function (vars) {
        this.vars = vars || {}
        this.state.originMs = Date.now()

        // Debug/observation surface only; nothing in the plugin reads it.
        if (typeof window !== 'undefined') window.ForecastTimeline = this

        // Watch #timeUI height so compass/legend/scalebar clear the cards.
        this._observeTimeUIHeight()

        // Inject the strip once TimeUI has rendered its DOM.
        this._waitAndInject()

        // Core patches (see patches.js).
        this._patchPopulateExpandedRows()
        this._patchTimeUINavigation()
        this._patchSetLayerWmsParams()
        this._patchTileTimeChange()
        this._patchTileUrl()
        this._optimisticOn = new Set()
        this._toggleTick = {}
        this._patchToggleLayer()

        if (TimeControl.subscribe) {
            TimeControl.subscribe('forecastTimeline', (td) =>
                this._onTimeChange(td)
            )
        }

        L_.subscribeOnLayerToggle('forecastTimeline', (name, isNowOn) => {
            // Drop the optimistic override once settled ON. Never drop on OFF
            // (a reload's brief off-then-on would prune the card mid-refresh).
            if (name && isNowOn === true && this._optimisticOn)
                this._optimisticOn.delete(name)
            // A step-driven fallback reload toggles the layer; skip the
            // rebuild so it doesn't reset the card's step to 0.
            if (this._reloadingLayer) return
            this._rebuildCards()
        })

        if (!this._showTimeHandler) {
            this._showTimeHandler = (event) => this._showForecastTime(event.detail)
            document.addEventListener('forecasttimeline:show-time', this._showTimeHandler)
        }

        // Dismiss any open info tooltip on an outside click (tip anchors
        // stopPropagation their own clicks).
        if (!this._tipDismissHandler) {
            this._tipDismissHandler = (e) => {
                if (!e.target.closest('.ftl-has-tip')) this._hideTip()
            }
            document.addEventListener('click', this._tipDismissHandler)
        }

        // Initial Next button state (after TimeUI DOM is ready)
        setTimeout(() => this._updateNextButtonState(), 1000)
    },

    cleanup: function () {
        // Stop animations first or their intervals fire against dead DOM.
        Object.keys(this._playTimers || {}).forEach((n) => this._stopPlay(n))
        this._playTimers = {}

        this.state.cards = {}
        this._presence = {}
        this._freshProbe.clear()

        const timeUI = document.getElementById('timeUI')
        if (timeUI) {
            timeUI.style.display = ''
            timeUI.style.height = ''
        }

        if (this._timeUIObserver) {
            this._timeUIObserver.disconnect()
            this._timeUIObserver = null
        }
        if (this._heightObserver) {
            this._heightObserver.disconnect()
            this._heightObserver = null
        }

        // Remove extra bottom offset
        document.documentElement.style.removeProperty('--ftl-extra-bottom')
        document.documentElement.style.removeProperty('--ftl-sep-reserve')

        // Restore every patched core method and drop the future-item styles.
        this._removeAllPatches()
        if (this._optimisticOn) this._optimisticOn.clear()
        this._toggleTick = {}

        // Detach tile load hooks and clear any pending tick-spinner timers
        Object.keys(this._loadHooks || {}).forEach((n) =>
            this._detachLoadIndicator(n)
        )
        Object.values(this._tickSpinTimers || {}).forEach(clearTimeout)
        this._tickSpinTimers = {}
        Object.values(this._probeLoadingTimers || {}).forEach(clearTimeout)
        this._probeLoadingTimers = {}

        // Restore Next button appearance
        const nextBtn = document.getElementById('mmgisTimeUIBottomNext')
        if (nextBtn) {
            nextBtn.removeAttribute('disabled')
            nextBtn.style.opacity = ''
            nextBtn.style.cursor = ''
            nextBtn.style.pointerEvents = ''
        }

        if (TimeControl?.unsubscribe) TimeControl.unsubscribe('forecastTimeline')
        L_.unsubscribeOnLayerToggle('forecastTimeline')

        if (this._tipDismissHandler) {
            document.removeEventListener('click', this._tipDismissHandler)
            this._tipDismissHandler = null
        }
        if (this._showTimeHandler) {
            document.removeEventListener('forecasttimeline:show-time', this._showTimeHandler)
            this._showTimeHandler = null
        }

        document.getElementById('ftl-strip')?.remove()
        document.getElementById('ftl-tooltip')?.remove()
    },
}

Object.assign(
    ForecastTimeline,
    timeMathMixin,
    availabilityMixin,
    stepsMixin,
    cardsMixin,
    patchesMixin,
    playbackMixin
)

export default ForecastTimeline

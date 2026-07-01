/**
 * ForecastTimeline - Integrated forecast stepper rows inside TimeUI
 *
 * Attached mode: injects card rows into TimeUI expanded content + a toggle
 *   button in the TimeUI actions bar. The main timeline stays visible.
 * Detached mode: hides TimeUI, shows a standalone panel with a compact
 *   date+hour picker and expanded forecast card rows.
 *
 * Layer config: time.forecast block with:
 *   { enabled: true, label: "PWWB Hourly", steps: 24, stepUnit: "hour" }
 *   { enabled: true, label: "WFPI Daily",  steps: 7,  stepUnit: "day", urlTemplate: true }
 */

import TimeControl from '@basics/TimeControl_/TimeControl'
import TimeUI from '@basics/TimeControl_/TimeUI'
import L_ from '@basics/Layers_/Layers_'
import './ForecastTimeline.css'

const STEP_UNITS = {
    hour: 3600000,
    day: 86400000,
}

const PDT_TZ = 'America/Los_Angeles'

const ForecastTimeline = {
    // ── State ──────────────────────────────────────────────
    state: {
        cards: {},
        originMs: null,
        detached: false,
    },

    // ── Lifecycle ──────────────────────────────────────────

    init: function (vars) {
        this.state.originMs = Date.now()

        // ── Monkey-patch TimeControl.reloadTimeLayers ──
        // Wrap the core function so layers with an active forecast stepIndex
        // are skipped by the main timeline reload loop.  This keeps forecast
        // step selection stable when the user scrubs the main timeline.
        this._patchReloadTimeLayers()

        // ── Bottom-element repositioning ──
        // Watch #timeUI height changes (caused by _adjustTimeUIHeight adding
        // forecast card rows) and push compass / legend / scalebar up so
        // nothing clips.  This replaces the core uiStore + BottomElement-
        // Positioner changes with a self-contained plugin-side observer.
        this._observeTimeUIHeight()

        // Inject after TimeUI has rendered its DOM
        this._waitAndInject()

        if (TimeControl.subscribe) {
            TimeControl.subscribe('forecastTimeline', (td) =>
                this._onTimeChange(td)
            )
        }

        L_.subscribeOnLayerToggle('forecastTimeline', () =>
            this._rebuildCards()
        )
    },

    // ── DOM injection ──────────────────────────────────────

    _injectToggleButton: function () {
        document.getElementById('ftl-toggle-btn')?.remove()

        const actionsRight = document.getElementById('mmgisTimeUIActionsRight')
        if (!actionsRight) return

        const btn = document.createElement('div')
        btn.id = 'ftl-toggle-btn'
        btn.className = 'mmgisTimeUIButton ftl-toggle-btn'
        btn.title = 'Toggle Forecast Panel'
        btn.innerHTML = '<i class="mdi mdi-weather-cloudy-clock mdi-24px"></i>'
        btn.addEventListener('click', () => this._toggleDetached())
        actionsRight.prepend(btn)
    },

    _waitAndInject: function () {
        const tryInject = () => {
            const expandedContent = document.getElementById('mmgisTimeUIExpandedContent')
            const actionsRight = document.getElementById('mmgisTimeUIActionsRight')
            if (expandedContent && actionsRight) {
                this._injectToggleButton()
                this._injectForecastStrip()
                this._injectDetachedPanel()
                this._rebuildCards()
            } else {
                const obs = new MutationObserver(() => {
                    if (document.getElementById('mmgisTimeUIExpandedContent') &&
                        document.getElementById('mmgisTimeUIActionsRight')) {
                        obs.disconnect()
                        this._injectToggleButton()
                        this._injectForecastStrip()
                        this._injectDetachedPanel()
                        this._rebuildCards()
                    }
                })
                obs.observe(document.body, { childList: true, subtree: true })
            }
        }
        tryInject()
    },

    _injectForecastStrip: function () {
        document.getElementById('ftl-strip')?.remove()

        const expandedContent = document.getElementById('mmgisTimeUIExpandedContent')
        if (!expandedContent) return

        const strip = document.createElement('div')
        strip.id = 'ftl-strip'
        strip.className = 'ftl-strip'
        expandedContent.prepend(strip)

        // Watch for timeline expand/collapse to adjust #timeUI height
        const timeUI = document.getElementById('timeUI')
        if (timeUI) {
            this._timeUIObserver = new MutationObserver(() => this._adjustTimeUIHeight())
            this._timeUIObserver.observe(timeUI, { attributes: true, attributeFilter: ['class'] })
        }
    },

    _adjustTimeUIHeight: function () {
        const timeUI = document.getElementById('timeUI')
        const expandedContent = document.getElementById('mmgisTimeUIExpandedContent')
        if (!timeUI || !expandedContent) return
        const isExpanded = timeUI.classList.contains('expanded')
        const layers = this._detectForecastLayers()
        const cardCount = layers.length
        // 22px for the FORECAST ACTIVE label bar + 54px per card row (two-line ticks)
        const extraH = cardCount > 0 ? 22 + cardCount * 54 : 0
        if (isExpanded && extraH > 0) {
            // #timeUI base expanded = 177px; #mmgisTimeUIExpandedContent base = 137px
            timeUI.style.height = (177 + extraH) + 'px'
            expandedContent.style.height = (137 + extraH) + 'px'
        } else {
            timeUI.style.height = ''
            expandedContent.style.height = ''
        }
    },

    _injectDetachedPanel: function () {
        document.getElementById('ftl-detached')?.remove()

        const panel = document.createElement('div')
        panel.id = 'ftl-detached'
        panel.className = 'ftl-detached'
        panel.classList.add('ftl-hidden')

        const now = new Date(this.state.originMs || Date.now())
        const dateVal = now.toLocaleDateString('en-CA', { timeZone: PDT_TZ })
        const timeParts = now.toLocaleString('en-US', {
            timeZone: PDT_TZ,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).split(':')
        const hourVal = timeParts[0]?.padStart(2, '0') || '00'
        const minVal = timeParts[1] || '00'

        panel.innerHTML = `
<div class="ftl-detached-header">
  <span class="ftl-detached-title">
    <i class="mdi mdi-weather-cloudy-clock"></i>&nbsp;FORECAST ACTIVE
  </span>
  <div class="ftl-detached-pickers">
    <span class="ftl-picker-label">DATE</span>
    <input id="ftl-date-pick" class="ftl-picker-input" type="date" value="${dateVal}" />
    <span class="ftl-picker-label">HR</span>
    <input id="ftl-hour-pick" class="ftl-picker-input ftl-picker-short" type="number" min="0" max="23" value="${hourVal}" />
    <span class="ftl-picker-label">MIN</span>
    <input id="ftl-min-pick" class="ftl-picker-input ftl-picker-short" type="number" min="0" max="59" value="${minVal}" />
    <button id="ftl-time-go" class="ftl-go-btn">SET</button>
  </div>
  <button id="ftl-detach-close" class="mmgisTimeUIButton ftl-close-btn" title="Back to main timeline">
    <i class="mdi mdi-arrow-collapse-down mdi-24px"></i>
  </button>
</div>
<div id="ftl-detached-cards" class="ftl-detached-cards"></div>
`
        document.body.appendChild(panel)

        panel.querySelector('#ftl-time-go')?.addEventListener('click', () => this._applyPickerTime())
        panel.querySelector('#ftl-detach-close')?.addEventListener('click', () => this._toggleDetached())
        panel.querySelector('#ftl-date-pick')?.addEventListener('change', () => this._applyPickerTime())
        panel.querySelector('#ftl-hour-pick')?.addEventListener('change', () => this._applyPickerTime())
        panel.querySelector('#ftl-min-pick')?.addEventListener('change', () => this._applyPickerTime())
    },

    // ── Date picker ────────────────────────────────────────

    _applyPickerTime: function () {
        const dateEl = document.getElementById('ftl-date-pick')
        const hourEl = document.getElementById('ftl-hour-pick')
        const minEl = document.getElementById('ftl-min-pick')
        if (!dateEl || !hourEl || !minEl) return

        const dateStr = dateEl.value
        const hour = parseInt(hourEl.value) || 0
        const min = parseInt(minEl.value) || 0
        if (!dateStr) return

        const dt = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`)
        if (isNaN(dt)) return

        this._applyingStep = true
        TimeControl.setTime(
            TimeUI.removeOffset(dt.getTime() - 3600000),
            TimeUI.removeOffset(dt.getTime()),
            false,
            '00:00:00'
        )
        setTimeout(() => { this._applyingStep = false }, 200)

        this.state.originMs = dt.getTime()
        this._refreshAllCards()
    },

    _updatePickerDisplay: function () {
        const dateEl = document.getElementById('ftl-date-pick')
        const hourEl = document.getElementById('ftl-hour-pick')
        const minEl = document.getElementById('ftl-min-pick')
        if (!dateEl || !hourEl || !minEl) return

        const d = new Date(this.state.originMs || Date.now())
        dateEl.value = d.toLocaleDateString('en-CA', { timeZone: PDT_TZ })
        const parts = d.toLocaleString('en-US', {
            timeZone: PDT_TZ,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).split(':')
        hourEl.value = parts[0]?.padStart(2, '0') || '00'
        minEl.value = parts[1] || '00'
    },

    // ── Attach / Detach toggle ─────────────────────────────

    _toggleDetached: function () {
        this.state.detached = !this.state.detached
        this._applyDetachState()
    },

    _applyDetachState: function () {
        const timeUI = document.getElementById('timeUI')
        const panel = document.getElementById('ftl-detached')
        const btn = document.getElementById('ftl-toggle-btn')

        if (this.state.detached) {
            if (timeUI) timeUI.style.display = 'none'
            if (panel) {
                panel.classList.remove('ftl-hidden')
                this._updatePickerDisplay()
            }
            if (btn) btn.classList.add('active')
            this._rebuildDetachedCards()
        } else {
            if (timeUI) timeUI.style.display = ''
            if (panel) panel.classList.add('ftl-hidden')
            if (btn) btn.classList.remove('active')
        }
    },

    // ── Card management ────────────────────────────────────

    _detectForecastLayers: function () {
        const result = []
        for (const name in L_.layers.data) {
            const ld = L_.layers.data[name]
            if (ld?.time?.forecast?.enabled === true && L_.layers.on[name]) {
                result.push({ name, config: ld.time.forecast, layer: ld })
            }
        }
        return result
    },

    _rebuildCards: function () {
        const layers = this._detectForecastLayers()

        // Sync state: prune removed, init new
        const activeNames = new Set(layers.map((l) => l.name))
        // Clear stepIndex on removed layers so main TimeControl resumes them
        Object.keys(this.state.cards).forEach((n) => {
            if (!activeNames.has(n)) {
                const ld = L_.layers.data[n]
                if (ld?.time?.forecast) delete ld.time.forecast.stepIndex
                delete this.state.cards[n]
            }
        })
        layers.forEach(({ name, config: fc }) => {
            if (!this.state.cards[name]) {
                this.state.cards[name] = { stepIndex: 0 }
                // Mark on the layer data so TimeControl skips this layer
                fc.stepIndex = 0
                if (fc.urlTemplate) this._applyUrlTemplate(name, 1)
            }
        })

        // Rebuild the strip in attached mode (always in DOM, shown by TimeUI expand)
        const strip = document.getElementById('ftl-strip')
        if (strip) {
            const cardsHTML = layers.map(({ name, config: fc }) =>
                this._buildCardHTML(name, fc, false)
            ).join('')
            strip.innerHTML = layers.length > 0
                ? `<div id="ftl-strip-label"><i class="mdi mdi-weather-cloudy-clock"></i> FORECAST ACTIVE</div>${cardsHTML}`
                : ''
            layers.forEach(({ name, config: fc }) => {
                this._attachCardHandlers(name, fc, strip)
                this._renderCardStep(name, fc, strip)
            })
        }
        this._adjustTimeUIHeight()

        // Also rebuild detached panel if visible
        if (this.state.detached) {
            this._rebuildDetachedCards()
        }

        // Toggle button always visible
        const btn = document.getElementById('ftl-toggle-btn')
        if (btn) btn.style.display = ''
    },

    _rebuildDetachedCards: function () {
        const layers = this._detectForecastLayers()
        const container = document.getElementById('ftl-detached-cards')
        if (!container) return

        container.innerHTML = layers.map(({ name, config: fc }) =>
            this._buildCardHTML(name, fc, true)
        ).join('')

        layers.forEach(({ name, config: fc }) => {
            this._attachCardHandlers(name, fc, container)
            this._renderCardStep(name, fc, container)
        })
    },

    _refreshAllCards: function () {
        const layers = this._detectForecastLayers()
        const strip = document.getElementById('ftl-strip')
        const detachedCards = document.getElementById('ftl-detached-cards')

        layers.forEach(({ name, config: fc }) => {
            if (strip) this._renderCardStep(name, fc, strip)
            if (detachedCards) this._renderCardStep(name, fc, detachedCards)
        })
    },

    // ── Card HTML ──────────────────────────────────────────

    _buildCardHTML: function (name, fc, large) {
        const steps = fc.steps || 1
        const unit = fc.stepUnit || 'hour'
        const label = fc.label || name
        const originMs = this.state.originMs || Date.now()
        const unitMs = STEP_UNITS[unit] || STEP_UNITS.hour

        // Use native TimeUI classes in attached mode so rows blend in perfectly
        const tickClass = large ? 'ftl-tick ftl-tick-large' : 'ftl-tick mmgisTimeUIExpandedItem'
        const ticks = Array.from({ length: steps }, (_, i) => {
            const stepMs = originMs + (i + 1) * unitMs
            const stepDate = new Date(stepMs)

            let clockLbl, relLbl
            if (unit === 'day') {
                clockLbl = stepDate.toLocaleString('en-US', {
                    timeZone: PDT_TZ,
                    month: 'short',
                    day: 'numeric',
                })
                relLbl = i === 0 ? 'Today' : `+${i}`
            } else {
                // Round down to the hour boundary in PDT
                const hourRounded = new Date(stepMs)
                hourRounded.setMinutes(0, 0, 0)
                clockLbl = hourRounded.toLocaleString('en-US', {
                    timeZone: PDT_TZ,
                    hour: 'numeric',
                    hour12: true,
                })
                relLbl = `hr${i + 1}`
            }
            return `<div class="${tickClass} ftl-tick-twoline" data-layer="${name}" data-step="${i}"><span class="ftl-tick-clock">${clockLbl}</span><span class="ftl-tick-rel">${relLbl}</span></div>`
        }).join('')

        const rowClass = large ? 'ftl-card ftl-card-large' : 'ftl-card mmgisTimeUIExpandedRow'
        const ticksWrapClass = large ? 'ftl-ticks-wrap' : 'ftl-ticks-wrap mmgisTimeUIExpandedRowContainer'

        return `
<div class="${rowClass}" data-layer="${name}">
  <div class="ftl-card-header">
    <span class="ftl-card-label">${label}</span>
    <span class="ftl-card-origin"></span>
  </div>
  <div class="ftl-card-body">
    <button class="ftl-card-prev" data-layer="${name}"><i class="mdi mdi-chevron-left"></i></button>
    <div class="${ticksWrapClass}">
      <div class="ftl-ticks">${ticks}</div>
    </div>
    <button class="ftl-card-next" data-layer="${name}"><i class="mdi mdi-chevron-right"></i></button>
  </div>
</div>`
    },

    // ── Card event handlers ────────────────────────────────

    _attachCardHandlers: function (name, fc, container) {
        container.querySelectorAll(`.ftl-tick[data-layer="${name}"]`).forEach((el) => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.step)
                this._setCardStep(name, fc, idx)
            })
        })
        container.querySelector(`.ftl-card-prev[data-layer="${name}"]`)
            ?.addEventListener('click', () => {
                const cur = this.state.cards[name]?.stepIndex ?? 0
                this._setCardStep(name, fc, Math.max(0, cur - 1))
            })
        container.querySelector(`.ftl-card-next[data-layer="${name}"]`)
            ?.addEventListener('click', () => {
                const cur = this.state.cards[name]?.stepIndex ?? 0
                const max = (fc.steps || 1) - 1
                this._setCardStep(name, fc, Math.min(max, cur + 1))
            })
    },

    // ── Step logic ─────────────────────────────────────────

    _setCardStep: function (name, fc, idx) {
        if (!this.state.cards[name]) return
        this.state.cards[name].stepIndex = idx
        this._refreshAllCards()
        this._applyCardStep(name, fc, idx)
    },

    _renderCardStep: function (name, fc, container) {
        const card = container?.querySelector(`.ftl-card[data-layer="${name}"]`)
        if (!card) return

        const idx = this.state.cards[name]?.stepIndex ?? 0
        const steps = fc.steps || 1
        const unit = fc.stepUnit || 'hour'
        const originMs = this.state.originMs || Date.now()

        const unitMs = STEP_UNITS[unit] || STEP_UNITS.hour
        card.querySelectorAll('.ftl-tick').forEach((el, i) => {
            el.classList.toggle('active', i === idx)
            const clockEl = el.querySelector('.ftl-tick-clock')
            if (clockEl) {
                const stepMs2 = originMs + (i + 1) * unitMs
                if (unit === 'day') {
                    const stepDate = new Date(stepMs2)
                    clockEl.textContent = stepDate.toLocaleString('en-US', {
                        timeZone: PDT_TZ,
                        month: 'short',
                        day: 'numeric',
                    })
                } else {
                    const hourRounded = new Date(stepMs2)
                    hourRounded.setMinutes(0, 0, 0)
                    clockEl.textContent = hourRounded.toLocaleString('en-US', {
                        timeZone: PDT_TZ,
                        hour: 'numeric',
                        hour12: true,
                    })
                }
            }
        })

        const originEl = card.querySelector('.ftl-card-origin')
        if (originEl) {
            const stepTime = new Date(originMs + (idx + 1) * (STEP_UNITS[unit] || STEP_UNITS.hour))
            const hourStr = stepTime.toLocaleString('en-US', {
                timeZone: PDT_TZ,
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
                timeZoneName: 'short',
            })
            originEl.textContent = 'Active: ' + hourStr
        }

        card.querySelector('.ftl-card-prev')?.toggleAttribute('disabled', idx === 0)
        card.querySelector('.ftl-card-next')?.toggleAttribute('disabled', idx === steps - 1)
    },

    _applyCardStep: function (name, fc, idx) {
        const unitMs = STEP_UNITS[fc.stepUnit] || STEP_UNITS.hour
        const originMs = this.state.originMs || Date.now()
        const stepMs = originMs + (idx + 1) * unitMs

        // Mark stepIndex on the layer data so the main TimeControl loop
        // (setTime → reloadAllLayers) skips this layer while a forecast
        // step is active.  This prevents the layer from being reloaded
        // at the "normal" timeline time on top of the forecast step.
        fc.stepIndex = idx

        if (fc.urlTemplate) {
            this._applyUrlTemplate(name, idx + 1)
        } else {
            // Reload just this layer at the forecast step time.
            // For tile layers (STAC/COG), we update the Leaflet layer
            // options directly and force a tile refresh — calling
            // reloadLayer with forceRequery corrupts STAC URLs by
            // injecting nocache params into the stac-collection: protocol.
            const ld = L_.layers.data[name]
            if (!ld || !L_.layers.on[name]) return

            const stepIso = new Date(stepMs).toISOString()
            const startIso = new Date(stepMs - unitMs).toISOString()

            const prevStart = ld.time.start
            const prevEnd = ld.time.end

            ld.time.start = startIso
            ld.time.end = stepIso

            if (ld.type === 'tile') {
                // Update tile layer options then force-refresh existing tiles
                TimeControl.setLayerWmsParams(ld)
                const leafletLayer = L_.layers.layer[name]
                if (leafletLayer) leafletLayer.refresh(null, true)
            } else {
                TimeControl.reloadLayer(ld, false, false, false)
            }

            ld.time.start = prevStart
            ld.time.end = prevEnd
        }
    },

    _applyUrlTemplate: function (name, stepNumber) {
        const ld = L_.layers.data[name]
        if (!ld) return

        if (!ld.time.forecast._baseUrl) {
            ld.time.forecast._baseUrl = ld.url
        }

        const newUrl = ld.time.forecast._baseUrl.replace(/__FSTEP__/g, String(stepNumber))
        ld.url = newUrl

        const leafletLayer = L_.layers.layer[name]
        if (leafletLayer && L_.layers.on[name] && ld.tileformat === 'wms') {
            const urlSplit = newUrl.split('?')
            const newBase = urlSplit[0]
            const urlParams = new URLSearchParams(urlSplit[1] || '')

            leafletLayer._url = newBase

            const layersVal = urlParams.get('layers') || urlParams.get('LAYERS')
            if (layersVal) {
                leafletLayer.setParams({ LAYERS: layersVal }, true)
            }
            leafletLayer.redraw()
        } else if (TimeControl?.reloadLayer && L_.layers.on[name]) {
            TimeControl.reloadLayer(ld, false, false, true)
        }
    },

    // ── TimeControl callback ───────────────────────────────

    _onTimeChange: function (timeData) {
        if (this._applyingStep) return
        if (timeData?.currentTime) {
            this.state.originMs = new Date(timeData.currentTime).getTime()
            if (this.state.detached) this._updatePickerDisplay()
            this._refreshAllCards()
        }
    },

    // ── Formatting ─────────────────────────────────────────

    _formatPDT: function (d, dateOnly) {
        if (!(d instanceof Date) || isNaN(d)) return '—'
        if (dateOnly) {
            return d.toLocaleDateString('en-US', {
                timeZone: PDT_TZ,
                month: 'short',
                day: 'numeric',
                year: 'numeric',
            })
        }
        return d.toLocaleString('en-US', {
            timeZone: PDT_TZ,
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short',
        })
    },

    // ── Monkey-patch: skip forecast layers in main reload ─

    _patchReloadTimeLayers: function () {
        if (this._origReloadTimeLayers) return // already patched
        const orig = TimeControl.reloadTimeLayers.bind(TimeControl)
        this._origReloadTimeLayers = TimeControl.reloadTimeLayers

        const self = this
        TimeControl.reloadTimeLayers = async function () {
            // Temporarily mark forecast-managed layers so the original loop
            // (which checks layer.time.enabled) will still iterate them but
            // we can intercept.  We wrap by setting a transient flag that
            // the original code doesn't know about — instead we pre-filter
            // by temporarily disabling time on forecast layers.
            const suppressed = []
            for (const name in self.state.cards) {
                const ld = L_.layers.data[name]
                if (ld?.time?.enabled && ld.time.forecast?.stepIndex != null) {
                    ld.time._ftlSuppressed = true
                    ld.time.enabled = false
                    suppressed.push(ld)
                }
            }
            try {
                return await orig()
            } finally {
                suppressed.forEach((ld) => {
                    ld.time.enabled = true
                    delete ld.time._ftlSuppressed
                })
            }
        }
    },

    _unpatchReloadTimeLayers: function () {
        if (this._origReloadTimeLayers) {
            TimeControl.reloadTimeLayers = this._origReloadTimeLayers
            this._origReloadTimeLayers = null
        }
    },

    // ── Bottom-element repositioning ─────────────────────────

    _observeTimeUIHeight: function () {
        const tryObserve = () => {
            const timeUIEl = document.getElementById('timeUI')
            if (!timeUIEl) {
                // #timeUI not yet in DOM — retry
                setTimeout(tryObserve, 500)
                return
            }
            this._lastTimeUIHeight = timeUIEl.offsetHeight
            this._heightObserver = new MutationObserver(() => {
                const h = timeUIEl.offsetHeight
                if (h !== this._lastTimeUIHeight) {
                    this._lastTimeUIHeight = h
                    this._repositionBottomElements(h)
                }
            })
            this._heightObserver.observe(timeUIEl, {
                attributes: true,
                attributeFilter: ['class', 'style'],
            })
        }
        tryObserve()
    },

    _repositionBottomElements: function (timeUIHeight) {
        // Mirrors the offset arithmetic in BottomElementPositioner but only
        // adjusts the delta caused by forecast cards.  The core positioner
        // uses hardcoded 177 / 40 for expanded / collapsed.  We compute
        // how much taller #timeUI actually is and add that as extra margin.
        const timeUIEl = document.getElementById('timeUI')
        if (!timeUIEl) return

        const isExpanded = timeUIEl.classList.contains('expanded') ||
            timeUIEl.classList.contains('defaultExpanded')
        const baseH = isExpanded ? 177 : 40
        const extraH = Math.max(0, timeUIHeight - baseH)

        // Nudge every bottom-anchored element by the extra amount.
        // We use a CSS custom property so we don't fight the core positioner.
        document.documentElement.style.setProperty(
            '--ftl-extra-bottom', extraH + 'px'
        )
    },

    // ── Cleanup ────────────────────────────────────────────

    cleanup: function () {
        // Clear stepIndex on all forecast layers so TimeControl resumes them
        for (const name in this.state.cards) {
            const ld = L_.layers.data[name]
            if (ld?.time?.forecast) delete ld.time.forecast.stepIndex
        }
        this.state.cards = {}
        this.state.detached = false

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

        // Restore original reloadTimeLayers
        this._unpatchReloadTimeLayers()

        if (TimeControl?.unsubscribe) TimeControl.unsubscribe('forecastTimeline')
        L_.unsubscribeOnLayerToggle('forecastTimeline')

        document.getElementById('ftl-strip')?.remove()
        document.getElementById('ftl-toggle-btn')?.remove()
        document.getElementById('ftl-detached')?.remove()
    },
}

export default ForecastTimeline

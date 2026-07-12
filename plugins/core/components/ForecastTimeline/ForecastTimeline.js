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
 *   { enabled: true, label: "WFPI Daily",  steps: 7,  stepUnit: "day", stepOffset: 0 }
 *
 * stepOffset (required — must be set explicitly in each layer's time.forecast config):
 *   - 0: first step = model init time (e.g. WFPI day-1=today, HRRR fxx=0)
 *   - 1: first step = init + 1 unit (e.g. PWWB hourly, where H1 = init+1h)
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

        // ── Bottom-element repositioning ──
        // Watch #timeUI height changes (caused by _adjustTimeUIHeight adding
        // forecast card rows) and push compass / legend / scalebar up so
        // nothing clips.  This replaces the core uiStore + BottomElement-
        // Positioner changes with a self-contained plugin-side observer.
        this._observeTimeUIHeight()

        // Inject after TimeUI has rendered its DOM
        this._waitAndInject()

        // Patch expanded rows to grey future items
        this._patchPopulateExpandedRows()

        // Patch TimeUI navigation to prevent stepping past wall-clock "now"
        this._patchTimeUINavigation()

        if (TimeControl.subscribe) {
            TimeControl.subscribe('forecastTimeline', (td) =>
                this._onTimeChange(td)
            )
        }

        L_.subscribeOnLayerToggle('forecastTimeline', () =>
            this._rebuildCards()
        )

        // Initial Next button state (after TimeUI DOM is ready)
        setTimeout(() => this._updateNextButtonState(), 1000)
    },

    // ── Global timeline: grey + block future items in expanded rows ───

    _patchPopulateExpandedRows: function () {
        if (this._origPopulateExpandedRows) return
        this._origPopulateExpandedRows = TimeUI._populateExpandedRows

        const self = this
        TimeUI._populateExpandedRows = function () {
            self._origPopulateExpandedRows.call(TimeUI)
            self._markFutureExpandedItems()
        }
    },

    _unpatchPopulateExpandedRows: function () {
        if (this._origPopulateExpandedRows) {
            TimeUI._populateExpandedRows = this._origPopulateExpandedRows
            this._origPopulateExpandedRows = null
        }
    },

    // After _populateExpandedRows builds the DOM, mark items that represent
    // future times with .ftl-future-item so CSS greys them and we block clicks.
    _markFutureExpandedItems: function () {
        const now = new Date()
        const nowYear = now.getFullYear()
        const nowMonth = now.getMonth()      // 0-indexed
        const nowDay = now.getDate()
        const nowHour = now.getHours()

        // _endTimestamp is a raw UTC ms value; read it using local accessors
        // so shownYear/Month/Day match what the user sees in the UI.
        const endDate = new Date(TimeUI._endTimestamp)
        const shownYear = endDate.getFullYear()
        const shownMonth = endDate.getMonth() // 0-indexed
        const shownDay = endDate.getDate()

        // Years: grey years AFTER current year
        document.querySelectorAll('#mmgisTimeUIYearsContainer .mmgisTimeUIExpandedItem').forEach((el) => {
            const yr = parseInt(el.getAttribute('data-year'))
            el.classList.toggle('ftl-future-item', yr > nowYear)
        })

        // Months: grey months after current month IF we're in the current year
        document.querySelectorAll('#mmgisTimeUIMonthsContainer .mmgisTimeUIExpandedItem').forEach((el) => {
            const mo = parseInt(el.getAttribute('data-month')) // 0-indexed
            let future = false
            if (shownYear > nowYear) {
                future = true
            } else if (shownYear === nowYear && mo > nowMonth) {
                future = true
            }
            el.classList.toggle('ftl-future-item', future)
        })

        // Days: grey days after today IF we're in the current year+month
        document.querySelectorAll('#mmgisTimeUIDaysContainer .mmgisTimeUIExpandedItem').forEach((el) => {
            const day = parseInt(el.getAttribute('data-day'))
            let future = false
            if (shownYear > nowYear) {
                future = true
            } else if (shownYear === nowYear && shownMonth > nowMonth) {
                future = true
            } else if (shownYear === nowYear && shownMonth === nowMonth && day > nowDay) {
                future = true
            }
            el.classList.toggle('ftl-future-item', future)
        })

        // Hours: grey hours after the current hour IF we're on today
        document.querySelectorAll('#mmgisTimeUIHoursContainer .mmgisTimeUIExpandedItem').forEach((el) => {
            const hr = parseInt(el.getAttribute('data-hour'))
            let future = false
            if (shownYear > nowYear) {
                future = true
            } else if (shownYear === nowYear && shownMonth > nowMonth) {
                future = true
            } else if (shownYear === nowYear && shownMonth === nowMonth) {
                if (shownDay > nowDay) {
                    future = true
                } else if (shownDay === nowDay && hr > nowHour) {
                    future = true
                }
            }
            el.classList.toggle('ftl-future-item', future)
        })
    },

    // ── Global timeline clamp: prevent navigating past "now" ───────────

    _patchTimeUINavigation: function () {
        if (this._origLoopTime) return // already patched
        const origLoop = TimeUI._loopTime?.bind(TimeUI)
        if (!origLoop) return
        this._origLoopTime = TimeUI._loopTime

        const self = this
        TimeUI._loopTime = function (loopBackwards) {
            origLoop(loopBackwards)
            // After the step, clamp to now if we went too far (all in local display space)
            const now = new Date()
            const nowHourFloor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0).getTime()
            const cur = TimeUI.getCurrentTimestamp
                ? TimeUI.removeOffset(TimeUI.getCurrentTimestamp())
                : 0
            if (cur > nowHourFloor) {
                // Snap back to the current hour floor (updateTimes takes display-local ms)
                TimeUI.updateTimes?.(null, nowHourFloor, nowHourFloor)
                if (TimeUI.play) TimeUI.togglePlay?.(false)
            }
            self._updateNextButtonState()
        }
    },

    _unpatchTimeUINavigation: function () {
        if (this._origLoopTime) {
            TimeUI._loopTime = this._origLoopTime
            this._origLoopTime = null
        }
    },

    _updateNextButtonState: function () {
        const now = new Date()
        // Floor now to the current wall-clock hour
        const nowHourFloor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0).getTime()
        // getCurrentTimestamp returns the display-local ms (same space as removeOffset)
        const cur = TimeUI.getCurrentTimestamp ? TimeUI.removeOffset(TimeUI.getCurrentTimestamp()) : 0
        const atOrPastNow = cur >= nowHourFloor

        const nextBtn = document.getElementById('mmgisTimeUIBottomNext')
        if (nextBtn) {
            nextBtn.toggleAttribute('disabled', atOrPastNow)
            nextBtn.style.opacity = atOrPastNow ? '0.2' : ''
            nextBtn.style.cursor = atOrPastNow ? 'default' : ''
            nextBtn.style.pointerEvents = atOrPastNow ? 'none' : ''
        }
        const playBtn = document.getElementById('mmgisTimeUIPlay')
        if (playBtn && TimeUI.play && atOrPastNow) {
            TimeUI.togglePlay?.(false)
        }
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
        // Match the core BottomElementPositioner, which treats both 'expanded'
        // and the initial 'defaultExpanded' marker as expanded. Checking only
        // 'expanded' here meant a default-expanded timeline never grew for the
        // forecast rows and never published --ftl-extra-bottom — so the strip
        // spilled upward over the compass and clipped it.
        const isExpanded = timeUI.classList.contains('expanded') ||
            timeUI.classList.contains('defaultExpanded')
        const layers = this._detectForecastLayers()
        const cardCount = layers.length
        // Expanded cards are 44px each; collapsed cards become tabs (0px each)
        // but add a single 28px tab row if any exist. +10px for expandedContent padding.
        const collapsedCount = layers.filter(({ name }) => this.state.cards[name]?.collapsed).length
        const expandedCount = cardCount - collapsedCount
        const tabRowH = collapsedCount > 0 ? 28 : 0
        const extraH = (isExpanded && cardCount > 0) ? (expandedCount * 44 + tabRowH + 10) : 0
        if (extraH > 0) {
            // #timeUI base expanded = 177px; #mmgisTimeUIExpandedContent base = 137px
            timeUI.style.height = (177 + extraH) + 'px'
            expandedContent.style.height = (137 + extraH) + 'px'
            expandedContent.style.overflow = 'visible'
        } else {
            timeUI.style.height = ''
            expandedContent.style.height = ''
            expandedContent.style.overflow = ''
        }
        // Lock the bottom-element offset to the strip's real extra height so the
        // compass (and scalebar / legend) always clear the taller timeline.
        this._repositionBottomElements()
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
    <i class="mdi mdi-weather-cloudy-clock"></i>&nbsp;FORECAST MODE
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
        panel.querySelector('#ftl-hour-pick')?.addEventListener('change', () => this._applyPickerTime())
        panel.querySelector('#ftl-min-pick')?.addEventListener('change', () => this._applyPickerTime())

        // Date: open the native picker on a click anywhere in the field, not
        // just the tiny calendar icon. showPicker() needs a user gesture (this
        // click is one) and may throw if unsupported / already open — ignore.
        const dateEl = panel.querySelector('#ftl-date-pick')
        if (dateEl) {
            dateEl.addEventListener('change', () => this._applyPickerTime())
            dateEl.addEventListener('click', () => {
                try { dateEl.showPicker?.() } catch (e) { /* noop */ }
            })
        }

        // Hour / minute: scroll the wheel to step the value (wraps at bounds).
        this._attachWheelStep(panel.querySelector('#ftl-hour-pick'), 0, 23)
        this._attachWheelStep(panel.querySelector('#ftl-min-pick'), 0, 59)
    },

    // Wheel-to-step a numeric picker input, wrapping around min/max, then apply.
    _attachWheelStep: function (el, min, max) {
        if (!el) return
        el.addEventListener('wheel', (e) => {
            e.preventDefault()
            const cur = parseInt(el.value)
            const base = isNaN(cur) ? min : cur
            let next = base + (e.deltaY < 0 ? 1 : -1)
            if (next < min) next = max
            else if (next > max) next = min
            el.value = String(next).padStart(2, '0')
            this._applyPickerTime()
        }, { passive: false })
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
        // Re-offset the compass / scalebar / legend for the new mode (detached
        // panel height vs. docked timeline height).
        this._repositionBottomElements()
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
        Object.keys(this.state.cards).forEach((n) => {
            if (!activeNames.has(n)) delete this.state.cards[n]
        })
        layers.forEach(({ name, config: fc }) => {
            if (!this.state.cards[name]) {
                this.state.cards[name] = { stepIndex: 0, collapsed: false }
                if (fc.urlTemplate) this._applyUrlTemplate(name, 1)
            }
        })

        // Rebuild the strip in attached mode (always in DOM, shown by TimeUI expand)
        const strip = document.getElementById('ftl-strip')
        if (strip) {
            strip.innerHTML = this._buildStripHTML(layers, false)
            layers.forEach(({ name, config: fc }) => {
                this._attachCardHandlers(name, fc, strip)
                this._renderCardStep(name, fc, strip)
            })
            this._attachTabHandlers(strip)
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

        container.innerHTML = this._buildStripHTML(layers, true)

        layers.forEach(({ name, config: fc }) => {
            this._attachCardHandlers(name, fc, container)
            this._renderCardStep(name, fc, container)
        })
        this._attachTabHandlers(container)

        // Panel height depends on how many cards were just rendered — re-offset
        // the bottom elements so they clear the (possibly taller) detached panel.
        if (this.state.detached) this._repositionBottomElements()
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

    _reapplyAllSteps: function () {
        if (this._reapplying) return
        this._reapplying = true
        const layers = this._detectForecastLayers()
        layers.forEach(({ name, config: fc }) => {
            const idx = this.state.cards[name]?.stepIndex ?? 0
            this._applyCardStep(name, fc, idx)
        })
        this._reapplying = false
    },

    // ── Origin / step helpers ──────────────────────────────

    // Model init time floored to the current hour's :00 (e.g. 02:55 → 02:00).
    // All forecast steps are generated from this floored base so ticks land on
    // clean hour boundaries and the "MODEL INITIALIZED AT" readout matches.
    _originBase: function () {
        const d = new Date(this.state.originMs || Date.now())
        d.setMinutes(0, 0, 0)
        return d.getTime()
    },

    // Per-layer configurable step label. time.forecast.stepLabel wins;
    // otherwise derived from stepSize (default 1) + stepUnit ("hour"/"day").
    _stepLabel: function (fc) {
        if (fc.stepLabel) return fc.stepLabel
        const size = fc.stepSize || 1
        const unit = fc.stepUnit || 'hour'
        const abbr =
            unit === 'day'
                ? size === 1 ? 'day' : 'days'
                : size === 1 ? 'hr' : 'hrs'
        return `${size} ${abbr}`
    },

    // "Jun 30, 2026 · 2:00 PM PDT"  (hourly)  or  "Jul 7, 2026 · 12:00 AM PDT"  (daily)
    _formatInit: function (ms, unit) {
        const d = new Date(ms)
        const dateStr = d.toLocaleDateString('en-US', {
            timeZone: PDT_TZ,
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        })
        if (unit === 'day') {
            return dateStr
        }
        const timeStr = d.toLocaleTimeString('en-US', {
            timeZone: PDT_TZ,
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZoneName: 'short',
        })
        return `${dateStr} · ${timeStr}`
    },

    // ── Card HTML ──────────────────────────────────────────

    _buildCardHTML: function (name, fc, large) {
        const steps = fc.steps || 1
        const unit = fc.stepUnit || 'hour'
        const label = fc.label || name
        const originBase = this._originBase()
        const unitMs = STEP_UNITS[unit] || STEP_UNITS.hour
        const initStr = this._formatInit(originBase, unit)

        // Use native TimeUI classes in attached mode so rows blend in perfectly
        const tickClass = large ? 'ftl-tick ftl-tick-large' : 'ftl-tick mmgisTimeUIExpandedItem'
        const ticks = Array.from({ length: steps }, (_, i) => {
            // Steps are generated from the hour-floored base, so they already
            // land on clean boundaries — no per-tick rounding needed.
            const offset = fc.stepOffset
            const stepDate = new Date(originBase + (i + offset) * unitMs)

            let clockLbl, relLbl
            if (unit === 'day') {
                clockLbl = stepDate.toLocaleString('en-US', {
                    timeZone: PDT_TZ,
                    month: 'short',
                    day: 'numeric',
                })
                // Label based on actual offset: offset=0 → "Today", offset=1 → "Tomorrow"
                if (i === 0 && offset === 0) {
                    relLbl = 'Today'
                // } else if (i === 0 && offset === 1) {
                //     relLbl = 'Tomorrow'
                } else {
                    relLbl = `+${i + offset}`
                }
            } else {
                clockLbl = stepDate.toLocaleString('en-US', {
                    timeZone: PDT_TZ,
                    hour: 'numeric',
                    hour12: true,
                })
                relLbl = `h${i + offset}`
            }
            return `<div class="${tickClass} ftl-tick-twoline" data-layer="${name}" data-step="${i}"><span class="ftl-tick-clock">${clockLbl}</span><span class="ftl-tick-rel">${relLbl}</span></div>`
        }).join('')

        const rowClass = large ? 'ftl-card ftl-card-large' : 'ftl-card'
        const ticksWrapClass = large ? 'ftl-ticks-wrap' : 'ftl-ticks-wrap mmgisTimeUIExpandedRowContainer'

        const unitWord = unit === 'day' ? 'daily' : unit === 'week' ? 'weekly' : 'hourly'
        const unitPlural = unit === 'day' ? 'days' : unit === 'week' ? 'weeks' : 'hrs'
        const forecastChipLabel = `${unitWord} / ${steps} ${unitPlural}`

        const isCollapsed = this.state.cards[name]?.collapsed === true
        const collapsedAttr = isCollapsed ? ' ftl-card-collapsed' : ''

        return `
<div class="${rowClass}${collapsedAttr}" data-layer="${name}">
  <div class="ftl-card-header">
    <button class="ftl-card-collapse-btn" data-layer="${name}" title="${isCollapsed ? 'Expand' : 'Collapse'}">
      <i class="mdi ${isCollapsed ? 'mdi-window-restore' : 'mdi-window-minimize'} mdi-18px"></i>
    </button>
    <div class="ftl-card-hdr-left">
      <span class="ftl-card-forecast-title">FORECAST</span>
      <span class="ftl-card-forecast-chip">${forecastChipLabel}</span>
    </div>
    <div class="ftl-card-hdr-right">
      <span class="ftl-card-label">${label}</span>
      <div class="ftl-card-init-row">
        <span class="ftl-card-init-caption">INITIALIZED:</span>
        <span class="ftl-card-init">${initStr}</span>
      </div>
    </div>
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
        container.querySelector(`.ftl-card-collapse-btn[data-layer="${name}"]`)
            ?.addEventListener('click', () => {
                this._toggleCardCollapsed(name)
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

        const wrap = container.querySelector(`.ftl-card[data-layer="${name}"] .ftl-ticks-wrap`)
        if (wrap) {
            let startX = 0
            let startY = 0
            wrap.addEventListener('touchstart', (e) => {
                startX = e.touches[0].clientX
                startY = e.touches[0].clientY
            }, { passive: true })
            wrap.addEventListener('touchmove', (e) => {
                const dx = Math.abs(e.touches[0].clientX - startX)
                const dy = Math.abs(e.touches[0].clientY - startY)
                if (dx > dy) e.stopPropagation()
            }, { passive: true })
        }
    },

    _toggleCardCollapsed: function (name) {
        if (!this.state.cards[name]) return
        this.state.cards[name].collapsed = !this.state.cards[name].collapsed
        this._rebuildCards()
    },

    _buildStripHTML: function (layers, large) {
        if (layers.length === 0) return ''
        const collapsed = layers.filter(({ name }) => this.state.cards[name]?.collapsed)
        const expanded = layers.filter(({ name }) => !this.state.cards[name]?.collapsed)

        const tabsHTML = collapsed.length > 0
            ? `<div class="ftl-tabs-row">${collapsed.map(({ name, config: fc }) =>
                `<button class="ftl-tab" data-layer="${name}" title="Expand ${fc.label || name}">${fc.label || name}</button>`
              ).join('')}</div>`
            : ''

        const cardsHTML = expanded.map(({ name, config: fc }) =>
            this._buildCardHTML(name, fc, large)
        ).join('')

        return tabsHTML + cardsHTML
    },

    _attachTabHandlers: function (container) {
        container.querySelectorAll('.ftl-tab').forEach((btn) => {
            btn.addEventListener('click', () => {
                this._toggleCardCollapsed(btn.dataset.layer)
            })
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
        const originBase = this._originBase()

        const unitMs = STEP_UNITS[unit] || STEP_UNITS.hour
        const offset = fc.stepOffset

        card.querySelectorAll('.ftl-tick').forEach((el, i) => {
            el.classList.toggle('active', i === idx)
            const stepDate = new Date(originBase + (i + offset) * unitMs)

            const clockEl = el.querySelector('.ftl-tick-clock')
            if (clockEl) {
                clockEl.textContent =
                    unit === 'day'
                        ? stepDate.toLocaleString('en-US', {
                              timeZone: PDT_TZ,
                              month: 'short',
                              day: 'numeric',
                          })
                        : stepDate.toLocaleString('en-US', {
                              timeZone: PDT_TZ,
                              hour: 'numeric',
                              hour12: true,
                          })
            }
        })

        // Keep the "MODEL INITIALIZED AT" readout in sync as the origin tracks
        // the main timeline selection.
        const initEl = card.querySelector('.ftl-card-init')
        if (initEl) initEl.textContent = this._formatInit(originBase, unit)

        card.querySelector('.ftl-card-prev')?.toggleAttribute('disabled', idx === 0)
        card.querySelector('.ftl-card-next')?.toggleAttribute('disabled', idx === steps - 1)
    },

    _applyCardStep: function (name, fc, idx) {
        const unitMs = STEP_UNITS[fc.stepUnit] || STEP_UNITS.hour
        const originMs = this._originBase()
        const offset = fc.stepOffset
        let stepMs = originMs + (idx + offset) * unitMs

        // WFPI (and any daily product): always fetch at UTC midnight of the
        // PDT calendar date so requests align with the model init time (00:00Z)
        // regardless of what hour the global timeline shows.
        if (fc.stepUnit === 'day') {
            const stepDatePDT = new Date(stepMs).toLocaleDateString('en-CA', { timeZone: PDT_TZ })
            stepMs = new Date(`${stepDatePDT}T00:00:00Z`).getTime()
        }

        // Mark stepIndex on the layer data so the main TimeControl loop
        // (setTime → reloadAllLayers) skips this layer while a forecast
        // step is active.  This prevents the layer from being reloaded
        // at the "normal" timeline time on top of the forecast step.
        fc.stepIndex = idx

        if (fc.urlTemplate) {
            // URL templates use 1-based indexing (forecast-1, forecast-2, etc)
            this._applyUrlTemplate(name, idx + 1)
        } else {
            // Reload just this layer at the forecast step time.
            // For tile layers (STAC/COG), we update the Leaflet layer
            // options directly and force a tile refresh — calling
            // reloadLayer with forceRequery corrupts STAC URLs by
            // injecting nocache params into the stac-collection: protocol.
            const ld = L_.layers.data[name]
            if (!ld || !L_.layers.on[name]) return

            if (ld.type === 'tile' && (ld.url || '').toUpperCase().startsWith('COG:')) {
                // COG layers embed the time in the URL itself via the veloserver.
                // TODO: when veloserver supports fxx, replace this stub with:
                //   const fxxUrl = ld.url.replace(/(&|\?)fxx=\d+/, '') + `&fxx=${idx}`
                //   leafletLayer._url = fxxUrl (or however the COG URL is set)
                //   leafletLayer.refresh(null, true)
                console.log(`[ForecastTimeline] fxx step: layer="${name}" fxx=${idx} stepMs=${new Date(stepMs).toISOString()}`)
                return
            }

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
        if (this._applyingStep || this._reapplying) return
        if (timeData?.currentTime) {
            this.state.originMs = new Date(timeData.currentTime).getTime()
            if (this.state.detached) this._updatePickerDisplay()
            this._refreshAllCards()
            this._reapplyAllSteps()
            this._updateNextButtonState()
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

    // ── Bottom-element repositioning ─────────────────────────

    _observeTimeUIHeight: function () {
        const tryObserve = () => {
            const timeUIEl = document.getElementById('timeUI')
            if (!timeUIEl) {
                // #timeUI not yet in DOM — retry
                setTimeout(tryObserve, 500)
                return
            }
            // Whenever the core toggles #timeUI's expand class (or its height),
            // re-derive the strip height + bottom offset. _adjustTimeUIHeight is
            // idempotent, so re-setting an unchanged height produces no further
            // mutation and the observer settles immediately.
            this._heightObserver = new MutationObserver(() => this._adjustTimeUIHeight())
            this._heightObserver.observe(timeUIEl, {
                attributes: true,
                attributeFilter: ['class', 'style'],
            })
            this._adjustTimeUIHeight()
        }
        tryObserve()
    },

    _repositionBottomElements: function () {
        // The core BottomElementPositioner offsets every bottom-anchored element
        // (compass, scalebar, legend, coordinates…) off a HARDCODED timeUI dock
        // height of 177 (expanded) / 40 (collapsed). We keep those elements clear
        // of whatever the forecast plugin adds at the bottom, in two modes:
        const root = document.documentElement

        if (this.state.detached) {
            // ── Detached "forecast mode" ──
            // #timeUI is display:none and replaced by the fixed #ftl-detached
            // panel, but the core still offsets bottom elements as if the main
            // timeline were docked (at its stale collapsed/expanded height). So
            // we OVERRIDE their bottom (via .ftl-detached-mode !important rules)
            // to sit above the actual panel — this both lifts them when the main
            // timeline was collapsed (was clipping) and lowers them when it was
            // expanded (was floating above the panel).
            const panel = document.getElementById('ftl-detached')
            const panelH = panel && !panel.classList.contains('ftl-hidden')
                ? panel.offsetHeight
                : 0
            root.classList.add('ftl-detached-mode')
            root.style.setProperty('--ftl-detached-offset', panelH + 'px')
            root.style.setProperty('--ftl-extra-bottom', '0px')

            // The core's --mmgis-sep-tools-bottom-reserve is computed off the
            // now-hidden main timeline, so it's stale here (e.g. still 177 tall
            // after shrinking into forecast mode). Publish our OWN full reserve
            // based on the ACTUAL detached panel so separated-tool panels (Legend)
            // grow back when forecast mode is shorter than the old timeline, and
            // shrink only once the forecast panel grows tall enough to collide.
            // Mirrors the core formula: containerTop + bottomStack + compass + gap.
            const sepContainer = document.getElementById('toolcontroller_sep_content')
            if (sepContainer) {
                const compassStack = 70 // compass + scale bar height above the bar
                const gap = 12
                const containerTop = sepContainer.getBoundingClientRect().top
                const reserve = containerTop + panelH + compassStack + gap
                root.style.setProperty('--ftl-sep-reserve', reserve + 'px')
            }
            return
        }

        // ── Attached mode ──
        // The forecast strip makes #timeUI taller than the core's hardcoded 177,
        // so publish the exact extra height as a CSS custom property;
        // ForecastTimeline.css adds it as margin-bottom to each bottom element.
        // Derived from the card count (the same formula that grows #timeUI in
        // _adjustTimeUIHeight) rather than a live measurement, so it stays stable
        // during the timeline's expand/collapse transition instead of jittering.
        root.classList.remove('ftl-detached-mode')
        root.style.setProperty('--ftl-detached-offset', '0px')

        const timeUIEl = document.getElementById('timeUI')
        if (!timeUIEl) return

        const isExpanded = timeUIEl.classList.contains('expanded') ||
            timeUIEl.classList.contains('defaultExpanded')
        const layers2 = this._detectForecastLayers()
        const cardCount = layers2.length
        const collapsedCount2 = layers2.filter(({ name }) => this.state.cards[name]?.collapsed).length
        const expandedCount2 = cardCount - collapsedCount2
        const tabRowH2 = collapsedCount2 > 0 ? 28 : 0
        const extraH = (isExpanded && cardCount > 0) ? (expandedCount2 * 44 + tabRowH2 + 10) : 0

        root.style.setProperty('--ftl-extra-bottom', extraH + 'px')
    },

    // ── Cleanup ────────────────────────────────────────────

    cleanup: function () {
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

        // Remove extra bottom offset + detached-mode override
        document.documentElement.classList.remove('ftl-detached-mode')
        document.documentElement.style.removeProperty('--ftl-extra-bottom')
        document.documentElement.style.removeProperty('--ftl-detached-offset')
        document.documentElement.style.removeProperty('--ftl-sep-reserve')

        // Restore TimeUI navigation and expanded rows
        this._unpatchTimeUINavigation()
        this._unpatchPopulateExpandedRows()

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

        document.getElementById('ftl-strip')?.remove()
        document.getElementById('ftl-toggle-btn')?.remove()
        document.getElementById('ftl-detached')?.remove()
    },
}

export default ForecastTimeline

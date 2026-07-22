/**
 * ForecastTimeline - Integrated forecast stepper rows inside TimeUI
 *
 * Injects forecast card rows into TimeUI's expanded content. The main timeline
 *   stays visible and owns the selected time.
 *
 * Layer config: time.forecast block with:
 *   { enabled: true, label: "PWWB Hourly", steps: 24, stepUnit: "hour", stepOffset: 1,
 *     description: "..." }
 *   { enabled: true, label: "WFPI Daily",  steps: 7,  stepUnit: "day",  stepOffset: 0,
 *     runHourUTC: 0, description: "..." }
 *
 * stepOffset (required — must be set explicitly in each layer's time.forecast config):
 *   - 0: first step = model init time (e.g. WFPI day-1=today, HRRR fxx=0)
 *   - 1: first step = init + 1 unit (e.g. PWWB hourly, where H1 = init+1h; a
 *        next-day-only product is steps:1 + stepOffset:1)
 *
 * description (optional): plain-language text shown in the info-icon tooltip —
 *   explain how the product is generated and how far out it forecasts. Authored
 *   per layer; when omitted, the info icon is not shown at all.
 *
 * runHourUTC (daily products, optional; default 0): the UTC hour the model runs.
 *   Daily steps anchor to the latest run at or before the selected time (fixes the
 *   boundary where a PDT calendar date lagged the actual UTC run). WFPI runs at
 *   00:00 UTC (5 PM PDT) → runHourUTC: 0. Set it to each product's real run hour.
 */

import TimeControl from '@basics/TimeControl_/TimeControl'
import TimeUI from '@basics/TimeControl_/TimeUI'
import L_ from '@basics/Layers_/Layers_'
import './ForecastTimeline.css'

// Lazy accessor for the UI store (call-time require avoids a circular import at
// module load, since the store's dependency chain reaches TimeUI).
// Layer names and labels come from mission config, which admins author freely.
// They are written both into generated HTML and into the attribute selectors
// every handler binds by, so they need escaping in two different ways.

// For HTML text nodes and double-quoted attribute values.
function _escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

// For a value inside a quoted CSS attribute selector. This must be built from
// the RAW name, not from _escHtml's output: the browser stores the decoded
// value on the element, so `data-layer="A &amp; B"` in markup is `A & B` in the
// DOM and only `"` and `\` need escaping here. A name containing an apostrophe
// or quote previously produced a selector that silently matched nothing, so
// every prev/next/play/collapse handler on that card quietly did nothing.
function _escSel(s) {
    return String(s == null ? '' : s).replace(/["\\]/g, '\\$&')
}

function _isMobile() {
    try {
        return require('@basics/UserInterface_/store/uiStore').default.getState().isMobile === true
    } catch (e) {
        return false
    }
}

const STEP_UNITS = {
    hour: 3600000,
    day: 86400000,
}

const PDT_TZ = 'America/Los_Angeles'

// HRRR forecast hours: every run reaches F18, but the runs started at 00/06/12/18
// UTC reach F48. fxx == step index, so a COG card offers (max fxx + 1) steps.
const HRRR_FXX_MAX = 18
const HRRR_FXX_MAX_EXTENDED = 48
// The four init hours (UTC) whose runs go all the way to F48.
const HRRR_EXTENDED_INIT_HOURS = [0, 6, 12, 18]

// Delay between animation frames. Slow enough to read the tick labels, fast
// enough that a 49-step HRRR run doesn't take a minute to loop.
const PLAY_INTERVAL_MS = 700

const ForecastTimeline = {
    // ── State ──────────────────────────────────────────────
    state: {
        cards: {},
        originMs: null,
    },

    // Mission config variables (plugin.json → config.rows).
    vars: {},

    // Playback is experimental and off unless a mission opts in via
    // variables.experimentalPlayback. Gated at the single point where the button
    // is built, so nothing downstream needs to know about the flag.
    _playbackEnabled: function () {
        return this.vars?.experimentalPlayback === true
    },

    // ── Lifecycle ──────────────────────────────────────────

    init: function (vars) {
        this.vars = vars || {}
        this.state.originMs = Date.now()

        // Expose the singleton the way core exposes L_/Map_/TimeUI, so card
        // state, probe results and the availability chain are inspectable from
        // the console and assertable from a test. Nothing in this file reads
        // window.ForecastTimeline — it exists purely for observation.
        if (typeof window !== 'undefined') window.ForecastTimeline = this

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

        // Show a forecast card as soon as its layer is toggled on, without
        // waiting for the layer's data to load (see _patchToggleLayer).
        this._optimisticOn = new Set()
        this._toggleTick = {}
        this._patchToggleLayer()

        if (TimeControl.subscribe) {
            TimeControl.subscribe('forecastTimeline', (td) =>
                this._onTimeChange(td)
            )
        }

        L_.subscribeOnLayerToggle('forecastTimeline', (name, isNowOn) => {
            // Once a layer has settled ON, drop its optimistic override (real
            // state covers it). Do NOT drop on an OFF here -- a reload's brief
            // off-then-on would otherwise prune the card mid-refresh.
            if (name && isNowOn === true && this._optimisticOn)
                this._optimisticOn.delete(name)
            // A step-driven fallback reload toggles the layer; skip the rebuild
            // then so it doesn't reset the card's step back to fxx=0.
            if (this._reloadingLayer) return
            this._rebuildCards()
        })

        // Dismiss any open info tooltip on an outside click. The tip anchors
        // stopPropagation their own clicks, so this only fires for interactions
        // elsewhere (including tapping a time tick), which is the desired behavior.
        if (!this._tipDismissHandler) {
            this._tipDismissHandler = (e) => {
                if (!e.target.closest('.ftl-has-tip')) this._hideTip()
            }
            document.addEventListener('click', this._tipDismissHandler)
        }

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

    // Core's L_.toggleLayer notifies its toggle subscribers only AFTER awaiting
    // the layer build. A velocity layer's build is a full grib fetch, so a
    // forecast card would not appear until the wind data finished loading --
    // unlike every other (tile) forecast layer, whose build returns right away.
    // Wrap toggleLayer to optimistically show/remove the card the instant a
    // toggle is requested, from its intended new state; the real toggle
    // subscription reconciles the optimistic set once state settles.
    _patchToggleLayer: function () {
        if (this._origToggleLayer) return
        const orig = L_.toggleLayer.bind(L_)
        this._origToggleLayer = L_.toggleLayer
        const self = this
        L_.toggleLayer = function (s, ...rest) {
            if (s && s.time?.forecast?.enabled === true) {
                const name = s.name
                // reloadLayer refreshes a velocity layer on a time change by
                // toggling it off then on back-to-back (synchronously). Count
                // toggles per tick: a pair is that reload -- keep the card shown
                // right through it. A lone toggle is a real user on/off.
                self._toggleTick[name] = (self._toggleTick[name] || 0) + 1
                if (self._toggleTick[name] === 1) {
                    Promise.resolve().then(() => {
                        delete self._toggleTick[name]
                    })
                }
                if (self._toggleTick[name] >= 2) {
                    self._optimisticOn.add(name) // reload pair -> keep card
                } else if (L_.layers.on[name] === true) {
                    self._optimisticOn.delete(name) // user turning it off
                } else {
                    self._optimisticOn.add(name) // user turning it on
                }
                self._rebuildCards()
            }
            return orig(s, ...rest)
        }
    },

    _unpatchToggleLayer: function () {
        if (this._origToggleLayer) {
            L_.toggleLayer = this._origToggleLayer
            this._origToggleLayer = null
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


    _waitAndInject: function () {
        // The strip only needs #mmgisTimeUIExpandedContent, which exists on both
        // desktop and mobile.
        const doInject = () => {
            this._injectForecastStrip()
            this._rebuildCards()
        }
        const tryInject = () => {
            if (document.getElementById('mmgisTimeUIExpandedContent')) {
                doInject()
            } else {
                const obs = new MutationObserver(() => {
                    if (document.getElementById('mmgisTimeUIExpandedContent')) {
                        obs.disconnect()
                        doInject()
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
        // Compact one-row cards on mobile — use the same store flag TimeUI drives
        // its mobile layout from, so this matches when the timeline goes mobile.
        if (_isMobile()) strip.classList.add('ftl-mobile')
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

        // On mobile, don't force the desktop height math (it left dead space and
        // shifted the compass). Instead make the whole expanded content — this
        // forecast strip plus the year/month/day/hour rows — a single vertical
        // scroll area capped to a portion of the screen, so the map stays visible
        // and everything below is reachable by scrolling.
        if (_isMobile()) {
            timeUI.style.height = ''
            expandedContent.style.height = ''
            expandedContent.style.maxHeight = '52vh'
            expandedContent.style.overflowY = 'auto'
            expandedContent.style.overflowX = 'hidden'
            expandedContent.style.webkitOverflowScrolling = 'touch'
            document.documentElement.style.setProperty('--ftl-extra-bottom', '0px')
            return
        }
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







    // ── Card management ────────────────────────────────────

    _detectForecastLayers: function () {
        const result = []
        for (const name in L_.layers.data) {
            const ld = L_.layers.data[name]
            // Include a layer the moment its toggle is requested (optimisticOn),
            // not only once L_.layers.on flips -- which for a velocity layer is
            // after its grib finishes loading. See _patchToggleLayer.
            const isOn =
                L_.layers.on[name] ||
                (this._optimisticOn && this._optimisticOn.has(name))
            if (ld?.time?.forecast?.enabled === true && isOn) {
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
                // Start new cards as 'loading' — probe will set available/unavailable.
                this.state.cards[name] = { stepIndex: 0, collapsed: false, cardState: 'loading' }
                if (fc.urlTemplate) this._applyUrlTemplate(name, 1)
            }
        })

        // Rebuild the strip in attached mode (always in DOM, shown by TimeUI expand)
        const strip = document.getElementById('ftl-strip')
        if (strip) {
            strip.classList.toggle('ftl-mobile', _isMobile())
            strip.innerHTML = this._buildStripHTML(layers, false)
            layers.forEach(({ name, config: fc }) => {
                this._attachCardHandlers(name, fc, strip)
                this._renderCardStep(name, fc, strip)
                const cs = this.state.cards[name]?.cardState
                if (cs && cs !== 'available') {
                    this._setCardState(name, cs)
                }
            })
            this._attachTabHandlers(strip)
        }
        this._adjustTimeUIHeight()

        // Prune edge-cache entries for layers that are no longer active, then probe.
        if (this._edgeCache) {
            const active = new Set(layers.map((l) => l.name))
            Object.keys(this._edgeCache).forEach((k) => {
                // Strip the trailing run field. The key is `name:base`, and layer
                // names are path-like and routinely contain colons themselves
                // (e.g. "COG:https://…"), so split at the LAST colon.
                const layerName = k.slice(0, k.lastIndexOf(':'))
                if (!active.has(layerName)) delete this._edgeCache[k]
            })
        }
        this._probeAllAnchors()
    },


    _refreshAllCards: function () {
        const layers = this._detectForecastLayers()
        const strip = document.getElementById('ftl-strip')

        layers.forEach(({ name, config: fc }) => {
            if (strip) this._renderCardStep(name, fc, strip)
        })
    },

    // True when any visible card's rendered tick count no longer matches its
    // effective step count — e.g. an HRRR COG card that just crossed into (or out
    // of) a 00/06/12/18z run, so its range jumped between F18 and F48. _renderCardStep
    // only updates existing ticks, so a mismatch means we must rebuild the tick DOM.
    _stepCountsStale: function () {
        const container = document.getElementById('ftl-strip')
        if (!container) return false
        return this._detectForecastLayers().some(({ name, config: fc }) => {
            const card = container.querySelector(`.ftl-card[data-layer="${_escSel(name)}"]`)
            // Collapsed cards render as tabs (no ticks) — skip; they rebuild on expand.
            if (!card) return false
            return card.querySelectorAll('.ftl-tick').length !== this._effectiveSteps(fc, name)
        })
    },

    // Re-apply every visible card's step.
    //
    // The guard flag MUST be cleared in a finally. Without it a single throw
    // anywhere in _applyCardStep leaves _reapplying stuck true, and because
    // _onTimeChange bails on that flag, the plugin then ignores every
    // subsequent time change — permanently, for the rest of the session. One
    // transient error and the cards silently stop tracking the timeline, which
    // presents as "it stopped re-checking" long after the actual error.
    //
    // Each layer is isolated too: a card is created optimistically the moment a
    // toggle is requested, which is before L_ has finished building the Leaflet
    // layer, so a layer that isn't ready yet must not stop the others from
    // being re-applied.
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

    // ── Origin / step helpers ──────────────────────────────

    // Model init time floored to the current hour's :00 (e.g. 02:55 → 02:00).
    // All forecast steps are generated from this floored base so ticks land on
    // clean hour boundaries and the "MODEL INITIALIZED AT" readout matches.
    _originBase: function () {
        const d = new Date(this.state.originMs || Date.now())
        d.setMinutes(0, 0, 0)
        return d.getTime()
    },

    // The instant a forecast's steps are generated from.
    //  - Hourly / COG products anchor to the hour-floored selected time.
    //  - Daily products (e.g. WFPI) anchor to the latest model run at or before
    //    the selected time. Runs land at runHourUTC:00 UTC each day (WFPI = 00:00Z,
    //    published ~5 PM PDT). Anchoring by the UTC run — instead of 00:00Z of the
    //    *PDT* calendar date — fixes the 5 PM PDT boundary bug, where the PDT date
    //    still pointed at yesterday's run for the 7 hours after the new run was out.
    _forecastBase: function (fc) {
        const base = this._originBase()
        if ((fc?.stepUnit || 'hour') !== 'day') return base
        const runHourUTC = Number.isFinite(fc.runHourUTC) ? fc.runHourUTC : 0
        const d = new Date(base)
        const runToday = Date.UTC(
            d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
            runHourUTC, 0, 0, 0
        )
        // Latest run <= selected time: today's UTC run if it has occurred, else yesterday's.
        return runToday <= base ? runToday : runToday - STEP_UNITS.day
    },

    // Number of steps the card should offer. veloserver fxx layers (HRRR COG
    // rasters and the HRRR gribjson velocity layer) know their own range from the
    // init time -- every run reaches F18, but runs started at 00/06/12/18 UTC reach
    // F48 -- so no per-layer config. Other forecast layers (WFPI daily, PWWB hourly)
    // use their configured fc.steps. The init-hour check is on the selected
    // instant's UTC hour, so it's correct whatever the PDT display shows (DST-safe).
    _effectiveSteps: function (fc, name) {
        const ld = name ? L_.layers.data[name] : null
        if (!this._isFxxLayer(ld)) return fc.steps || 1
        const initHourUTC = new Date(this._originBase()).getUTCHours()
        const isExtendedRun = HRRR_EXTENDED_INIT_HOURS.includes(initHourUTC)
        return (isExtendedRun ? HRRR_FXX_MAX_EXTENDED : HRRR_FXX_MAX) + 1
    },

    // True for a veloserver layer whose forecast hour is carried as a ?fxx=N query
    // param: an HRRR COG raster (url starts "COG:") or the HRRR gribjson velocity
    // layer (url has /hrrr/gribjson/). GFS gribjson is winds-only analysis --
    // veloserver ignores fxx there -- so it is deliberately excluded.
    _isFxxLayer: function (ld) {
        if (!ld) return false
        const url = ld.url || ''
        if (url.toUpperCase().startsWith('COG:')) return true
        return ld.type === 'velocity' && /\/hrrr\/gribjson\//i.test(url)
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

    // Compact label for the model run a probe targeted, for the "not yet
    // generated" warning: "Jul 20, 5 PM" (hourly, PDT) or "Jul 20" (daily,
    // UTC-dated to match the tick labels and the run actually fetched).
    _runLabel: function (fc) {
        const base = this._forecastBase(fc || {})
        if ((fc?.stepUnit || 'hour') === 'day') {
            return new Date(base).toLocaleDateString('en-US', {
                timeZone: 'UTC',
                month: 'short',
                day: 'numeric',
            })
        }
        return new Date(base).toLocaleString('en-US', {
            timeZone: PDT_TZ,
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            hour12: true,
        })
    },

    // "Jun 30, 2026 · 2:00 PM PDT"  (hourly)  or  "Jul 7, 2026 · 12:00 AM PDT"  (daily)
    _formatInit: function (ms, unit, fc) {
        const d = new Date(ms)
        if (unit === 'day') {
            // Daily products are UTC-dated (00:00Z run); label by UTC date so the
            // readout matches the tick labels and the run that's actually fetched.
            const dateStr = d.toLocaleDateString('en-US', {
                timeZone: 'UTC',
                month: 'short',
                day: 'numeric',
                year: 'numeric',
            })
            // WFPI is special: communicate the WHOLE forecast span, not one day,
            // so it doesn't read like a single-day range. The 7 daily steps run
            // from the 00:00Z run (5 PM PDT) across 7 days, so the span is
            // "Jul 12 5 PM – Jul 19 5 PM PDT" — start to start-plus-N-days.
            if (/wfpi/i.test(fc?.label || '')) {
                const steps = fc.steps || 7
                const dOpts = { timeZone: PDT_TZ, month: 'short', day: 'numeric' }
                const tOpts = { timeZone: PDT_TZ, hour: 'numeric', hour12: true }
                const endD = new Date(ms + steps * STEP_UNITS.day)
                const start = `${d.toLocaleDateString('en-US', dOpts)} ${d.toLocaleTimeString('en-US', tOpts)}`
                const end = `${endD.toLocaleDateString('en-US', dOpts)} ${endD.toLocaleTimeString('en-US', { ...tOpts, timeZoneName: 'short' })}`
                return `${start} – ${end}`
            }
            return dateStr
        }
        const dateStr = d.toLocaleDateString('en-US', {
            timeZone: PDT_TZ,
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        })
        const timeStr = d.toLocaleTimeString('en-US', {
            timeZone: PDT_TZ,
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZoneName: 'short',
        })
        return `${dateStr} · ${timeStr}`
    },

    // Two-line label for a single forecast tick. Shared by the initial build and
    // the per-step refresh so both paths always agree.
    //   - hourly:        clock = "9 AM"    rel = "h1"
    //   - daily (step N): clock = "May 13" rel = "+N"  (first step = "+0")
    // The daily valid window (5 PM–5 PM PDT) lives on the INITIALIZED line, not
    // the step, so every step stays compact and uniform — see _formatInit.
    _tickLabels: function (fc, i, originBase) {
        const unit = fc.stepUnit || 'hour'
        const unitMs = STEP_UNITS[unit] || STEP_UNITS.hour
        // stepOffset is documented as required, but a mission config that omits
        // it must degrade to "first step = init time", not render "hNaN" and
        // "Invalid Date" into an operational forecast card. The chip label
        // below already defaults the same way.
        const offset = fc.stepOffset || 0
        const stepDate = new Date(originBase + (i + offset) * unitMs)

        if (unit === 'day') {
            const dOpts = { timeZone: 'UTC', month: 'short', day: 'numeric' }
            // WFPI first step only: show the day's window as prev–curr (e.g.
            // "Jul 12–13"). Every other step (and every other daily product)
            // shows a single date.
            if (i === 0 && /wfpi/i.test(fc?.label || '')) {
                const prevD = new Date(originBase + (i + offset - 1) * unitMs)
                const sameMonth =
                    prevD.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' }) ===
                    stepDate.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' })
                const clock = sameMonth
                    ? `${prevD.toLocaleDateString('en-US', dOpts)}–${stepDate.toLocaleDateString('en-US', { timeZone: 'UTC', day: 'numeric' })}`
                    : `${prevD.toLocaleDateString('en-US', dOpts)} – ${stepDate.toLocaleDateString('en-US', dOpts)}`
                return { clock, rel: `+${i + offset}` }
            }
            const clock = stepDate.toLocaleString('en-US', dOpts)
            return { clock, rel: `+${i + offset}` }
        }

        const clock = stepDate.toLocaleString('en-US', {
            timeZone: PDT_TZ,
            hour: 'numeric',
            hour12: true,
        })
        return { clock, rel: `h${i + offset}` }
    },

    // ── Card HTML ──────────────────────────────────────────

    _buildCardHTML: function (name, fc, large) {
        const steps = this._effectiveSteps(fc, name)
        const unit = fc.stepUnit || 'hour'
        const label = fc.label || name
        const originBase = this._forecastBase(fc)
        const initStr = this._formatInit(originBase, unit, fc)

        // Info icon only when the layer configures a description — no description,
        // no button (there'd be nothing to show).
        const infoBtnHTML = fc.description
            ? `<button class="ftl-card-info-btn" data-layer="${_escHtml(name)}" type="button" aria-label="Forecast details"><i class="mdi mdi-information-outline"></i></button>`
            : ''

        // Experimental — only rendered when the mission opts in.
        const playBtnHTML = this._playbackEnabled()
            ? `<button class="ftl-card-play" data-layer="${_escHtml(name)}" type="button" title="Play forecast animation" aria-label="Play forecast animation"><i class="mdi mdi-play"></i></button>`
            : ''

        // Use native TimeUI classes in attached mode so rows blend in perfectly
        const tickClass = large ? 'ftl-tick ftl-tick-large' : 'ftl-tick mmgisTimeUIExpandedItem'
        const ticks = Array.from({ length: steps }, (_, i) => {
            // Steps are generated from the hour-floored base, so they already
            // land on clean boundaries — no per-tick rounding needed.
            const { clock, rel } = this._tickLabels(fc, i, originBase)
            return `<div class="${tickClass} ftl-tick-twoline" data-layer="${_escHtml(name)}" data-step="${i}"><span class="ftl-tick-clock">${clock}</span><span class="ftl-tick-rel">${rel}</span></div>`
        }).join('')

        const rowClass = large ? 'ftl-card ftl-card-large' : 'ftl-card'
        // Daily cards use fixed-width steps (see CSS) so a 1-step daily card stays
        // one step wide instead of stretching a lone tick across the whole track.
        const dailyClass = unit === 'day' ? ' ftl-card-daily' : ''
        const ticksWrapClass = large ? 'ftl-ticks-wrap' : 'ftl-ticks-wrap mmgisTimeUIExpandedRowContainer'

        const unitWord = unit === 'day' ? 'daily' : unit === 'week' ? 'weekly' : 'hourly'
        const unitPlural = unit === 'day' ? 'days' : unit === 'week' ? 'weeks' : 'hrs'
        // Hourly tracks label by max lead time (last tick's hour), so HRRR's
        // H0..H18 reads "18 hrs" not "19". Daily/weekly label by the step count.
        const span = unit === 'day' || unit === 'week'
            ? steps
            : (steps - 1) + (fc.stepOffset || 0)
        const forecastChipLabel = `${unitWord} / ${span} ${unitPlural}`

        const isCollapsed = this.state.cards[name]?.collapsed === true
        const collapsedAttr = isCollapsed ? ' ftl-card-collapsed' : ''

        return `
<div class="${rowClass}${dailyClass}${collapsedAttr}" data-layer="${_escHtml(name)}">
  <div class="ftl-card-header">
    <button class="ftl-card-collapse-btn" data-layer="${_escHtml(name)}" title="${isCollapsed ? 'Expand' : 'Collapse'}">
      <i class="mdi ${isCollapsed ? 'mdi-window-restore' : 'mdi-window-minimize'} mdi-18px"></i>
    </button>
    <div class="ftl-card-hdr-left">
      <span class="ftl-card-forecast-title">FORECAST</span>
      <span class="ftl-card-forecast-chip">${forecastChipLabel}</span>
    </div>
    <div class="ftl-card-hdr-right">
      <div class="ftl-card-label-row">
        <span class="ftl-card-label">${_escHtml(label)}</span>
        ${infoBtnHTML}
        ${playBtnHTML}
      </div>
      <div class="ftl-card-init-row">
        <span class="ftl-card-init-caption">INITIALIZED:</span>
        <span class="ftl-card-init">${initStr}</span>
      </div>
    </div>
  </div>
  <div class="ftl-card-body">
    <button class="ftl-card-prev" data-layer="${_escHtml(name)}"><i class="mdi mdi-chevron-left"></i></button>
    <div class="${ticksWrapClass}">
      <div class="ftl-ticks">${ticks}</div>
    </div>
    <button class="ftl-card-next" data-layer="${_escHtml(name)}"><i class="mdi mdi-chevron-right"></i></button>
  </div>
  <div class="ftl-card-prefetch" data-layer="${_escHtml(name)}"><div class="ftl-card-prefetch-bar"></div></div>
</div>`
    },

    // ── Card event handlers ────────────────────────────────

    _attachCardHandlers: function (name, fc, container) {
        container.querySelectorAll(`.ftl-tick[data-layer="${_escSel(name)}"]`).forEach((el) => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.step)
                this._setCardStep(name, fc, idx)
            })
        })
        container.querySelector(`.ftl-card-collapse-btn[data-layer="${_escSel(name)}"]`)
            ?.addEventListener('click', () => {
                this._toggleCardCollapsed(name)
            })
        container.querySelector(`.ftl-card-prev[data-layer="${_escSel(name)}"]`)
            ?.addEventListener('click', () => {
                const cur = this.state.cards[name]?.stepIndex ?? 0
                this._setCardStep(name, fc, Math.max(0, cur - 1))
            })
        container.querySelector(`.ftl-card-next[data-layer="${_escSel(name)}"]`)
            ?.addEventListener('click', () => {
                const cur = this.state.cards[name]?.stepIndex ?? 0
                const max = this._effectiveSteps(fc, name) - 1
                this._setCardStep(name, fc, Math.min(max, cur + 1))
            })
        const playBtn = container.querySelector(`.ftl-card-play[data-layer="${_escSel(name)}"]`)
        if (playBtn) {
            playBtn.addEventListener('click', () => {
                this._togglePlay(name, fc)
            })
            // Hover-only tooltip, not _bindTip: that also claims click for
            // tap-toggle, which would swallow the play press.
            playBtn.classList.add('ftl-has-tip')
            playBtn.addEventListener('mouseenter', () =>
                this._showTip(playBtn, this._playTipHtml(name, fc))
            )
            playBtn.addEventListener('mouseleave', () => this._hideTip())
        }

        const wrap = container.querySelector(`.ftl-card[data-layer="${_escSel(name)}"] .ftl-ticks-wrap`)
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

            // Override the default: a plain vertical mouse wheel scrolls the
            // forecast track horizontally (no Shift needed). Only when there's
            // actually overflow to scroll, so the page still scrolls otherwise.
            wrap.addEventListener('wheel', (e) => {
                if (wrap.scrollWidth <= wrap.clientWidth) return
                // Use whichever axis the wheel/trackpad reports the larger delta on.
                const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
                if (delta === 0) return
                e.preventDefault()
                wrap.scrollLeft += delta
            }, { passive: false })
        }

        // One hover / tap affordance: the info icon (present only when the layer
        // configures time.forecast.description). It works on desktop (hover) and
        // mobile (tap), showing that plain-language description — how the forecast
        // is generated and how far out it goes. Tapping elsewhere dismisses it.
        const infoBtn = container.querySelector(`.ftl-card-info-btn[data-layer="${_escSel(name)}"]`)
        if (infoBtn && fc.description) {
            const label = fc.label || name
            this._bindTip(
                infoBtn,
                `<div class="ftl-tip-title">${_escHtml(label)}</div>` +
                `<div class="ftl-tip-body">${_escHtml(fc.description)}</div>`
            )
        }
    },

    // ── Floating tooltip (shared #ftl-tooltip appended to <body>) ──────────

    _ensureTooltip: function () {
        let tip = document.getElementById('ftl-tooltip')
        if (!tip) {
            tip = document.createElement('div')
            tip.id = 'ftl-tooltip'
            tip.className = 'ftl-tooltip ftl-hidden'
            document.body.appendChild(tip)
        }
        return tip
    },

    _bindTip: function (el, html) {
        if (!el || !html) return
        el.classList.add('ftl-has-tip')
        el.addEventListener('mouseenter', () => this._showTip(el, html))
        el.addEventListener('mouseleave', () => this._hideTip())
        el.addEventListener('click', (e) => {
            // Toggle on tap (mobile) without letting the click bubble to the
            // document-level dismiss handler that would immediately re-hide it.
            e.stopPropagation()
            const tip = document.getElementById('ftl-tooltip')
            const openHere = tip && !tip.classList.contains('ftl-hidden') && tip._ftlAnchor === el
            if (openHere) this._hideTip()
            else this._showTip(el, html)
        })
    },

    _showTip: function (anchorEl, html) {
        const tip = this._ensureTooltip()
        tip.innerHTML = html
        tip._ftlAnchor = anchorEl
        tip.classList.remove('ftl-hidden')
        // Measure after content is set, then place above the anchor (flip below
        // if there isn't room), clamped to the viewport.
        const a = anchorEl.getBoundingClientRect()
        const t = tip.getBoundingClientRect()
        let left = a.left + a.width / 2 - t.width / 2
        left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8))
        let top = a.top - t.height - 10
        if (top < 8) top = a.bottom + 10
        tip.style.left = Math.round(left) + 'px'
        tip.style.top = Math.round(top) + 'px'
    },

    _hideTip: function () {
        const tip = document.getElementById('ftl-tooltip')
        if (tip) {
            tip.classList.add('ftl-hidden')
            tip._ftlAnchor = null
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
                `<button class="ftl-tab" data-layer="${_escHtml(name)}" title="Expand ${_escHtml(fc.label || name)}">${_escHtml(fc.label || name)}</button>`
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
        const cs = this.state.cards[name]
        if (!cs) return

        // Clicking a step past the published edge is the user explicitly asking
        // "is this hour out yet?". Re-probe just that hour on demand (one
        // request); advance the edge and step there if it's now present, else
        // leave it greyed. This keeps the common path free of per-click probing
        // while still letting a waiting user pull in a freshly-published hour.
        if (cs.cardState === 'available' && this._tickBeyondEdge(name, idx)) {
            this._dbg('on-demand edge re-probe', name, 'fxx=' + idx)
            this._probeFxx(name, fc, idx).then((ok) => {
                if (ok) {
                    this._raiseEdge(name, fc, idx)
                    this._commitStep(name, fc, idx)
                }
            })
            return
        }
        this._commitStep(name, fc, idx)
    },

    _commitStep: function (name, fc, idx) {
        if (!this.state.cards[name]) return
        this.state.cards[name].stepIndex = idx
        this._refreshAllCards()
        this._applyCardStep(name, fc, idx)
    },

    // Is step `i` past this run's published edge? Steps at or below the edge are
    // present; a card that hasn't resolved an edge yet (maxStep undefined) treats
    // every step as present, so it degrades to "enabled" rather than blank.
    _tickBeyondEdge: function (name, i) {
        const maxStep = this.state.cards[name]?.maxStep
        return typeof maxStep === 'number' && i > maxStep
    },

    // Hover reason on a tick greyed only because it's past the edge (not because
    // the whole card is down). Cleared otherwise so no stale title lingers.
    _setTickEdgeTitle: function (el, name, i) {
        const cs = this.state.cards[name]
        if (cs && cs.cardState === 'available' && this._tickBeyondEdge(name, i)) {
            const reached = cs.maxStep < 0 ? 'none' : `F${cs.maxStep}`
            el.setAttribute(
                'title',
                `This forecast hour isn't published yet (run currently reaches ${reached}). Click to check again.`
            )
        } else {
            el.removeAttribute('title')
        }
    },

    _renderCardStep: function (name, fc, container) {
        const card = container?.querySelector(`.ftl-card[data-layer="${_escSel(name)}"]`)
        this._dbg('renderCardStep', name, {
            cardFound: !!card,
            cardState: this.state.cards[name]?.cardState,
        })
        if (!card) return

        const steps = this._effectiveSteps(fc, name)
        // Clamp a stored step past the new max (e.g. init moved off a 00/06/12/18z
        // run, so 48 steps drop back to 18) so no out-of-range fxx is requested.
        let idx = this.state.cards[name]?.stepIndex ?? 0
        if (idx > steps - 1) {
            idx = steps - 1
            if (this.state.cards[name]) this.state.cards[name].stepIndex = idx
        }
        const unit = fc.stepUnit || 'hour'
        const originBase = this._forecastBase(fc)

        const cardState = this.state.cards[name]?.cardState ?? 'available'
        const isDisabled = cardState !== 'available'

        card.querySelectorAll('.ftl-tick').forEach((el, i) => {
            // Grey steps past the run's published edge, and suppress the active
            // (blue) highlight whenever the tick is disabled.
            const beyond = this._tickBeyondEdge(name, i)
            el.classList.toggle('ftl-future-item', isDisabled || beyond)
            el.classList.toggle('active', !isDisabled && !beyond && i === idx)
            this._setTickEdgeTitle(el, name, i)
            const { clock, rel } = this._tickLabels(fc, i, originBase)
            const clockEl = el.querySelector('.ftl-tick-clock')
            if (clockEl) clockEl.textContent = clock
            const relEl = el.querySelector('.ftl-tick-rel')
            if (relEl) relEl.textContent = rel
        })

        // Only overwrite the init line when available — _setCardState manages it otherwise
        if (!isDisabled) {
            const initEl = card.querySelector('.ftl-card-init')
            if (initEl) initEl.textContent = this._formatInit(originBase, unit, fc)
        }

        card.querySelector('.ftl-card-prev')?.toggleAttribute('disabled', isDisabled || idx === 0)
        card.querySelector('.ftl-card-next')?.toggleAttribute('disabled', isDisabled || idx === steps - 1)
        card.querySelector('.ftl-card-play')?.toggleAttribute('disabled', isDisabled || steps <= 1)

        // Ticks are fixed width and the track scrolls horizontally, so keep the
        // active step in view when it's stepped past the visible edge (only
        // nudges the track's own scrollLeft — never the page).
        const activeEl = card.querySelector('.ftl-tick.active')
        const wrap = card.querySelector('.ftl-ticks-wrap')
        if (activeEl && wrap) {
            const a = activeEl.getBoundingClientRect()
            const w = wrap.getBoundingClientRect()
            if (a.left < w.left) wrap.scrollLeft -= w.left - a.left
            else if (a.right > w.right) wrap.scrollLeft += a.right - w.right
        }
    },

    _applyCardStep: function (name, fc, idx) {
        // Guard the forecast hour to the range this init time offers (fxx == idx
        // for COG layers), so a stale index never requests an unavailable hour.
        idx = Math.max(0, Math.min(idx, this._effectiveSteps(fc, name) - 1))
        const unitMs = STEP_UNITS[fc.stepUnit] || STEP_UNITS.hour
        const originMs = this._forecastBase(fc)
        // Default to 0 for the same reason _tickLabels does — a config missing
        // stepOffset must not compute a NaN step time and request it.
        const offset = fc.stepOffset || 0
        let stepMs = originMs + (idx + offset) * unitMs

        // Daily products (WFPI) are already anchored to the UTC model run by
        // _forecastBase, so stepMs lands on 00:00Z of the target day — no PDT
        // re-snap needed. The old snap to 00:00Z of the *PDT* calendar date is
        // exactly what broke at the 5 PM PDT boundary (the new 00Z run was out,
        // but the PDT date still pointed at yesterday's run for 7 hours).

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
                // The forecast hour rides as ?fxx=N, and it MUST sit inside the
                // veloserver source (the titiler `url=` value), not as a sibling
                // param on the titiler request. veloserver only honours fxx when
                // it's part of its own URL; a sibling fxx on the titiler request
                // is silently dropped, so every forecast hour then renders the
                // fxx=0 analysis. (Verified against the live render service:
                // url=…/x.tiff?fxx=44 → 500 for an unpublished hour, but
                // url=…/x.tiff&fxx=44 → 200 serving analysis.) {time} stays a
                // live token substituted per tile.
                const setFxx = (u) =>
                    /[?&]fxx=/i.test(u)
                        ? u.replace(/([?&]fxx=)[^&]*/i, `$1${idx}`)
                        : `${u}${u.indexOf('?') === -1 ? '?' : '&'}fxx=${idx}`
                // Keep ld.url in sync so a full rebuild later starts from the right fxx.
                ld.url = setFxx(ld.url)

                const leafletLayer = L_.layers.layer[name]
                if (leafletLayer && typeof leafletLayer._url === 'string') {
                    // Rewrite fxx INSIDE the `url=` source, never append it to the
                    // titiler request. The source is a bare URL with no `&`, so
                    // `[^&]*` captures it exactly.
                    const newUrl = leafletLayer._url.replace(
                        /([?&]url=)([^&]*)/i,
                        (_m, pre, src) => pre + setFxx(src)
                    )
                    if (newUrl !== leafletLayer._url) leafletLayer.refresh(newUrl, true)
                }
                return
            }

            // HRRR gribjson velocity layer: same ?fxx=N scheme as the COG layers,
            // but leaflet-velocity has no in-place URL swap like a tile .refresh(),
            // so rewrite fxx on ld.url and let reloadLayer re-fetch. reloadLayer's
            // velocity path toggles the layer off/on, re-running makeVelocityLayer
            // -> captureVector against the new URL. {time} stays a live token (the
            // run/init time from the main timeline); step 0 -> fxx=0 (the analysis).
            if (
                ld.type === 'velocity' &&
                /\/hrrr\/gribjson\//i.test(ld.url || '')
            ) {
                const setFxx = (u) =>
                    /[?&]fxx=/i.test(u)
                        ? u.replace(/([?&]fxx=)[^&]*/i, `$1${idx}`)
                        : `${u}${u.indexOf('?') === -1 ? '?' : '&'}fxx=${idx}`
                ld.url = setFxx(ld.url)

                // Update the wind data in place with leaflet-velocity's setData
                // rather than reloading the layer. reloadLayer toggles the layer
                // off/on, which blinks the streamlines AND -- because the layer is
                // momentarily "off" -- makes the forecast card disappear. setData
                // leaves the layer (and the card) on screen and just refreshes the
                // streamlines once the new grib arrives. Resolve {time} the same
                // way LayerCapturer does (from time.start/end) for the fetch.
                const leafletLayer = L_.layers.layer[name]
                const canSetData =
                    leafletLayer &&
                    typeof leafletLayer.setData === 'function' &&
                    /^https?:\/\//i.test(ld.url) &&
                    ld.time &&
                    ld.time.end
                if (canSetData) {
                    // Prefetched frame — hand it straight to leaflet-velocity so
                    // an animation frame costs no network round trip.
                    const cached = this._frameCache?.[this._frameKey(name, fc)]?.[idx]
                    if (cached) {
                        leafletLayer.setData(cached)
                        if (idx === 0) this._setCardState(name, 'available')
                        return
                    }
                    const fetchUrl = ld.url
                        .replace(/{time}/g, ld.time.end)
                        .replace(/{endtime}/g, ld.time.end)
                        .replace(/{starttime}/g, ld.time.start || ld.time.end)
                    fetch(fetchUrl)
                        .then((r) => {
                            if (!r.ok) throw new Error(r.status)
                            return r.json()
                        })
                        .then((data) => {
                            leafletLayer.setData(data)
                            // This step's data is present — it lies within the
                            // published edge, so nudge the edge out to include it.
                            this._raiseEdge(name, fc, idx)
                        })
                        .catch((e) => {
                            console.warn('ForecastTimeline: velocity fxx update failed', e)
                            // The step fetch is ground truth: this hour isn't
                            // there, so clamp the published edge to just below it.
                            // (idx 0 missing → edge -1 → whole card unavailable.)
                            this._lowerEdge(name, fc, idx)
                        })
                } else {
                    // Fallback when setData isn't available: reload via toggle,
                    // guarded so the toggle's rebuild doesn't reset the card to 0.
                    this._reloadingLayer = true
                    Promise.resolve(
                        TimeControl.reloadLayer(ld, false, false, false)
                    ).finally(() => {
                        this._reloadingLayer = false
                    })
                }
                return
            }

            // The tick is LABELED with the target/valid day (stepMs), but the
            // forecast for that day is what's current the ISSUE day before it, so
            // the query end is one step earlier: stepMs - unitMs. This makes the
            // forecast tick for day T show exactly what the normal timeline shows
            // at day T-1 -- because it's a forecast (issued on T-1, valid for T).
            const queryEndIso = new Date(stepMs - unitMs).toISOString()

            const prevStart = ld.time.start
            const prevEnd = ld.time.end

            // Keep the layer's existing (open, epoch-based) START. The normal
            // timeline queries [epoch, selectedTime] so a STAC/titiler-pgstac
            // mosaic returns the most recent item at or before the target.
            // Narrowing the start excluded every earlier item, so any
            // missing/lagging forecast day (this collection is sparse) yielded
            // an empty mosaic -> 204 -> blank layer. Open start + issue-day end
            // makes the step match the normal timeline at the issue day exactly.
            ld.time.end = queryEndIso

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
        if (leafletLayer && ld.tileformat === 'wms') {
            // The Leaflet layer is pre-built at config load with the raw
            // __FSTEP__ template baked into its _url and LAYERS param, so the
            // step substitution must reach it even while the layer is still
            // off. Gating this on L_.layers.on[name] meant the first toggle-on
            // added the pre-built layer with __FSTEP__ unsubstituted -- every
            // tile 404'd until a later tick click finally rewrote _url. Rewrite
            // _url/LAYERS here regardless of on-state; only redraw when it's on
            // (an off layer isn't on the map, and gets requested fresh when added).
            const urlSplit = newUrl.split('?')
            const newBase = urlSplit[0]
            const urlParams = new URLSearchParams(urlSplit[1] || '')

            leafletLayer._url = newBase

            const layersVal = urlParams.get('layers') || urlParams.get('LAYERS')
            if (layersVal) {
                leafletLayer.setParams({ LAYERS: layersVal }, true)
            }

            // TIME stays a live {time} token that the WMS tile builder resolves
            // from leafletLayer.options.time per request. On a main-timeline
            // change, timeInputChange notifies subscribers (this plugin) BEFORE
            // it calls updateLayersTime/setLayerWmsParams, so options.time is
            // still the PREVIOUS selection when we redraw below -- leaving WFPI a
            // full run behind across the 5PM PDT / 00:00Z boundary (harmless
            // within a day since TIME is date-only). TimeControl.currentTime is
            // already updated at this point, so sync the layer's time off it
            // first and TIME resolves to the right date this same cycle.
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

    // ── TimeControl callback ───────────────────────────────

    _onTimeChange: function (timeData) {
        if (this._applyingStep || this._reapplying) return
        if (timeData?.currentTime) {
            this.state.originMs = new Date(timeData.currentTime).getTime()
            // If a card's tick count changed (e.g. HRRR crossed a 00/06/12/18z
            // boundary, F18↔F48), rebuild so the new ticks appear immediately;
            // otherwise just refresh the existing ticks in place.
            // Probe first so state is correct before _refreshAllCards renders
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

        // ── Attached mode ──
        // The forecast strip makes #timeUI taller than the core's hardcoded 177,
        // so publish the exact extra height as a CSS custom property;
        // ForecastTimeline.css adds it as margin-bottom to each bottom element.
        // Derived from the card count (the same formula that grows #timeUI in
        // _adjustTimeUIHeight) rather than a live measurement, so it stays stable
        // during the timeline's expand/collapse transition instead of jittering.
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

    // ── Anchor availability probe ──────────────────────────

    // Probe the anchor step of each visible forecast layer once per forecastBase
    // (i.e. once per model run). Uses a direct fetch to the underlying data URL
    // (veloserver for COG/velocity, WMS for urlTemplate) — not TiTiler tiles —
    // so 404 and 500 both reliably reach us. Results in _setCardUnavailable.
    // Diagnostic tracing. Set window.FTL_DEBUG = true, then reproduce; every
    // step of the availability chain prints with its inputs and result. Off by
    // default so it costs nothing in normal use.
    _dbg: function (...args) {
        if (typeof window !== 'undefined' && window.FTL_DEBUG) {
            console.log('[FTL]', ...args)
        }
    },

    // ── Availability: the published edge ───────────────────
    //
    // A forecast run's availability is one integer: the highest forecast hour it
    // has published (HRRR publishes hours progressively, so availability is
    // always a contiguous prefix fxx 0..N; N+1.. are simply not out yet). We
    // resolve that edge once per run and cache it under `name:base`. Everything
    // else — is the run there at all, is *this* step there — is then a free
    // in-memory comparison against the edge, so stepping costs no network.
    //
    // We probe out-of-band against the SAME service the map renders through
    // (titiler /cog/info for COG, the gribjson file for velocity, a day-1 GetMap
    // for WFPI), NOT the Leaflet tiles: the tile pipeline deliberately swaps a
    // failed tile for a transparent PNG (anti-flicker _refreshTileUrl), so tile
    // events can't see failures. `Access-Control-Allow-Origin: *` on the
    // backends means a plain fetch reads the true status.
    //
    // ASSUMPTION: the prefix is contiguous (no holes). If a run ever published
    // F0..F5 and F7 but not F6, the binary search could misplace the edge — but
    // clicking a greyed tick re-probes that exact hour (see _setCardStep) and a
    // velocity step-fetch failure clamps the edge down, so any misplacement is
    // self-correcting rather than sticky.

    // Values are: a number (resolved edge, -1 = run missing entirely) or
    // 'pending'. Keyed `name:base`.
    _edgeCache: {},

    _probeAllAnchors: function () {
        if (!this._edgeCache) this._edgeCache = {}
        this._detectForecastLayers().forEach(({ name, config: fc }) => {
            const base = this._forecastBase(fc)
            const key = `${name}:${base}`
            const cached = this._edgeCache[key]

            if (typeof cached === 'number') {
                this._dbg('edge (cache hit)', name, { key, edge: cached })
                this._applyEdge(name, cached)
                return
            }
            if (cached === 'pending') {
                this._setCardState(name, 'loading')
                return
            }

            this._edgeCache[key] = 'pending'
            this._setCardState(name, 'loading')

            const baseAtFire = base
            const stillCurrent = () => this._forecastBase(fc) === baseAtFire

            this._dbg('edge RESOLVE', name, { key, base: new Date(base).toISOString() })
            this._resolveEdge(name, fc)
                .then((edge) => {
                    this._edgeCache[key] = edge
                    this._dbg('edge RESULT', name, { key, edge, applied: stillCurrent() })
                    if (stillCurrent()) this._applyEdge(name, edge)
                })
                .catch((e) => {
                    // A thrown probe is a network failure — the case the card
                    // exists to report. Treat as run-missing rather than fail open.
                    this._dbg('edge ERROR', name, e)
                    this._edgeCache[key] = -1
                    if (stillCurrent()) this._applyEdge(name, -1)
                })
        })
    },

    // Turn a resolved edge into card state. edge < 0 → whole card unavailable;
    // otherwise available, and the tick greying (in _renderCardStep) hides the
    // steps beyond the edge.
    _applyEdge: function (name, edge) {
        const cs = this.state.cards[name]
        if (!cs) return
        const wasUnavailable = cs.cardState === 'unavailable'
        cs.maxStep = edge
        if (edge < 0) {
            this._setCardState(name, 'unavailable')
        } else {
            this._setCardState(name, 'available')
            // Re-apply the current step so the COG/tile refresh fires now that
            // the card is known-available (recovers a card the probe had blanked).
            if (wasUnavailable) this._reapplyAllSteps()
        }
    },

    // Nudge the cached edge to at least `n` (a step just proven present) and
    // re-render if it grew. Keeps the on-demand re-probe and the velocity
    // step-fetch success in sync with the card.
    _raiseEdge: function (name, fc, n) {
        const cs = this.state.cards[name]
        if (!cs) return
        if ((cs.maxStep ?? -1) >= n && cs.cardState === 'available') return
        const edge = Math.max(cs.maxStep ?? -1, n)
        this._edgeCache[`${name}:${this._forecastBase(fc)}`] = edge
        this._applyEdge(name, edge)
    },

    // Clamp the cached edge to just below `n` (a step just proven missing).
    _lowerEdge: function (name, fc, n) {
        const cs = this.state.cards[name]
        if (!cs) return
        const edge = Math.min(cs.maxStep ?? Infinity, n - 1)
        this._edgeCache[`${name}:${this._forecastBase(fc)}`] = edge
        this._applyEdge(name, edge)
    },

    // Resolve the published edge (max fxx present), or -1 if the run is missing.
    _resolveEdge: function (name, fc) {
        // WFPI / urlTemplate: publication is atomic, so it's all-or-nothing —
        // day 1 governs every step. Reuse the existing day-1 GetMap probe.
        if (fc.urlTemplate) {
            return this._probeWmsTime(name, fc).then((v) =>
                v === 'available' ? (fc.steps || 1) - 1 : -1
            )
        }

        const ld = L_.layers.data[name]
        // Layers we can't probe (STAC etc.): assume all steps present, but do it
        // explicitly rather than by silent fall-through.
        if (!this._isFxxLayer(ld)) return Promise.resolve((fc.steps || 1) - 1)

        const maxFxx = this._effectiveSteps(fc, name) - 1
        // Anchor first: if fxx=0 is missing the run isn't out — one request.
        return this._probeFxx(name, fc, 0).then((ok0) => {
            if (!ok0) return -1
            if (maxFxx <= 0) return 0
            // Then the far end: a fully-published run resolves in two requests.
            return this._probeFxx(name, fc, maxFxx).then((okMax) => {
                if (okMax) return maxFxx
                // Mid-publication: binary-search the last present hour.
                return this._binarySearchEdge(name, fc, 0, maxFxx)
            })
        })
    },

    // Greatest n in (lo, hi) with fxx=n present, given fxx=lo present and
    // fxx=hi missing. ~log2(range) probes (≤6 for a 49-hour run).
    _binarySearchEdge: function (name, fc, lo, hi) {
        const step = () => {
            if (hi - lo <= 1) return Promise.resolve(lo)
            const mid = (lo + hi) >> 1
            return this._probeFxx(name, fc, mid).then((ok) => {
                if (ok) lo = mid
                else hi = mid
                return step()
            })
        }
        return step()
    },

    // Does forecast hour `n` of this run exist? Probes the render service, not
    // the tiles. COG → titiler /cog/info (honest status, viewport-independent);
    // velocity → HEAD the gribjson file.
    _probeFxx: function (name, fc, n) {
        const ld = L_.layers.data[name]
        const url = ld?.url || ''

        if (url.toUpperCase().startsWith('COG:')) {
            const info = this._cogInfoUrl(name, fc, n)
            if (!info) return Promise.resolve(true)
            return fetch(info, { cache: 'no-store' })
                .then((r) => {
                    this._dbg('probe cog/info', name, 'fxx=' + n, r.status)
                    return r.ok
                })
                .catch(() => false)
        }

        if (this._isHrrrVelocity(ld)) {
            const src = this._velocitySourceForFxx(ld, n)
            if (!src) return Promise.resolve(true)
            return fetch(src, { method: 'HEAD', cache: 'no-store' })
                .then((r) => {
                    this._dbg('probe velocity HEAD', name, 'fxx=' + n, r.status)
                    return r.ok
                })
                .catch(() => false)
        }

        return Promise.resolve(true)
    },

    _isHrrrVelocity: function (ld) {
        return ld?.type === 'velocity' && /\/hrrr\/gribjson\//i.test(ld.url || '')
    },

    // The titiler base the MAP actually uses, read off the built Leaflet layer's
    // tile template (`…/titiler/cog/tiles/…`) so we probe the exact host the map
    // renders through. Falls back to the same construction Map_.js uses when the
    // layer isn't built yet.
    _titilerBase: function (name) {
        const layer = L_.layers.layer[name]
        const m = /^(.*\/titiler)\/cog\//.exec(layer?._url || '')
        if (m) return m[1]
        const origin = window.location.origin
        const path = (window.location.pathname || '').replace(/\/$/g, '')
        return `${origin}${path}/titiler`
    },

    // titiler /cog/info URL for forecast hour `n` of this COG layer's run. The
    // source is the veloserver .tiff (strip the COG: routing prefix), {time}
    // resolved to the run, fxx set to n.
    _cogInfoUrl: function (name, fc, n) {
        const ld = L_.layers.data[name]
        const url = ld?.url || ''
        if (!url.toUpperCase().startsWith('COG:')) return null
        const timeStr = new Date(this._forecastBase(fc)).toISOString()
        const src = this._setFxx(
            url.slice(4).replace(/{time}/g, timeStr).replace(/{endtime}/g, timeStr),
            n
        )
        return `${this._titilerBase(name)}/cog/info?url=${encodeURIComponent(src)}`
    },

    // The gribjson source URL for forecast hour `n`, {time} resolved.
    _velocitySourceForFxx: function (ld, n) {
        const url = ld?.url || ''
        const timeStr = ld.time?.end || new Date().toISOString()
        return this._setFxx(
            url.replace(/{time}/g, timeStr).replace(/{endtime}/g, timeStr),
            n
        )
    },

    // WMS availability: a real 1x1 GetMap judged by content-type.
    _probeWmsTime: function (name, fc) {
        const url = this._wmsProbeUrl(name, fc)
        // No __FSTEP__ template to build from — nothing to ask, so leave the
        // card to whatever the tiles say rather than asserting availability.
        if (!url) return Promise.resolve('available')

        this._dbg('probe WMS GetMap', name, url)
        return fetch(url, { cache: 'no-store' }).then((r) => {
            const ct = (r.headers.get('content-type') || '').toLowerCase()
            // GeoServer answers an out-of-extent TIME with HTTP 200 and an OGC
            // ServiceException *XML* body (application/vnd.ogc.se_xml), never an
            // error status — so r.ok is meaningless here and the content-type is
            // the only honest signal. A real render is an image; anything else
            // (XML exception, HTML error page) means the run/day isn't there.
            const verdict = r.ok && ct.startsWith('image/') ? 'available' : 'unavailable'
            this._dbg('probe WMS ->', verdict, name, r.status, ct)
            return verdict
        })
    },

    // A minimal-but-real GetMap that reports whether the RUN this card is
    // anchored to exists. It always asks forecast day 1 (__FSTEP__ = 1) at the
    // run date, never the selected step, and that is deliberate:
    //
    //  * WFPI publishes a run atomically — all 7 forecast days at once — so
    //    day 1's presence is exactly equivalent to "this run exists", and one
    //    check governs every step.
    //  * A later day must NOT be probed on its own. GeoServer answers a day-N
    //    GetMap for a valid date the current run never produced by serving the
    //    SAME valid date from an older run's projection — an image, not an
    //    exception. So probing forecast-<step> reports "available" from a
    //    previous forecast while the run the card claims is missing. Day 1 has
    //    no such shadow: a day-1 map valid for date D can only come from the run
    //    issued on D, so it is the one honest signal for that run.
    //
    // Only the DETECTION changed from the original design: a real 1x1 GetMap
    // judged by content-type, instead of the GetCapabilities probe that failed
    // open (empty/unparseable extent, or any fetch error, all read "available").
    // The layer template omits BBOX/WIDTH/HEIGHT (Leaflet adds them per tile),
    // so they are appended here; without them GeoServer never actually renders
    // and so never raises the out-of-extent exception.
    _wmsProbeUrl: function (name, fc) {
        const ld = L_.layers.data[name]
        const base = fc._baseUrl || ld?.url || ''
        if (!base.includes('__FSTEP__')) return null

        const timeStr = new Date(this._forecastBase(fc)).toISOString().slice(0, 10)
        let url = base
            .replace(/__FSTEP__/g, '1')
            .replace(/{time}/g, timeStr)
            .replace(/{endtime}/g, timeStr)
            .replace(/{starttime}/g, timeStr)
        // CONUS in EPSG:3857; a 1x1 render is enough to force the extent check.
        if (!/[?&]width=/i.test(url)) url += '&width=1&height=1'
        if (!/[?&]bbox=/i.test(url)) {
            url += '&bbox=-13884991,2870341,-7455049,6338219'
        }
        return url
    },

    // ── Animation ──────────────────────────────────────────
    //
    // Playback walks a card's steps on a timer. Because each step is a separate
    // network fetch, playing straight away would stutter on every frame, so a
    // play press first prefetches the whole run and shows a progress bar.
    //
    // What "prefetch" can mean depends on how the layer carries its forecast hour:
    //   • HRRR gribjson velocity — one JSON per step, so every step is fetched
    //     and parsed into _frameCache. Playback then calls setData off memory
    //     and is genuinely smooth.
    //   • COG tile (?fxx=N) — no single URL per step; the visible tiles are
    //     requested instead so the browser/titiler caches are warm for the
    //     current viewport. Panning or zooming during playback still fetches.
    //   • WMS urlTemplate (WFPI) and STAC — the step number is baked into tile
    //     params rather than a swappable token, so these are not prefetched.
    //     They animate, just with live fetches per frame.

    _frameCache: {},
    _playTimers: {},

    // Frames are keyed by run, not just layer, so a new model run never animates
    // with the previous run's data still cached.
    _frameKey: function (name, fc) {
        return `${name}:${this._forecastBase(fc)}`
    },

    _setFxx: function (u, idx) {
        return /[?&]fxx=/i.test(u)
            ? u.replace(/([?&]fxx=)[^&]*/i, `$1${idx}`)
            : `${u}${u.indexOf('?') === -1 ? '?' : '&'}fxx=${idx}`
    },

    // Resolved single-URL fetch target for one step, or null when the layer has
    // no one-URL-per-step representation.
    _stepUrl: function (name, fc, idx) {
        const ld = L_.layers.data[name]
        if (!ld) return null
        if (ld.type === 'velocity' && /\/hrrr\/gribjson\//i.test(ld.url || '')) {
            const timeStr = ld.time?.end || new Date().toISOString()
            return this._setFxx(ld.url, idx)
                .replace(/{time}/g, timeStr)
                .replace(/{endtime}/g, timeStr)
                .replace(/{starttime}/g, ld.time?.start || timeStr)
        }
        return null
    },

    // Tile coords covering the current viewport, capped so a zoomed-out view
    // can't fan out into hundreds of requests per step.
    _visibleTileCoords: function (layer) {
        const map = layer?._map
        if (!map || typeof layer.getTileUrl !== 'function') return []
        const z = Math.round(map.getZoom())
        const size = layer.getTileSize ? layer.getTileSize().x : 256
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
    },

    // Run tasks with a small concurrency cap — a 49-step HRRR run fired all at
    // once would swamp the connection pool and stall the map's own tiles.
    _pooled: function (tasks, onDone, limit = 4) {
        return new Promise((resolve) => {
            if (!tasks.length) return resolve()
            let next = 0
            let active = 0
            let finished = 0
            const settle = () => {
                active--
                finished++
                if (onDone) onDone(finished, tasks.length)
                if (finished === tasks.length) resolve()
                else pump()
            }
            const runOne = () => {
                const task = tasks[next++]
                active++
                Promise.resolve().then(task).catch(() => {}).then(settle)
            }
            const pump = () => {
                while (active < limit && next < tasks.length) runOne()
            }
            pump()
        })
    },

    _prefetchSteps: function (name, fc, onProgress) {
        const steps = this._effectiveSteps(fc, name)
        const ld = L_.layers.data[name]
        const key = this._frameKey(name, fc)
        const isVelocity =
            ld?.type === 'velocity' && /\/hrrr\/gribjson\//i.test(ld.url || '')
        const isCog =
            ld?.type === 'tile' && (ld.url || '').toUpperCase().startsWith('COG:')

        if (!this._frameCache[key]) this._frameCache[key] = {}
        const frames = this._frameCache[key]

        const tasks = []
        for (let i = 0; i < steps; i++) {
            const idx = i
            if (isVelocity) {
                if (frames[idx]) continue
                const url = this._stepUrl(name, fc, idx)
                if (!url) continue
                tasks.push(() =>
                    fetch(url)
                        .then((r) => {
                            if (!r.ok) throw new Error(r.status)
                            return r.json()
                        })
                        .then((data) => {
                            frames[idx] = data
                        })
                )
            } else if (isCog) {
                const layer = L_.layers.layer[name]
                const coords = this._visibleTileCoords(layer)
                if (!coords.length) continue
                tasks.push(() =>
                    Promise.all(
                        coords.map((c) => {
                            let u
                            try {
                                u = layer.getTileUrl(c)
                            } catch (e) {
                                return null
                            }
                            if (typeof u !== 'string') return null
                            // Warm the cache, don't keep the bytes.
                            return fetch(this._setFxx(u, idx), { mode: 'no-cors' }).catch(
                                () => {}
                            )
                        })
                    )
                )
            }
        }

        if (!tasks.length) {
            if (onProgress) onProgress(1, 1)
            return Promise.resolve()
        }
        return this._pooled(tasks, onProgress)
    },

    _setPlayUI: function (name, mode, pct) {
        ;[document.getElementById('ftl-strip')]
            .forEach((container) => {
                const card = container?.querySelector(`.ftl-card[data-layer="${_escSel(name)}"]`)
                if (!card) return
                const btn = card.querySelector('.ftl-card-play')
                const icon = btn?.querySelector('i')
                const wrap = card.querySelector('.ftl-card-prefetch')
                const bar = wrap?.querySelector('.ftl-card-prefetch-bar')
                if (icon) {
                    icon.className =
                        mode === 'idle' ? 'mdi mdi-play' : 'mdi mdi-stop'
                }
                if (btn) {
                    btn.classList.toggle('ftl-playing', mode !== 'idle')
                    btn.title =
                        mode === 'loading'
                            ? 'Loading forecast steps — click to cancel'
                            : mode === 'playing'
                            ? 'Stop animation'
                            : 'Play forecast animation'
                }
                if (wrap) wrap.classList.toggle('ftl-prefetching', mode === 'loading')
                if (bar) bar.style.width = `${Math.round((pct || 0) * 100)}%`
            })
    },

    // Hover text for the play button. Built at hover time so the step count and
    // playing/stopped wording are always current.
    _playTipHtml: function (name, fc) {
        const steps = this._effectiveSteps(fc, name)
        const unit = (fc?.stepUnit || 'hour') === 'day' ? 'day' : 'hour'
        if (this._isPlaying(name)) {
            return (
                '<b>Stop animation</b><br/>' +
                '<span style="opacity:.75">Returns to manual stepping.</span>'
            )
        }
        return (
            '<b>Play forecast animation</b><br/>' +
            `<span style="opacity:.75">Loads all ${steps} ${unit} steps, then` +
            ' steps through them on the map in a loop. Click again to stop.</span>'
        )
    },

    _isPlaying: function (name) {
        return !!(this._playTimers && this._playTimers[name])
    },

    _stopPlay: function (name) {
        const t = this._playTimers?.[name]
        if (t) {
            clearInterval(t.timer)
            t.cancelled = true
        }
        if (this._playTimers) delete this._playTimers[name]
        this._setPlayUI(name, 'idle', 0)
    },

    _startPlay: function (name, fc) {
        if (!this._playTimers) this._playTimers = {}
        if (this.state.cards[name]?.cardState !== 'available') return

        // Placeholder entry so a second click during prefetch cancels.
        const token = { timer: null, cancelled: false }
        this._playTimers[name] = token
        this._setPlayUI(name, 'loading', 0)

        this._prefetchSteps(name, fc, (done, total) => {
            if (!token.cancelled) this._setPlayUI(name, 'loading', total ? done / total : 1)
        }).then(() => {
            if (token.cancelled || this._playTimers[name] !== token) return
            const steps = this._effectiveSteps(fc, name)
            if (steps <= 1) {
                this._stopPlay(name)
                return
            }
            this._setPlayUI(name, 'playing', 1)
            // Start from the beginning so playback always reads as a full run.
            let idx = 0
            this._setCardStep(name, fc, idx)
            token.timer = setInterval(() => {
                if (this.state.cards[name]?.cardState !== 'available') {
                    this._stopPlay(name)
                    return
                }
                idx = (idx + 1) % steps
                this._setCardStep(name, fc, idx)
            }, PLAY_INTERVAL_MS)
        })
    },

    _togglePlay: function (name, fc) {
        if (this._isPlaying(name)) this._stopPlay(name)
        else this._startPlay(name, fc)
    },

    // Set a forecast card's visual state. state is one of:
    //   'loading'     — probe in flight: ticks/buttons dark, "Fetching…" in init row
    //   'unavailable' — probe returned error: ticks/buttons dark, warning in init row
    //   'available'   — probe ok: normal interactive card
    _setCardState: function (name, state) {
        if (this.state.cards[name]) this.state.cards[name].cardState = state
        if (typeof window !== 'undefined' && window.FTL_DEBUG) {
            const strip = document.getElementById('ftl-strip')
            const found = !!strip?.querySelector(
                `.ftl-card[data-layer="${_escSel(name)}"]`
            )
            this._dbg('setCardState', name, '->', state,
                found ? '(DOM card found)' : '(NO DOM CARD — visual NOT updated)',
                { hasStrip: !!strip })
        }
        const disabled = state !== 'available'
        // A card that just went unavailable must not keep animating against a
        // run that isn't there.
        if (disabled && this._isPlaying(name)) this._stopPlay(name)
        ;[document.getElementById('ftl-strip')]
            .forEach((container) => {
                const card = container?.querySelector(`.ftl-card[data-layer="${_escSel(name)}"]`)
                if (!card) return

                // Card-level state classes drive the dark-button CSS
                card.classList.toggle('ftl-card-loading', state === 'loading')
                card.classList.toggle('ftl-card-unavailable', state === 'unavailable')

                // Ticks: ftl-future-item greys them and kills pointer-events.
                // A tick is greyed when the whole card is disabled OR when the
                // step is past this run's published edge (see _tickBeyondEdge).
                const cardIdx = this.state.cards[name]?.stepIndex ?? 0
                card.querySelectorAll('.ftl-tick').forEach((t, i) => {
                    const off = disabled || this._tickBeyondEdge(name, i)
                    t.classList.toggle('ftl-future-item', off)
                    this._setTickEdgeTitle(t, name, i)
                    if (off) t.classList.remove('active')
                    else t.classList.toggle('active', i === cardIdx)
                })

                // Buttons: also set disabled attr for semantics/keyboard
                const fc = L_.layers.data[name]?.time?.forecast
                const steps = fc ? this._effectiveSteps(fc, name) : 1
                card.querySelector('.ftl-card-prev')?.toggleAttribute('disabled', disabled || cardIdx === 0)
                card.querySelector('.ftl-card-next')?.toggleAttribute('disabled', disabled || cardIdx === steps - 1)
                card.querySelector('.ftl-card-play')?.toggleAttribute('disabled', disabled || steps <= 1)

                // Init row text
                const initEl = card.querySelector('.ftl-card-init')
                const captionEl = card.querySelector('.ftl-card-init-caption')
                if (state === 'loading') {
                    if (captionEl) captionEl.style.display = 'none'
                    initEl?.removeAttribute('title')
                    if (initEl) initEl.innerHTML =
                        '<span style="color:var(--color-a5);font-size:10px;text-transform:uppercase;letter-spacing:.04em;font-style:italic">Fetching\u2026</span>'
                } else if (state === 'unavailable') {
                    if (captionEl) captionEl.style.display = 'none'
                    if (initEl) {
                        // Name the run that failed to probe — "not yet generated" on its
                        // own leaves the user guessing which cycle is missing.
                        const runStr = this._runLabel(fc)
                        initEl.innerHTML =
                            '<i class="mdi mdi-alert" style="color:#e8a020;font-size:13px;vertical-align:middle"></i>' +
                            ' <span style="color:#e8a020;font-size:10px;text-transform:uppercase;letter-spacing:.04em">' +
                            `${runStr} run not yet generated</span>`
                        initEl.setAttribute(
                            'title',
                            `The ${runStr} model run has not been generated yet.`
                        )
                    }
                } else {
                    if (captionEl) captionEl.style.display = ''
                    initEl?.removeAttribute('title')
                    if (initEl) {
                        const unit = fc?.stepUnit || 'hour'
                        const originBase = this._forecastBase(fc || {})
                        initEl.textContent = this._formatInit(originBase, unit, fc || {})
                    }
                }
            })
    },

    // ── Cleanup ────────────────────────────────────────────

    cleanup: function () {
        // Kill any running animations before the cards they drive disappear,
        // otherwise the intervals keep firing _setCardStep against dead DOM.
        Object.keys(this._playTimers || {}).forEach((n) => this._stopPlay(n))
        this._playTimers = {}
        this._frameCache = {}

        this.state.cards = {}
        this._edgeCache = {}

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

        // Restore TimeUI navigation and expanded rows
        this._unpatchTimeUINavigation()
        this._unpatchPopulateExpandedRows()
        this._unpatchToggleLayer()
        if (this._optimisticOn) this._optimisticOn.clear()
        this._toggleTick = {}

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

        document.getElementById('ftl-strip')?.remove()
        document.getElementById('ftl-tooltip')?.remove()
    },
}

export default ForecastTimeline

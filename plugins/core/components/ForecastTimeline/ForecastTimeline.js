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
 *   { enabled: true, label: "FDEO Monthly", steps: 1, stepUnit: "month", stepOffset: 0,
 *     description: "..." }
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
 *
 * fxx layers (config-driven): a layer opts into per-hour forecast stepping by
 *   including ?fxx=0 in its configured URL (e.g. the HRRR COG rasters and the
 *   HRRR gribjson velocity layer). The card steps the forecast hour by rewriting
 *   that param in place — no product paths are hardcoded here. A URL without
 *   fxx= (e.g. GFS gribjson, analysis-only) is naturally excluded.
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
    month: null, // variable length — use _addMonths() helper, not a fixed ms
}

// Add N calendar months to a UTC timestamp, anchoring to the 1st of the month.
function _addMonths(ms, n) {
    const d = new Date(ms)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)
}

// Label timezone: whatever zone the viewer's browser reports — the same
// display space the LocalTimezone plugin puts the main timeline in. Labels
// format real instants through this zone, so hours stay DST-correct on their
// own (a 00:00Z boundary reads 5 PM PDT in summer, 4 PM PST in winter) and a
// viewer in another zone sees their own local times (EST, UTC, ...).
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

// HRRR forecast hours: every run reaches F18, but the runs started at 00/06/12/18
// UTC reach F48. fxx == step index, so a COG card offers (max fxx + 1) steps.
const HRRR_FXX_MAX = 18
const HRRR_FXX_MAX_EXTENDED = 48
// The four init hours (UTC) whose runs go all the way to F48.
const HRRR_EXTENDED_INIT_HOURS = [0, 6, 12, 18]

// Delay between animation frames. Slow enough to read the tick labels, fast
// enough that a 49-step HRRR run doesn't take a minute to loop.
const PLAY_INTERVAL_MS = 700

// Delay before a re-check of a "not generated" card shows "Loading…". A fast
// probe resolves within this window, so the card skips the flash. Only the text
// is deferred; the probe itself fires immediately.
const PROBE_LOADING_DELAY_MS = 150

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

    // For now playback is further limited to the HRRR COG raster layers
    // (tile + COG: + ?fxx= in the config URL). Velocity's per-frame gribs and
    // the WMS/STAC products keep manual stepping only until their playback is
    // worth trusting.
    _playbackAllowed: function (name) {
        if (!this._playbackEnabled()) return false
        const ld = L_.layers.data[name]
        return (
            ld?.type === 'tile' &&
            (ld.url || '').toUpperCase().startsWith('COG:') &&
            this._isFxxLayer(ld)
        )
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
        // Core may have populated the rows before this plugin loaded (mobile
        // populates at TimeUI init) — those items sit unmarked (bright) until
        // the next repopulate, a visible white flash. Mark what's already there.
        this._markFutureExpandedItems()
    },

    _unpatchPopulateExpandedRows: function () {
        if (this._origPopulateExpandedRows) {
            TimeUI._populateExpandedRows = this._origPopulateExpandedRows
            this._origPopulateExpandedRows = null
        }
        document.getElementById('ftl-future-style')?.remove()
    },

    // Mirror of ForecastTimeline.css's .ftl-future-item declarations, applied
    // through attribute selectors that pre-exist the row DOM. The class pass in
    // _markFutureExpandedItems only runs AFTER a populate it can see — any row
    // build it doesn't wrap (or that paints before it runs) shows future items
    // bright for a beat. Rules keyed on data-year/-month/-day/-hour match the
    // instant an item is created, so it can never paint undarkened; the class
    // marking remains the settled state the rest of the plugin keys off.
    _syncFutureCSS: function (nowYear, nowMonth, nowDay, nowHour, shownYear, shownMonth, shownDay) {
        let styleEl = document.getElementById('ftl-future-style')
        if (!styleEl) {
            styleEl = document.createElement('style')
            styleEl.id = 'ftl-future-style'
            document.head.appendChild(styleEl)
        }
        const sels = []
        // Years: the row lists only past years today, but guard a couple
        // decades ahead in case that changes.
        for (let y = nowYear + 1; y <= nowYear + 20; y++)
            sels.push(`#mmgisTimeUIYearsContainer .mmgisTimeUIExpandedItem[data-year="${y}"]`)
        // Months
        if (shownYear > nowYear) {
            sels.push('#mmgisTimeUIMonthsContainer .mmgisTimeUIExpandedItem')
        } else if (shownYear === nowYear) {
            for (let m = nowMonth + 1; m < 12; m++)
                sels.push(`#mmgisTimeUIMonthsContainer .mmgisTimeUIExpandedItem[data-month="${m}"]`)
        }
        // Days
        if (shownYear > nowYear || (shownYear === nowYear && shownMonth > nowMonth)) {
            sels.push('#mmgisTimeUIDaysContainer .mmgisTimeUIExpandedItem')
        } else if (shownYear === nowYear && shownMonth === nowMonth) {
            for (let d = nowDay + 1; d <= 31; d++)
                sels.push(`#mmgisTimeUIDaysContainer .mmgisTimeUIExpandedItem[data-day="${d}"]`)
        }
        // Hours
        if (
            shownYear > nowYear ||
            (shownYear === nowYear && shownMonth > nowMonth) ||
            (shownYear === nowYear && shownMonth === nowMonth && shownDay > nowDay)
        ) {
            sels.push('#mmgisTimeUIHoursContainer .mmgisTimeUIExpandedItem')
        } else if (shownYear === nowYear && shownMonth === nowMonth && shownDay === nowDay) {
            for (let h = nowHour + 1; h < 24; h++)
                sels.push(`#mmgisTimeUIHoursContainer .mmgisTimeUIExpandedItem[data-hour="${h}"]`)
        }
        styleEl.textContent = sels.length
            ? `${sels.join(',\n')} {
    opacity: 0.3;
    pointer-events: none;
    cursor: default;
    background-image: repeating-linear-gradient(
        -45deg,
        rgba(80, 80, 90, 0.25) 0px,
        rgba(80, 80, 90, 0.25) 2px,
        transparent 2px,
        transparent 7px
    ) !important;
}`
            : ''
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

        // Refresh the attribute-selector rules first so items REBUILT after
        // this pass (by any code path) still paint dark on their first frame.
        this._syncFutureCSS(nowYear, nowMonth, nowDay, nowHour, shownYear, shownMonth, shownDay)

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
                    // A fresh toggle-on is a natural retry: forget any cached
                    // negative/failed availability for this layer so the check
                    // runs again (a run that 502'd minutes ago may be out now).
                    Object.keys(self._edgeCache || {}).forEach((k) => {
                        if (k.slice(0, k.lastIndexOf(':')) === name)
                            delete self._edgeCache[k]
                    })
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
            if (!activeNames.has(n)) {
                delete this.state.cards[n]
                this._detachLoadIndicator(n)
            }
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
                // Tick-spinner tile hooks. No-op until the Leaflet layer is
                // built; the toggle-settle rebuild retries and hooks it then.
                this._attachLoadIndicator(name)
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

    // Model init time floored to the selected hour's :00 (e.g. 02:55 → 02:00).
    // All forecast steps are generated from this floored base so ticks land on
    // clean hour boundaries and the "MODEL INITIALIZED AT" readout matches.
    //
    // Anchored to the TIMELINE's selected time (TimeControl.currentTime), never
    // the wall clock: probes and step math must target the run the layers
    // themselves load. state.originMs (synced in _onTimeChange) is the fallback
    // for the window before TimeControl has a time. Using Date.now() here made a
    // freshly-opened page probe the current hour's run — which veloserver 502s
    // for the ~hour before HRRR publishes it — so cards read "not yet generated"
    // while the layers themselves loaded fine at the selected time.
    _originBase: function () {
        let t = NaN
        if (TimeControl.currentTime) t = new Date(TimeControl.currentTime).getTime()
        if (isNaN(t)) t = this.state.originMs || Date.now()
        const d = new Date(t)
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
        const unit = fc?.stepUnit || 'hour'
        if (unit === 'month') {
            const d = new Date(base)
            return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
        }
        if (unit !== 'day') return base
        const runHourUTC = Number.isFinite(fc.runHourUTC) ? fc.runHourUTC : 0
        const d = new Date(base)
        const runToday = Date.UTC(
            d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
            runHourUTC, 0, 0, 0
        )
        // Latest run <= selected time: today's UTC run if it has occurred, else yesterday's.
        return runToday <= base ? runToday : runToday - STEP_UNITS.day
    },

    // Number of steps the card should offer. fxx layers (opted in via ?fxx= in
    // their config URL — the HRRR COG rasters and the HRRR gribjson velocity
    // layer) know their own range from the init time -- every run reaches F18, but
    // runs started at 00/06/12/18 UTC reach F48 -- so no per-layer config. Other
    // forecast layers (WFPI daily, PWWB hourly) use their configured fc.steps. The init-hour check is on the selected
    // instant's UTC hour, so it's correct whatever the PDT display shows (DST-safe).
    _effectiveSteps: function (fc, name) {
        const ld = name ? L_.layers.data[name] : null
        if (!this._isFxxLayer(ld)) return fc.steps || 1
        const initHourUTC = new Date(this._originBase()).getUTCHours()
        const isExtendedRun = HRRR_EXTENDED_INIT_HOURS.includes(initHourUTC)
        return (isExtendedRun ? HRRR_FXX_MAX_EXTENDED : HRRR_FXX_MAX) + 1
    },

    // True for a layer whose forecast hour is carried as a ?fxx=N query param.
    // The opt-in is the CONFIG URL itself: a layer that includes fxx= in its
    // configured URL (e.g. "…/{time}.tiff?fxx=0") is an fxx layer; nothing about
    // product paths is hardcoded. GFS gribjson is winds-only analysis — its URL
    // carries no fxx — so it is naturally excluded.
    _isFxxLayer: function (ld) {
        return /[?&]fxx=/i.test(ld?.url || '')
    },

    // WFPI gets special label treatment in several places (window tick labels,
    // wider+taller card, init-row span) — one predicate so they can't drift.
    _isWfpi: function (fc) {
        return /wfpi/i.test(fc?.label || '')
    },

    // Per-layer configurable step label. time.forecast.stepLabel wins;
    // otherwise derived from stepSize (default 1) + stepUnit ("hour"/"day").
    _stepLabel: function (fc) {
        if (fc.stepLabel) return fc.stepLabel
        const size = fc.stepSize || 1
        const unit = fc.stepUnit || 'hour'
        const abbr =
            unit === 'month'
                ? size === 1 ? 'month' : 'months'
                : unit === 'day'
                    ? size === 1 ? 'day' : 'days'
                    : size === 1 ? 'hr' : 'hrs'
        return `${size} ${abbr}`
    },

    // Compact label for the model run a probe targeted, for the "not yet
    // generated" warning: "Jul 20, 5 PM" (hourly, browser-local) or "Jul 20"
    // (daily, UTC-dated to match the run actually fetched) or "Jul 2026"
    // (monthly run identity). WFPI always specifies its FULL valid range
    // instead of a single date — dates only ("Jul 21 – Jul 28"), no times, so
    // the warning line fits the init row. The local dates match the window
    // boundaries the ticks show.
    _runLabel: function (fc) {
        const base = this._forecastBase(fc || {})
        const unit = fc?.stepUnit || 'hour'
        if (unit === 'month') {
            return new Date(base).toLocaleDateString('en-US', {
                timeZone: 'UTC',
                month: 'short',
                year: 'numeric',
            })
        }
        if (unit === 'day') {
            if (this._isWfpi(fc)) {
                const dOpts = { timeZone: LOCAL_TZ, month: 'short', day: 'numeric' }
                const endD = new Date(base + (fc.steps || 7) * STEP_UNITS.day)
                return `${new Date(base).toLocaleDateString('en-US', dOpts)} – ${endD.toLocaleDateString('en-US', dOpts)}`
            }
            return new Date(base).toLocaleDateString('en-US', {
                timeZone: 'UTC',
                month: 'short',
                day: 'numeric',
            })
        }
        return new Date(base).toLocaleString('en-US', {
            timeZone: LOCAL_TZ,
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            hour12: true,
        })
    },

    // "Jun 30, 2026 · 2:00 PM PDT"  (hourly)  or  "Jul 7, 2026"  (daily) —
    // times rendered in the viewer's browser timezone (PDT here as an example)
    _formatInit: function (ms, unit, fc) {
        const d = new Date(ms)
        if (unit === 'month') {
            // Monthly (FDEO): communicate the whole valid span with its real
            // boundary instants, WFPI-style. The run turns over at 00:00Z on
            // the 1st, which is the previous evening in local display time —
            // e.g. "Jun 30, 5 PM – Jul 31, 5 PM PDT" for a 1-month July card.
            const steps = fc?.steps || 1
            const endD = new Date(_addMonths(ms, steps))
            const dOpts = { timeZone: LOCAL_TZ, month: 'short', day: 'numeric' }
            const tOpts = { timeZone: LOCAL_TZ, hour: 'numeric', hour12: true }
            const start = `${d.toLocaleDateString('en-US', dOpts)} ${d.toLocaleTimeString('en-US', tOpts)}`
            const end = `${endD.toLocaleDateString('en-US', dOpts)} ${endD.toLocaleTimeString('en-US', { ...tOpts, timeZoneName: 'short' })}`
            return `${start} – ${end}`
        }
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
            if (this._isWfpi(fc)) {
                const steps = fc.steps || 7
                const dOpts = { timeZone: LOCAL_TZ, month: 'short', day: 'numeric' }
                const tOpts = { timeZone: LOCAL_TZ, hour: 'numeric', hour12: true }
                const endD = new Date(ms + steps * STEP_UNITS.day)
                const start = `${d.toLocaleDateString('en-US', dOpts)} ${d.toLocaleTimeString('en-US', tOpts)}`
                const end = `${endD.toLocaleDateString('en-US', dOpts)} ${endD.toLocaleTimeString('en-US', { ...tOpts, timeZoneName: 'short' })}`
                return `${start} – ${end}`
            }
            return dateStr
        }
        const dateStr = d.toLocaleDateString('en-US', {
            timeZone: LOCAL_TZ,
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        })
        const timeStr = d.toLocaleTimeString('en-US', {
            timeZone: LOCAL_TZ,
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
        const offset = fc.stepOffset || 0

        if (unit === 'month') {
            // Monthly (FDEO): show the step's full valid window the same way
            // WFPI daily does — dates on the clock line, boundary times on the
            // rel line. A month is valid from 00:00Z on its 1st through 00:00Z
            // on the next month's 1st, which in local display time lands the
            // evening before (e.g. Jul 2026 = "6/30–7/31" + "5PM–5PM" in PDT).
            // Formatting the real instants keeps the hour DST-correct and in
            // the viewer's own timezone.
            const stepDate = new Date(_addMonths(originBase, i + offset))
            const endDate = new Date(_addMonths(originBase, i + offset + 1))
            const winD = { timeZone: LOCAL_TZ, month: 'numeric', day: 'numeric' }
            const clock = `${stepDate.toLocaleDateString('en-US', winD)}–${endDate.toLocaleDateString('en-US', winD)}`
            const fmtT = (dd) =>
                dd.toLocaleTimeString('en-US', {
                    timeZone: LOCAL_TZ,
                    hour: 'numeric',
                    hour12: true,
                }).replace(' ', '')
            return { clock, rel: `${fmtT(stepDate)}–${fmtT(endDate)}` }
        }

        const unitMs = STEP_UNITS[unit] || STEP_UNITS.hour
        // stepOffset is documented as required, but a mission config that omits
        // it must degrade to "first step = init time", not render "hNaN" and
        // "Invalid Date" into an operational forecast card. The chip label
        // below already defaults the same way.
        const stepDate = new Date(originBase + (i + offset) * unitMs)

        if (unit === 'day') {
            const dOpts = { timeZone: 'UTC', month: 'short', day: 'numeric' }
            // WFPI: every step shows its full valid window, compacted to fit
            // the standard fixed-width tick so all cards keep the same button
            // size — full numeric dates on the clock line ("7/21–7/22"; the
            // month is always shown on both sides) and the window times on the
            // small line where other products show "+n" ("5PM–5PM"). A step is
            // valid from its 00:00Z stamp (5 PM PDT the prior evening) through
            // the next 00:00Z. Formatting the real instants (rather than
            // hardcoding "5 PM") keeps the hour right across DST (4PM–4PM in
            // winter).
            if (this._isWfpi(fc)) {
                const endDate = new Date(stepDate.getTime() + unitMs)
                const winD = { timeZone: LOCAL_TZ, month: 'numeric', day: 'numeric' }
                const clock = `${stepDate.toLocaleDateString('en-US', winD)}–${endDate.toLocaleDateString('en-US', winD)}`
                const fmtT = (dd) =>
                    dd.toLocaleTimeString('en-US', {
                        timeZone: LOCAL_TZ,
                        hour: 'numeric',
                        hour12: true,
                    }).replace(' ', '')
                return { clock, rel: `${fmtT(stepDate)}–${fmtT(endDate)}` }
            }
            const clock = stepDate.toLocaleString('en-US', dOpts)
            return { clock, rel: `+${i + offset}` }
        }

        const clock = stepDate.toLocaleString('en-US', {
            timeZone: LOCAL_TZ,
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

        // Experimental — only rendered when the mission opts in, and only on
        // HRRR COG cards for now (see _playbackAllowed).
        const playBtnHTML = this._playbackAllowed(name)
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
        // Daily cards use fixed-width steps (see CSS) so a 1-step daily card stays
        // one step wide instead of stretching a lone tick across the whole track.
        const dailyClass = (unit === 'day' || unit === 'month') ? ' ftl-card-daily' : ''
        const ticksWrapClass = large ? 'ftl-ticks-wrap' : 'ftl-ticks-wrap mmgisTimeUIExpandedRowContainer'

        const unitWord = unit === 'month' ? 'monthly' : unit === 'day' ? 'daily' : unit === 'week' ? 'weekly' : 'hourly'
        // Hourly tracks label by max lead time (last tick's hour), so HRRR's
        // H0..H18 reads "18 hrs" not "19". Daily/weekly/monthly label by step count.
        const span = unit === 'day' || unit === 'week' || unit === 'month'
            ? steps
            : (steps - 1) + (fc.stepOffset || 0)
        const unitPlural = unit === 'month'
            ? (span === 1 ? 'month' : 'months')
            : unit === 'day'
                ? (span === 1 ? 'day' : 'days')
                : unit === 'week' ? 'weeks' : 'hrs'
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
        if (!this.state.cards[name]) return
        this.state.cards[name].stepIndex = idx
        this._refreshAllCards()
        this._applyCardStep(name, fc, idx)
    },

    // Busy affordance on a single tick: a small corner spinner on the step
    // whose data is currently in flight (velocity grib fetch, COG/WMS tile
    // load). Shows the click registered, exactly where the user clicked.
    //
    // Every `on` carries an auto-clear timeout (ttlMs): the COG tile path has
    // no reliable completion signal (the anti-flicker refresh swaps tile srcs
    // directly, bypassing Leaflet's load events), and even where callbacks
    // exist a dropped one must never leave a spinner going forever.
    _tickSpinTimers: {},

    _setTickLoading: function (name, idx, on, ttlMs) {
        const strip = document.getElementById('ftl-strip')
        if (!strip) return
        if (this._tickSpinTimers[name]) {
            clearTimeout(this._tickSpinTimers[name])
            delete this._tickSpinTimers[name]
        }
        strip
            .querySelectorAll(`.ftl-tick[data-layer="${_escSel(name)}"]`)
            .forEach((el) => {
                const isTarget = on && parseInt(el.dataset.step) === idx
                el.classList.toggle('ftl-tick-loading', isTarget)
            })
        if (on) {
            this._tickSpinTimers[name] = setTimeout(() => {
                delete this._tickSpinTimers[name]
                this._clearTickLoading(name)
            }, ttlMs || 8000)
        }
    },

    // Clear every tick spinner on a card (used when its state changes wholesale).
    _clearTickLoading: function (name) {
        this._setTickLoading(name, -1, false)
    },

    // Tile layers (COG fxx and WMS urlTemplate) load asynchronously through
    // Leaflet, which fires 'loading'/'load' on the layer itself. Hook those
    // once per built layer so the active tick spins while tiles are in flight.
    // The velocity path instruments its own fetch instead (no Leaflet events).
    _attachLoadIndicator: function (name) {
        const leafletLayer = L_.layers.layer[name]
        if (!leafletLayer || typeof leafletLayer.on !== 'function') return
        if (!this._loadHooks) this._loadHooks = {}
        if (this._loadHooks[name]) return // already hooked (hooks survive rebuilds)
        const onLoading = () => {
            const idx = this.state.cards[name]?.stepIndex
            if (typeof idx === 'number') this._setTickLoading(name, idx, true)
        }
        const onLoad = () => this._clearTickLoading(name)
        leafletLayer.on('loading', onLoading)
        leafletLayer.on('load', onLoad)
        leafletLayer.on('tileerror', onLoad)
        this._loadHooks[name] = { layer: leafletLayer, onLoading, onLoad }
    },

    _detachLoadIndicator: function (name) {
        const hook = this._loadHooks?.[name]
        if (!hook) return
        hook.layer.off('loading', hook.onLoading)
        hook.layer.off('load', hook.onLoad)
        hook.layer.off('tileerror', hook.onLoad)
        delete this._loadHooks[name]
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
        // While the probe is in flight the ticks pulse (skeleton) instead of
        // going dark — dark is reserved for "model not available".
        const isLoading = cardState === 'loading'

        card.querySelectorAll('.ftl-tick').forEach((el, i) => {
            el.classList.toggle('ftl-tick-skeleton', isLoading)
            el.classList.toggle('ftl-future-item', isDisabled && !isLoading)
            el.classList.toggle('active', !isDisabled && i === idx)
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
        const originMs = this._forecastBase(fc)
        // Default to 0 for the same reason _tickLabels does — a config missing
        // stepOffset must not compute a NaN step time and request it.
        const offset = fc.stepOffset || 0
        let stepMs = fc.stepUnit === 'month'
            ? _addMonths(originMs, idx + offset)
            : originMs + (idx + offset) * (STEP_UNITS[fc.stepUnit] || STEP_UNITS.hour)

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

            if (
                ld.type === 'tile' &&
                (ld.url || '').toUpperCase().startsWith('COG:') &&
                this._isFxxLayer(ld)
            ) {
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
                    if (newUrl !== leafletLayer._url) {
                        // Spin the clicked tick while tiles come in — but only
                        // on the FIRST visit to this step this run. Revisited
                        // steps serve from the browser tile cache near-
                        // instantly, and a spinner there reads as a false
                        // "loading" flash. The anti-flicker refresh gives no
                        // completion event, so the spinner rides the auto-
                        // clear (tiles typically land well inside it).
                        if (!this._visitedSteps) this._visitedSteps = new Set()
                        const visitKey = `${name}:${this._forecastBase(fc)}:${idx}`
                        if (!this._visitedSteps.has(visitKey)) {
                            this._visitedSteps.add(visitKey)
                            // Not during playback: prefetch already warmed the
                            // tiles, and a spinner hopping tick-to-tick at
                            // frame rate reads as noise, not feedback.
                            if (!this._isPlaying(name))
                                this._setTickLoading(name, idx, true, 2500)
                        }
                        leafletLayer.refresh(newUrl, true)
                    }
                }
                return
            }

            // fxx velocity layer (HRRR gribjson): same ?fxx=N scheme as the COG
            // layers — opted in by the fxx= in its configured URL — but
            // leaflet-velocity has no in-place URL swap like a tile .refresh(),
            // so rewrite fxx on ld.url and let reloadLayer re-fetch. reloadLayer's
            // velocity path toggles the layer off/on, re-running makeVelocityLayer
            // -> captureVector against the new URL. {time} stays a live token (the
            // run/init time from the main timeline); step 0 -> fxx=0 (the analysis).
            if (this._isFxxVelocity(ld)) {
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
                    // Spin the clicked tick while the grib is in flight — the
                    // only feedback that the click registered (fetches run 1–3s).
                    this._setTickLoading(name, idx, true)
                    fetch(fetchUrl)
                        .then((r) => {
                            if (!r.ok) throw new Error(r.status)
                            return r.json()
                        })
                        .then((data) => {
                            this._setTickLoading(name, idx, false)
                            leafletLayer.setData(data)
                            // Keep the frame so revisiting this step is instant
                            // (setData straight from memory — no refetch, no
                            // spinner). Same per-run store playback prefetch
                            // uses, so a new model run never serves stale frames.
                            const fk = this._frameKey(name, fc)
                            if (!this._frameCache[fk]) this._frameCache[fk] = {}
                            this._frameCache[fk][idx] = data
                            // This step's data is present — direct proof the
                            // run exists.
                            this._markRunPresent(name, fc)
                        })
                        .catch((e) => {
                            this._setTickLoading(name, idx, false)
                            console.warn('ForecastTimeline: velocity fxx update failed', e)
                            // The probes said this run exists, but the data
                            // didn't come back — the services can be briefly
                            // desynced. Disable just this card with the
                            // "Forecast not available" message (not the
                            // "run not generated" one, which would be a lie).
                            this._failCard(name, fc)
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
            // the query end is one step earlier. This makes the forecast tick for
            // day T show exactly what the normal timeline shows at day T-1 --
            // because it's a forecast (issued on T-1, valid for T). Computed the
            // same way stepMs is, so month steps land on the true previous month
            // boundary rather than a fixed-ms subtraction.
            const prevStepMs = fc.stepUnit === 'month'
                ? _addMonths(originMs, idx + offset - 1)
                : stepMs - (STEP_UNITS[fc.stepUnit] || STEP_UNITS.hour)
            const queryEndIso = new Date(prevStepMs).toISOString()

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
            // A new selected time is a new model run, so snap every card back to
            // its first step. The refresh below moves the active tick to step 0
            // and _reapplyAllSteps applies it (fxx=0 / first day) to the layer.
            Object.keys(this.state.cards).forEach((n) => {
                this.state.cards[n].stepIndex = 0
            })
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
                timeZone: LOCAL_TZ,
                month: 'short',
                day: 'numeric',
                year: 'numeric',
            })
        }
        return d.toLocaleString('en-US', {
            timeZone: LOCAL_TZ,
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

    // ── Availability: one boolean per run ──────────────────
    //
    // A run is either out or it isn't. One check per run: for fxx layers a
    // single fxx=0 probe (the anchor hour — if that exists the run exists), a
    // day-1 GetMap for WFPI, and assumed-present for layers we can't probe
    // (STAC etc.). A PRESENT verdict is cached under `name:base` (a published
    // run doesn't un-publish); a missing run is left uncached so it re-probes on
    // every trigger until it's out. Individual forecast hours are NOT
    // pre-checked — the per-hour "published edge" search this replaced kept
    // disabling hours veloserver demonstrably served — the data fetch itself is
    // the only per-step truth: a real failure disables the card (_failCard).
    //
    // We probe out-of-band against the SAME service the map renders through
    // (titiler /cog/info for COG, the gribjson file for velocity, a day-1 GetMap
    // for WFPI), NOT the Leaflet tiles: the tile pipeline deliberately swaps a
    // failed tile for a transparent PNG (anti-flicker _refreshTileUrl), so tile
    // events can't see failures. `Access-Control-Allow-Origin: *` on the
    // backends means a plain fetch reads the true status.

    // Keyed `name:base`. Values: 1 (present) or 'pending' (check in flight). A
    // missing run is not cached, so it re-probes on the next trigger.
    _edgeCache: {},

    // Pending "Loading…" debounce timers, keyed by layer name. See _scheduleLoading.
    _probeLoadingTimers: {},

    _probeAllAnchors: function () {
        if (!this._edgeCache) this._edgeCache = {}
        this._detectForecastLayers().forEach(({ name, config: fc }) => {
            const base = this._forecastBase(fc)
            const key = `${name}:${base}`
            const cached = this._edgeCache[key]

            // Only present runs are cached (a published run doesn't un-publish).
            // A missing run isn't cached, so it re-probes every trigger until it's out.
            if (cached === 1) {
                this._dbg('run (cache hit)', name, { key, present: true })
                this._applyRunPresent(name, true)
                return
            }
            // Probe already in flight; leave the current label, don't start another.
            if (cached === 'pending') return

            this._edgeCache[key] = 'pending'
            if (this.state.cards[name]?.cardState === 'unavailable') {
                // A "not generated" card debounces the flip to "Loading…" so a
                // fast re-check doesn't flash it. commit() cancels the timer.
                this._scheduleLoading(name)
            } else {
                // Fresh or valid card: show "Loading…" right away.
                this._setCardState(name, 'loading')
            }

            const baseAtFire = base
            const stillCurrent = () => this._forecastBase(fc) === baseAtFire

            // Commit the check's verdict — unless direct data evidence beat it
            // there. A step fetch that succeeded while the probe was in flight
            // proves the run exists; a slower, failed probe must not blank a
            // card the map is actively rendering data for.
            const commit = (ok) => {
                this._cancelLoading(name)
                const cs = this.state.cards[name]
                if (!ok && cs?.evidenceBase === baseAtFire) {
                    this._dbg('probe failed but data evidence wins', name, { key })
                    ok = true
                }
                if (ok) this._edgeCache[key] = 1
                else delete this._edgeCache[key] // don't cache a miss; re-probe next trigger
                this._dbg('run RESULT', name, { key, present: ok, applied: stillCurrent() })
                if (stillCurrent()) this._applyRunPresent(name, ok)
            }

            this._dbg('run RESOLVE', name, { key, base: new Date(base).toISOString() })
            this._resolveRunPresent(name, fc)
                .then(commit)
                .catch((e) => {
                    // A thrown probe is a network failure — the case the card
                    // exists to report. Treat as run-missing, not fail open.
                    this._dbg('run ERROR', name, e)
                    commit(false)
                })
        })
    },

    // Show "Loading…" after PROBE_LOADING_DELAY_MS unless the probe resolves
    // first (commit calls _cancelLoading). One timer per layer.
    _scheduleLoading: function (name) {
        if (!this._probeLoadingTimers) this._probeLoadingTimers = {}
        if (this._probeLoadingTimers[name]) return // already scheduled
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

    // Is this card's run out at all? fxx layers: does the anchor hour (fxx=0)
    // exist. WFPI/urlTemplate: day-1 GetMap (publication is atomic, so day 1
    // answers for every step). Unprobeable layers (STAC etc.): assume present.
    _resolveRunPresent: function (name, fc) {
        if (fc.urlTemplate) {
            return this._probeWmsTime(name, fc).then((v) => v === 'available')
        }
        const ld = L_.layers.data[name]
        if (!this._isFxxLayer(ld)) return Promise.resolve(true)
        return this._probeFxx(name, fc, 0)
    },

    // Shared fetch options for availability probes. The timeout bounds the
    // checking state and the background edge search on a hung network.
    _probeFetchOpts: function (extra) {
        const opts = { cache: 'no-store', ...extra }
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
            opts.signal = AbortSignal.timeout(20000)
        }
        return opts
    },

    // Turn the run check's verdict into card state. Not present → the card is
    // disabled: 'failed' when a real data fetch for this run failed
    // (_failCard), else 'unavailable' ("run not yet generated").
    _applyRunPresent: function (name, present) {
        const cs = this.state.cards[name]
        if (!cs) return
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
            // Re-apply the current step so the COG/tile refresh fires now that
            // the card is known-available (recovers a card the check had blanked).
            if (wasDisabled) this._reapplyAllSteps()
        }
    },

    // A step's data just loaded — direct proof this run exists. Recorded as
    // evidence so a slower failed probe of the same run can't blank the card
    // (see commit in _probeAllAnchors), and it clears any earlier fetch
    // failure.
    _markRunPresent: function (name, fc) {
        const cs = this.state.cards[name]
        if (!cs) return
        const base = this._forecastBase(fc)
        cs.evidenceBase = base
        cs.failedBase = null
        this._edgeCache[`${name}:${base}`] = 1
        if (cs.cardState !== 'available') this._applyRunPresent(name, true)
    },

    // A step fetch FAILED while its spinner was going: the run check said this
    // run exists, but the data didn't come back — the probe target and the
    // data service can be briefly desynced. Disable just this card with the
    // distinct "Forecast not available" message. Recovery paths: a new run
    // (new cache key → fresh check), a successful later fetch
    // (_markRunPresent), or toggling the layer off/on (the toggle patch
    // clears this layer's cached availability entirely).
    _failCard: function (name, fc) {
        const cs = this.state.cards[name]
        if (!cs) return
        const base = this._forecastBase(fc)
        cs.failedBase = base
        // Don't cache the miss; a briefly-desynced service usually recovers, so
        // let the next probe re-check and re-enable the card on its own.
        delete this._edgeCache[`${name}:${base}`]
        this._applyRunPresent(name, false)
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
            return fetch(info, this._probeFetchOpts())
                .then((r) => {
                    this._dbg('probe cog/info', name, 'fxx=' + n, r.status)
                    return r.ok
                })
                .catch(() => false)
        }

        if (this._isFxxVelocity(ld)) {
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

    _isFxxVelocity: function (ld) {
        return ld?.type === 'velocity' && this._isFxxLayer(ld)
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

    // The gribjson source URL for forecast hour `n`. {time} resolves to the
    // RUN this card is anchored to (_forecastBase) — the same anchor the COG
    // probe uses — never ld.time.end. That field can be empty at probe time or
    // hold a different instant than the run, and a probe aimed at the wrong
    // run reports "not generated" for a layer that is loading fine.
    _velocitySourceForFxx: function (ld, fc, n) {
        const url = ld?.url || ''
        const timeStr = new Date(this._forecastBase(fc)).toISOString()
        return this._setFxx(
            url
                .replace(/{time}/g, timeStr)
                .replace(/{endtime}/g, timeStr)
                .replace(/{starttime}/g, timeStr),
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
        return fetch(url, this._probeFetchOpts()).then((r) => {
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
    // play press first prefetches the run, filling the yellow progress bar
    // along the card's bottom edge.
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
        if (this._isFxxVelocity(ld)) {
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
        const isVelocity = this._isFxxVelocity(ld)
        const isCog =
            ld?.type === 'tile' &&
            (ld.url || '').toUpperCase().startsWith('COG:') &&
            this._isFxxLayer(ld)

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
                    btn.classList.toggle('ftl-prefetching', mode === 'loading')
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
        // Defense in depth: the button only renders for allowed layers, but
        // nothing else should be able to start playback either.
        if (!this._playbackAllowed(name)) return
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
    //   'loading'     — anchor probe in flight: ticks/buttons dark, "Checking
    //                   availability…" in init row. This is about the PROBE, not
    //                   the layer's own data load — the layer may already be
    //                   rendering. With anchor-first probing this window is one
    //                   request long, not the whole edge search.
    //   'unavailable' — probe says the run isn't generated: ticks/buttons dark,
    //                   "run not yet generated" warning in init row
    //   'failed'      — probe said the run exists but a step's data fetch
    //                   failed (services briefly desynced): same dark card,
    //                   "Forecast not available" warning instead
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
        // Nor keep a step spinner going — the card-level state supersedes it.
        if (disabled) this._clearTickLoading(name)
        ;[document.getElementById('ftl-strip')]
            .forEach((container) => {
                const card = container?.querySelector(`.ftl-card[data-layer="${_escSel(name)}"]`)
                if (!card) return

                // Card-level state classes drive the dark-button CSS
                card.classList.toggle('ftl-card-loading', state === 'loading')
                // 'failed' shares the unavailable visual treatment; only the
                // init-row message differs.
                card.classList.toggle(
                    'ftl-card-unavailable',
                    state === 'unavailable' || state === 'failed'
                )

                // Ticks: while loading they PULSE (skeleton) — dark
                // ftl-future-item is reserved for unavailable/failed, so a
                // slow model fetch doesn't read as "model not available".
                const cardIdx = this.state.cards[name]?.stepIndex ?? 0
                card.querySelectorAll('.ftl-tick').forEach((t, i) => {
                    t.classList.toggle('ftl-tick-skeleton', state === 'loading')
                    t.classList.toggle('ftl-future-item', disabled && state !== 'loading')
                    if (disabled) t.classList.remove('active')
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
                        '<span class="ftl-loading-inline">' +
                        '<i class="mdi mdi-loading mdi-spin"></i> Loading\u2026</span>'
                } else if (state === 'failed') {
                    if (captionEl) captionEl.style.display = 'none'
                    if (initEl) {
                        initEl.innerHTML =
                            '<i class="mdi mdi-alert" style="color:#e8a020;font-size:13px;vertical-align:middle"></i>' +
                            ' <span style="color:#e8a020;font-size:10px;text-transform:uppercase;letter-spacing:.04em">' +
                            'Forecast not available</span>'
                        initEl.setAttribute(
                            'title',
                            'The forecast data failed to load — the layer and forecast services may be briefly out of sync. Toggle the layer off and on to retry.'
                        )
                    }
                } else if (state === 'unavailable') {
                    if (captionEl) captionEl.style.display = 'none'
                    if (initEl) {
                        // Name the run that failed to probe — "not yet generated" on its
                        // own leaves the user guessing which cycle is missing. WFPI's
                        // runStr is already a date span, so "run" is dropped there to
                        // keep the line short enough to fit the init row.
                        const runStr = this._runLabel(fc)
                        const inlineMsg = this._isWfpi(fc)
                            ? `${runStr} not yet generated`
                            : `${runStr} run not yet generated`
                        initEl.innerHTML =
                            '<i class="mdi mdi-alert" style="color:#e8a020;font-size:13px;vertical-align:middle"></i>' +
                            ' <span style="color:#e8a020;font-size:10px;text-transform:uppercase;letter-spacing:.04em">' +
                            `${inlineMsg}</span>`
                        initEl.setAttribute(
                            'title',
                            this._isWfpi(fc)
                                ? `Model data for the ${runStr} window has not been generated yet.`
                                : `The ${runStr} model run has not been generated yet.`
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

        // Detach tile load hooks and clear any pending tick-spinner timers
        Object.keys(this._loadHooks || {}).forEach((n) =>
            this._detachLoadIndicator(n)
        )
        Object.values(this._tickSpinTimers || {}).forEach(clearTimeout)
        this._tickSpinTimers = {}
        Object.values(this._probeLoadingTimers || {}).forEach(clearTimeout)
        this._probeLoadingTimers = {}
        if (this._visitedSteps) this._visitedSteps.clear()

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

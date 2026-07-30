/**
 * Card UI. Layer detection, card records, strip and card DOM, handlers,
 * tooltip, tick painting, load indicators, and the TimeUI height layout.
 * Tick classes and the strip height formula are computed only in
 * _paintCardTicks and _stripExtraHeight.
 */

import L_ from '@basics/Layers_/Layers_'

import {
    escHtml,
    escSel,
    isMobile,
    isStacForecast,
    showWindow,
    pruneCacheInactive,
} from './common'
import { stepTime } from './time'

const cardMethods = {
    // ── Layer detection / card records ─────────────────────

    // Active = forecast-enabled and on, or optimistically on the moment its
    // toggle was requested (a velocity build is a full grib fetch; see patches).
    _detectForecastLayers: function () {
        const result = []
        for (const name in L_.layers.data) {
            const ld = L_.layers.data[name]
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

        // Sync state: prune removed, init new (new cards start 'loading').
        const activeNames = new Set(layers.map((l) => l.name))
        Object.keys(this.state.cards).forEach((n) => {
            if (!activeNames.has(n)) {
                delete this.state.cards[n]
                this._detachLoadIndicator(n)
            }
        })
        layers.forEach(({ name, config: fc }) => {
            if (!this.state.cards[name]) {
                this.state.cards[name] = { stepIndex: 0, collapsed: false, cardState: 'loading' }
                if (fc.urlTemplate) this._applyUrlTemplate(name, 1)
            }
        })

        const strip = document.getElementById('ftl-strip')
        if (strip) {
            strip.classList.toggle('ftl-mobile', isMobile())
            strip.innerHTML = this._buildStripHTML(layers)
            layers.forEach(({ name, config: fc }) => {
                this._attachCardHandlers(name, fc, strip)
                this._renderCardStep(name, fc, strip)
                this._attachLoadIndicator(name)
                const cs = this.state.cards[name]?.cardState
                if (cs && cs !== 'available') {
                    this._setCardState(name, cs)
                }
            })
            this._attachTabHandlers(strip)
        }
        this._adjustTimeUIHeight()

        pruneCacheInactive(this._edgeCache, activeNames)
        pruneCacheInactive(this._idxSweep, activeNames)
        this._probeAllAnchors()
    },

    _refreshAllCards: function () {
        const layers = this._detectForecastLayers()
        const strip = document.getElementById('ftl-strip')

        layers.forEach(({ name, config: fc }) => {
            if (strip) this._renderCardStep(name, fc, strip)
        })
    },

    // True when a card's rendered tick count no longer matches its effective
    // step count (an fxx run-length boundary, e.g. HRRR F18/F48), meaning
    // the tick DOM must rebuild.
    _stepCountsStale: function () {
        const container = document.getElementById('ftl-strip')
        if (!container) return false
        return this._detectForecastLayers().some(({ name, config: fc }) => {
            const card = container.querySelector(`.ftl-card[data-layer="${escSel(name)}"]`)
            if (!card) return false // collapsed cards are tabs; rebuild on expand
            return card.querySelectorAll('.ftl-tick').length !== this._effectiveSteps(fc, name)
        })
    },

    // ── Card HTML ──────────────────────────────────────────

    _buildCardHTML: function (name, fc) {
        const steps = this._effectiveSteps(fc, name)
        const unit = fc.stepUnit || 'hour'
        const label = fc.label || name
        const originBase = this._forecastBase(fc)
        const initStr = this._formatInit(originBase, unit, fc)

        // Info icon only when the layer configures a description.
        const infoBtnHTML = fc.description
            ? `<button class="ftl-card-info-btn" data-layer="${escHtml(name)}" type="button" aria-label="Forecast details"><i class="mdi mdi-information-outline"></i></button>`
            : ''

        const playBtnHTML = this._playbackAllowed(name)
            ? `<button class="ftl-card-play" data-layer="${escHtml(name)}" type="button" title="Play forecast animation" aria-label="Play forecast animation"><i class="mdi mdi-play"></i></button>`
            : ''

        // The retry button rides on every tick and only shows on a dark one
        // (see .ftl-tick-missing in the CSS), so painting never has to build DOM.
        const ticks = Array.from({ length: steps }, (_, i) => {
            const { clock, rel } = this._tickLabels(fc, i, originBase)
            return `<div class="ftl-tick mmgisTimeUIExpandedItem ftl-tick-twoline" data-layer="${escHtml(name)}" data-step="${i}"><span class="ftl-tick-clock">${clock}</span><span class="ftl-tick-rel">${rel}</span><button class="ftl-tick-retry" data-layer="${escHtml(name)}" data-step="${i}" type="button" tabindex="-1" title="Check for this hour again" aria-label="Check for this hour again"><i class="mdi mdi-refresh"></i></button></div>`
        }).join('')

        // Daily/monthly cards use fixed-width steps (see CSS) so a lone tick
        // doesn't stretch across the whole track.
        const dailyClass = (unit === 'day' || unit === 'month') ? ' ftl-card-daily' : ''

        const unitWord = unit === 'month' ? 'monthly' : unit === 'day' ? 'daily' : unit === 'week' ? 'weekly' : 'hourly'
        // Hourly chips label by max lead time so H0..H18 reads "18 hrs" not 19.
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
<div class="ftl-card${dailyClass}${collapsedAttr}" data-layer="${escHtml(name)}">
  <div class="ftl-card-header">
    <button class="ftl-card-collapse-btn" data-layer="${escHtml(name)}" title="${isCollapsed ? 'Expand' : 'Collapse'}">
      <i class="mdi ${isCollapsed ? 'mdi-window-restore' : 'mdi-window-minimize'} mdi-18px"></i>
    </button>
    <div class="ftl-card-hdr-left">
      <span class="ftl-card-forecast-title">FORECAST</span>
      <span class="ftl-card-forecast-chip">${forecastChipLabel}</span>
    </div>
    <div class="ftl-card-hdr-right">
      <div class="ftl-card-label-row">
        <span class="ftl-card-label">${escHtml(label)}</span>
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
    <button class="ftl-card-prev" data-layer="${escHtml(name)}"><i class="mdi mdi-chevron-left"></i></button>
    <div class="ftl-ticks-wrap mmgisTimeUIExpandedRowContainer">
      <div class="ftl-ticks">${ticks}</div>
    </div>
    <button class="ftl-card-next" data-layer="${escHtml(name)}"><i class="mdi mdi-chevron-right"></i></button>
  </div>
  <div class="ftl-card-prefetch" data-layer="${escHtml(name)}"><div class="ftl-card-prefetch-bar"></div></div>
</div>`
    },

    _buildStripHTML: function (layers) {
        if (layers.length === 0) return ''
        const collapsed = layers.filter(({ name }) => this.state.cards[name]?.collapsed)
        const expanded = layers.filter(({ name }) => !this.state.cards[name]?.collapsed)

        const tabsHTML = collapsed.length > 0
            ? `<div class="ftl-tabs-row">${collapsed.map(({ name, config: fc }) =>
                `<button class="ftl-tab" data-layer="${escHtml(name)}" title="Expand ${escHtml(fc.label || name)}">${escHtml(fc.label || name)}</button>`
              ).join('')}</div>`
            : ''

        const cardsHTML = expanded.map(({ name, config: fc }) =>
            this._buildCardHTML(name, fc)
        ).join('')

        return tabsHTML + cardsHTML
    },

    // ── Card event handlers ────────────────────────────────

    _attachCardHandlers: function (name, fc, container) {
        container.querySelectorAll(`.ftl-tick[data-layer="${escSel(name)}"]`).forEach((el) => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.step)
                // A dark hour has nothing to load; its retry button owns it.
                if (this._missingStep(name, fc, idx)) return
                this._setCardStep(name, fc, idx)
            })
        })
        // Retry one dark hour. Steps onto it when it turns out to be there now.
        container.querySelectorAll(`.ftl-tick-retry[data-layer="${escSel(name)}"]`).forEach((el) => {
            el.addEventListener('click', (e) => {
                // Don't let the tick behind it also handle the press.
                e.stopPropagation()
                const idx = parseInt(el.dataset.step)
                this._retryFxxStep(name, fc, idx).then((present) => {
                    if (present) this._setCardStep(name, fc, idx)
                })
            })
        })
        container.querySelector(`.ftl-card-collapse-btn[data-layer="${escSel(name)}"]`)
            ?.addEventListener('click', () => {
                this._toggleCardCollapsed(name)
            })
        // Prev/next skip steps with no data behind them, an empty STAC period
        // or an unpublished HRRR forecast hour. Where every step is eligible
        // this walks exactly one step.
        const stepBy = (dir) => {
            const cur = this.state.cards[name]?.stepIndex ?? 0
            const max = this._effectiveSteps(fc, name) - 1
            let idx = cur + dir
            while (idx >= 0 && idx <= max && this._missingStep(name, fc, idx))
                idx += dir
            if (idx < 0 || idx > max) return
            this._setCardStep(name, fc, idx)
        }
        container.querySelector(`.ftl-card-prev[data-layer="${escSel(name)}"]`)
            ?.addEventListener('click', () => stepBy(-1))
        container.querySelector(`.ftl-card-next[data-layer="${escSel(name)}"]`)
            ?.addEventListener('click', () => stepBy(1))
        const playBtn = container.querySelector(`.ftl-card-play[data-layer="${escSel(name)}"]`)
        if (playBtn) {
            playBtn.addEventListener('click', () => {
                this._togglePlay(name, fc)
            })
            // Hover-only tip; _bindTip also claims click, which would swallow
            // the play press.
            playBtn.classList.add('ftl-has-tip')
            playBtn.addEventListener('mouseenter', () =>
                this._showTip(playBtn, this._playTipHtml(name, fc))
            )
            playBtn.addEventListener('mouseleave', () => this._hideTip())
        }

        const wrap = container.querySelector(`.ftl-card[data-layer="${escSel(name)}"] .ftl-ticks-wrap`)
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

            // A plain vertical wheel scrolls the track horizontally, but only
            // when there's overflow, so the page still scrolls otherwise.
            wrap.addEventListener('wheel', (e) => {
                if (wrap.scrollWidth <= wrap.clientWidth) return
                const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
                if (delta === 0) return
                e.preventDefault()
                wrap.scrollLeft += delta
            }, { passive: false })
        }

        const infoBtn = container.querySelector(`.ftl-card-info-btn[data-layer="${escSel(name)}"]`)
        if (infoBtn && fc.description) {
            const label = fc.label || name
            this._bindTip(
                infoBtn,
                `<div class="ftl-tip-title">${escHtml(label)}</div>` +
                `<div class="ftl-tip-body">${escHtml(fc.description)}</div>`
            )
        }
    },

    _attachTabHandlers: function (container) {
        container.querySelectorAll('.ftl-tab').forEach((btn) => {
            btn.addEventListener('click', () => {
                this._toggleCardCollapsed(btn.dataset.layer)
            })
        })
    },

    _toggleCardCollapsed: function (name) {
        if (!this.state.cards[name]) return
        this.state.cards[name].collapsed = !this.state.cards[name].collapsed
        this._rebuildCards()
    },

    // ── Floating tooltip (shared #ftl-tooltip on <body>) ───

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
            // Tap-toggle without bubbling to the document-level dismiss.
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
        // Place above the anchor, flip below if tight, clamp to viewport.
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

    // ── Tick painting (the single implementation) ──────────
    // Tick classes + step-button disabling derived from card state. Used by
    // _renderCardStep AND _setCardState so they can never drift. STAC cards
    // stay navigable while unavailable; loading pulses (skeleton) while dark
    // is reserved for unavailable/failed; a step with no data is never active.
    _paintCardTicks: function (card, name, fc) {
        const state = this.state.cards[name]?.cardState ?? 'available'
        const disabled = state !== 'available'
        const loading = state === 'loading'
        // An uninitialized card is never navigable: there is no run to step
        // through at this hour.
        const navigable =
            disabled &&
            !loading &&
            state !== 'uninitialized' &&
            isStacForecast(L_.layers.data[name])
        const idx = this.state.cards[name]?.stepIndex ?? 0
        const steps = fc ? this._effectiveSteps(fc, name) : 1
        // The gate skips the presence sweep, so an uninitialized card would
        // otherwise wear the skeleton pulse forever.
        const presenceReady =
            state === 'uninitialized' || this._presenceReady(name, fc)

        // Card-level state classes assert on EVERY paint (state changes and
        // refreshes alike) so no repaint can leave a stale combination, e.g.
        // a leftover ftl-card-navigable brightening a disabled card's
        // buttons. 'failed' and 'uninitialized' share the unavailable look.
        card.classList.toggle('ftl-card-loading', loading)
        card.classList.toggle(
            'ftl-card-unavailable',
            state === 'unavailable' ||
                state === 'failed' ||
                state === 'uninitialized'
        )
        card.classList.toggle('ftl-card-navigable', navigable)

        card.querySelectorAll('.ftl-tick').forEach((el, i) => {
            const missing = this._missingStep(name, fc, i)
            // Only an fxx hour can be retried; a STAC period has no button.
            el.classList.toggle(
                'ftl-tick-missing',
                missing && this._fxxMissingStep(name, fc, i)
            )
            el.classList.toggle('ftl-tick-skeleton', loading || !presenceReady)
            el.classList.toggle(
                'ftl-future-item',
                (disabled && !loading && !navigable) || missing
            )
            el.classList.toggle(
                'active',
                (!disabled || navigable) &&
                    i === idx &&
                    !missing &&
                    presenceReady
            )
        })

        card.querySelector('.ftl-card-prev')?.toggleAttribute('disabled', (disabled && !navigable) || idx === 0)
        card.querySelector('.ftl-card-next')?.toggleAttribute('disabled', (disabled && !navigable) || idx === steps - 1)
        card.querySelector('.ftl-card-play')?.toggleAttribute('disabled', disabled || steps <= 1)

        return { state, disabled, loading, navigable, idx, steps }
    },

    _renderCardStep: function (name, fc, container) {
        const card = container?.querySelector(`.ftl-card[data-layer="${escSel(name)}"]`)
        this._dbg('renderCardStep', name, {
            cardFound: !!card,
            cardState: this.state.cards[name]?.cardState,
        })
        if (!card) return

        const steps = this._effectiveSteps(fc, name)
        // Clamp a stored step past the new max (F48 run rolled back to F18).
        const idx = this.state.cards[name]?.stepIndex ?? 0
        if (idx > steps - 1 && this.state.cards[name]) {
            this.state.cards[name].stepIndex = steps - 1
        }
        const unit = fc.stepUnit || 'hour'
        const originBase = this._forecastBase(fc)

        const { disabled } = this._paintCardTicks(card, name, fc)

        card.querySelectorAll('.ftl-tick').forEach((el, i) => {
            const { clock, rel } = this._tickLabels(fc, i, originBase)
            const clockEl = el.querySelector('.ftl-tick-clock')
            if (clockEl) clockEl.textContent = clock
            const relEl = el.querySelector('.ftl-tick-rel')
            if (relEl) relEl.textContent = rel
        })

        // The init line is managed by _setCardState while disabled.
        if (!disabled) {
            const initEl = card.querySelector('.ftl-card-init')
            if (initEl) initEl.textContent = this._formatInit(originBase, unit, fc)
        }

        // Keep the active tick in view (nudges the track, never the page).
        const activeEl = card.querySelector('.ftl-tick.active')
        const wrap = card.querySelector('.ftl-ticks-wrap')
        if (activeEl && wrap) {
            const a = activeEl.getBoundingClientRect()
            const w = wrap.getBoundingClientRect()
            if (a.left < w.left) wrap.scrollLeft -= w.left - a.left
            else if (a.right > w.right) wrap.scrollLeft += a.right - w.right
        }
    },

    // Card state:
    //   'loading'     probe in flight, ticks pulse, "Loading" in the init row
    //   'available'   normal interactive card
    //   'unavailable' run not published, dark card, "run not yet generated"
    //   'failed'      run probed present but data failed (brief service
    //                 desync), dark card, "Forecast not available"
    //   'uninitialized' the selected hour is not the model's declared init
    //                 hour (runHourUTC on an hourly card).
    //                 Renders exactly like 'unavailable' but names the
    //                 selected hour; no probes, not navigable
    _setCardState: function (name, state) {
        if (this.state.cards[name]) this.state.cards[name].cardState = state
        if (typeof window !== 'undefined' && window.FTL_DEBUG) {
            const strip = document.getElementById('ftl-strip')
            const found = !!strip?.querySelector(
                `.ftl-card[data-layer="${escSel(name)}"]`
            )
            this._dbg('setCardState', name, '->', state,
                found ? '(DOM card found)' : '(NO DOM CARD, visual NOT updated)',
                { hasStrip: !!strip })
        }
        const disabled = state !== 'available'
        // A disabled card must not keep animating or spinning.
        if (disabled && this._isPlaying(name)) this._stopPlay(name)
        if (disabled) this._clearTickLoading(name)

        const strip = document.getElementById('ftl-strip')
        const card = strip?.querySelector(`.ftl-card[data-layer="${escSel(name)}"]`)
        if (!card) return

        const fc = L_.layers.data[name]?.time?.forecast

        // Card-level classes (loading/unavailable/navigable) are asserted
        // inside _paintCardTicks with everything else state-derived.
        this._paintCardTicks(card, name, fc)

        // Init row text per state.
        const initEl = card.querySelector('.ftl-card-init')
        const captionEl = card.querySelector('.ftl-card-init-caption')
        if (state === 'loading') {
            if (captionEl) captionEl.style.display = 'none'
            initEl?.removeAttribute('title')
            if (initEl) initEl.innerHTML =
                '<span class="ftl-loading-inline">' +
                '<i class="mdi mdi-loading mdi-spin"></i> Loading…</span>'
        } else if (state === 'failed') {
            if (captionEl) captionEl.style.display = 'none'
            if (initEl) {
                initEl.innerHTML =
                    '<i class="mdi mdi-alert" style="color:#e8a020;font-size:13px;vertical-align:middle"></i>' +
                    ' <span style="color:#e8a020;font-size:10px;text-transform:uppercase;letter-spacing:.04em">' +
                    'Forecast not available</span>'
                initEl.setAttribute(
                    'title',
                    'The forecast data failed to load. The layer and forecast services may be briefly out of sync. Toggle the layer off and on to retry.'
                )
            }
        } else if (state === 'unavailable' || state === 'uninitialized') {
            if (captionEl) captionEl.style.display = 'none'
            if (initEl) {
                // Name the run so the user knows which cycle is missing.
                // Monthly names the ACTIVE tick's month (a stepped-to gap is
                // not the anchor month). showWindow spans already read as dates.
                // Uninitialized names the SELECTED hour, which has no run,
                // not the pinned anchor.
                let runStr = this._runLabel(fc)
                if (state === 'uninitialized') {
                    runStr = this._runLabel(fc, this._originBase())
                } else if (fc?.stepUnit === 'month') {
                    const stepIdx = this.state.cards[name]?.stepIndex ?? 0
                    runStr = new Date(
                        stepTime(fc, stepIdx, this._forecastBase(fc))
                    ).toLocaleDateString('en-US', {
                        timeZone: 'UTC',
                        month: 'short',
                        year: 'numeric',
                    })
                }
                const inlineMsg = showWindow(fc)
                    ? `${runStr} not yet generated`
                    : `${runStr} run not yet generated`
                initEl.innerHTML =
                    '<i class="mdi mdi-alert" style="color:#e8a020;font-size:13px;vertical-align:middle"></i>' +
                    ' <span style="color:#e8a020;font-size:10px;text-transform:uppercase;letter-spacing:.04em">' +
                    `${inlineMsg}</span>`
                initEl.setAttribute(
                    'title',
                    showWindow(fc)
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
    },

    // ── Tick spinners / load indicators ────────────────────

    // Corner spinner on the step whose data is in flight. Every 'on' carries
    // an auto-clear TTL because the COG refresh path has no completion event.
    _tickSpinTimers: {},

    _setTickLoading: function (name, idx, on, ttlMs) {
        const strip = document.getElementById('ftl-strip')
        if (!strip) return
        if (this._tickSpinTimers[name]) {
            clearTimeout(this._tickSpinTimers[name])
            delete this._tickSpinTimers[name]
        }
        strip
            .querySelectorAll(`.ftl-tick[data-layer="${escSel(name)}"]`)
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

    _clearTickLoading: function (name) {
        this._setTickLoading(name, -1, false)
    },

    // Hook Leaflet 'loading'/'load' once per built layer so the active tick
    // spins while tiles are in flight. Velocity instruments its own fetch.
    _attachLoadIndicator: function (name) {
        const leafletLayer = L_.layers.layer[name]
        if (!leafletLayer || typeof leafletLayer.on !== 'function') return
        if (!this._loadHooks) this._loadHooks = {}
        if (this._loadHooks[name]) return
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

    // ── DOM injection / layout ─────────────────────────────

    _waitAndInject: function () {
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
        if (isMobile()) strip.classList.add('ftl-mobile')
        expandedContent.prepend(strip)

        const timeUI = document.getElementById('timeUI')
        if (timeUI) {
            this._timeUIObserver = new MutationObserver(() => this._adjustTimeUIHeight())
            this._timeUIObserver.observe(timeUI, { attributes: true, attributeFilter: ['class'] })
        }
    },

    _observeTimeUIHeight: function () {
        const tryObserve = () => {
            const timeUIEl = document.getElementById('timeUI')
            if (!timeUIEl) {
                setTimeout(tryObserve, 500)
                return
            }
            // _adjustTimeUIHeight is idempotent, so the observer settles.
            this._heightObserver = new MutationObserver(() => this._adjustTimeUIHeight())
            this._heightObserver.observe(timeUIEl, {
                attributes: true,
                attributeFilter: ['class', 'style'],
            })
            this._adjustTimeUIHeight()
        }
        tryObserve()
    },

    // Extra vertical room the cards need, in px. The ONLY source both the
    // #timeUI growth and the bottom-element offset derive from. Card-count
    // based (not measured) so it stays stable through expand transitions.
    // 'defaultExpanded' counts as expanded, matching core's positioner.
    _stripExtraHeight: function () {
        const timeUI = document.getElementById('timeUI')
        if (!timeUI) return 0
        const isExpanded = timeUI.classList.contains('expanded') ||
            timeUI.classList.contains('defaultExpanded')
        const layers = this._detectForecastLayers()
        const cardCount = layers.length
        const collapsedCount = layers.filter(({ name }) => this.state.cards[name]?.collapsed).length
        const expandedCount = cardCount - collapsedCount
        const tabRowH = collapsedCount > 0 ? 28 : 0
        return (isExpanded && cardCount > 0) ? (expandedCount * 44 + tabRowH + 10) : 0
    },

    _adjustTimeUIHeight: function () {
        const timeUI = document.getElementById('timeUI')
        const expandedContent = document.getElementById('mmgisTimeUIExpandedContent')
        if (!timeUI || !expandedContent) return

        // Mobile: one capped vertical scroll area instead of desktop height math.
        if (isMobile()) {
            timeUI.style.height = ''
            expandedContent.style.height = ''
            expandedContent.style.maxHeight = '52vh'
            expandedContent.style.overflowY = 'auto'
            expandedContent.style.overflowX = 'hidden'
            expandedContent.style.webkitOverflowScrolling = 'touch'
            document.documentElement.style.setProperty('--ftl-extra-bottom', '0px')
            return
        }
        const extraH = this._stripExtraHeight()
        if (extraH > 0) {
            // Bases: #timeUI expanded 177px, #mmgisTimeUIExpandedContent 137px.
            timeUI.style.height = (177 + extraH) + 'px'
            expandedContent.style.height = (137 + extraH) + 'px'
            expandedContent.style.overflow = 'visible'
        } else {
            timeUI.style.height = ''
            expandedContent.style.height = ''
            expandedContent.style.overflow = ''
        }
        this._repositionBottomElements()
    },

    // Core positions bottom elements off a hardcoded dock height; publish our
    // extra height as a CSS var the stylesheet adds as margin-bottom.
    _repositionBottomElements: function () {
        if (!document.getElementById('timeUI')) return
        document.documentElement.style.setProperty(
            '--ftl-extra-bottom',
            this._stripExtraHeight() + 'px'
        )
    },
}

export default cardMethods

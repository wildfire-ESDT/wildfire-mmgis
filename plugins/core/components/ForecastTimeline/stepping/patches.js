/**
 * Core patches. The plugin never edits core source; it wraps core methods
 * at runtime through the registry below, and cleanup restores them.
 *
 *   TimeUI._populateExpandedRows        grey and block future items in the rows
 *   TimeUI._loopTime                    stop play/next passing the current hour
 *   TimeControl.applyTimeParams         narrow a layer's window to the step
 *                                        (forecastType.timeWindow)
 *   LayerTypeRegistry.get('tile').map
 *     .timeChange                       same, before the tile type's own
 *                                        (TimeControl.applyTimeParams-bypassing)
 *                                        main-timeline refresh
 *   L_.toggleLayer                      show the card the instant a toggle starts
 *   L.TileLayer.ColorFilter
 *     .prototype.getTileUrl             let the forecastType rewrite tile requests
 *                                        (forecastType.buildTileUrl)
 */

import TimeControl from '@basics/TimeControl_/TimeControl'
import TimeUI from '@basics/TimeControl_/TimeUI'
import L_ from '@basics/Layers_/Layers_'
import LayerTypeRegistry from '@basics/Layers_/registry/LayerTypeRegistry'

import { invalidateCacheLayer } from '../shared/common'
import { stepTime } from '../shared/timeMath'

const patchMethods = {
    // ── The registry ───────────────────────────────────────

    // Wrap target[method]. `wrap` receives the original (bound to target) and
    // returns the replacement. No-op if missing or already patched.
    _installPatch: function (target, method, wrap) {
        const original = target?.[method]
        if (typeof original !== 'function') return false
        if (!this._patches) this._patches = []
        if (this._patches.some((p) => p.target === target && p.method === method))
            return false
        this._patches.push({ target, method, original })
        target[method] = wrap(original.bind(target))
        return true
    },

    _removeAllPatches: function () {
        ;(this._patches || []).forEach(({ target, method, original }) => {
            target[method] = original
        })
        this._patches = []
        document.getElementById('ftl-future-style')?.remove()
    },

    // ── Grey + block future items in the expanded rows ─────

    _patchPopulateExpandedRows: function () {
        const self = this
        const installed = this._installPatch(
            TimeUI,
            '_populateExpandedRows',
            (orig) =>
                function () {
                    orig()
                    self._markFutureExpandedItems()
                }
        )
        // Core may have populated before this plugin loaded; mark what's there.
        if (installed) this._markFutureExpandedItems()
    },

    // CSS mirror of the future-item marking, keyed on data attributes that
    // pre-exist the row DOM, so rebuilt items can never paint bright for a
    // frame before the class pass runs.
    _syncFutureCSS: function (nowYear, nowMonth, nowDay, nowHour, shownYear, shownMonth, shownDay) {
        let styleEl = document.getElementById('ftl-future-style')
        if (!styleEl) {
            styleEl = document.createElement('style')
            styleEl.id = 'ftl-future-style'
            document.head.appendChild(styleEl)
        }
        const sels = []
        // Years (guard two decades ahead).
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

    // Mark future year/month/day/hour items after each populate. Reads the
    // shown end through local accessors so it matches what the user sees.
    _markFutureExpandedItems: function () {
        const now = new Date()
        const nowYear = now.getFullYear()
        const nowMonth = now.getMonth() // 0-indexed
        const nowDay = now.getDate()
        const nowHour = now.getHours()

        const endDate = new Date(TimeUI._endTimestamp)
        const shownYear = endDate.getFullYear()
        const shownMonth = endDate.getMonth() // 0-indexed
        const shownDay = endDate.getDate()

        // Refresh the attribute-selector rules first (see _syncFutureCSS).
        this._syncFutureCSS(nowYear, nowMonth, nowDay, nowHour, shownYear, shownMonth, shownDay)

        document.querySelectorAll('#mmgisTimeUIYearsContainer .mmgisTimeUIExpandedItem').forEach((el) => {
            const yr = parseInt(el.getAttribute('data-year'))
            el.classList.toggle('ftl-future-item', yr > nowYear)
        })

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

    // ── Clamp navigation to wall-clock now ─────────────────

    _patchTimeUINavigation: function () {
        const self = this
        this._installPatch(TimeUI, '_loopTime', (orig) =>
            function (loopBackwards) {
                orig(loopBackwards)
                // Snap back to the current hour floor if the step went past now.
                const now = new Date()
                const nowHourFloor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0).getTime()
                const cur = TimeUI.getCurrentTimestamp
                    ? TimeUI.removeOffset(TimeUI.getCurrentTimestamp())
                    : 0
                if (cur > nowHourFloor) {
                    TimeUI.updateTimes?.(null, nowHourFloor, nowHourFloor)
                    if (TimeUI.play) TimeUI.togglePlay?.(false)
                }
                self._updateNextButtonState()
            }
        )
    },

    _updateNextButtonState: function () {
        const now = new Date()
        const nowHourFloor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0).getTime()
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

    // ── Time window hook ───────────────────────────────────

    // The [start, end] the forecast type wants this layer to request right now.
    _timeWindowFor: function (ld, requestedEnd) {
        const fc = ld?.time?.forecast
        if (fc?.enabled !== true || !ld.name) return null
        const forecastType = this._forecastTypeFor(ld.name)
        if (!forecastType?.timeWindow) return null
        const step = this.state.cards[ld.name]?.stepIndex ?? 0
        const run = this._forecastBase(fc)
        return (
            forecastType.timeWindow(
                this._forecastTypeCall(ld.name, fc, {
                    step,
                    stepTime: stepTime(fc, step, run),
                    steps: this._effectiveSteps(fc, ld.name),
                    requestedEnd,
                })
            ) || null
        )
    },

    // Narrow a live layer's Leaflet options.
    _applyTimeWindow: function (ld) {
        const l = L_.layers.layer[ld?.name]
        if (!l) return
        const window_ = this._timeWindowFor(ld, l.options?.endtime)
        if (!window_) return
        l.options.starttime = window_[0]
        l.options.endtime = window_[1]
    },

    // Narrow ld.time itself before the tile type rebuilds from it. Returns a
    // restore(), or null when there's nothing to narrow.
    _narrowTimeBeforeRebuild: function (ld) {
        const window_ = this._timeWindowFor(ld, ld?.time?.end)
        if (!window_) return null
        const prevStart = ld.time.start
        const prevEnd = ld.time.end
        ld.time.start = window_[0]
        ld.time.end = window_[1]
        return () => {
            ld.time.start = prevStart
            ld.time.end = prevEnd
        }
    },

    _patchSetLayerWmsParams: function () {
        const self = this
        const installed = this._installPatch(
            TimeControl,
            'applyTimeParams',
            (orig) =>
                function (layer) {
                    orig(layer)
                    self._applyTimeWindow(layer)
                }
        )
        if (installed) {
            for (const name in L_.layers.data) {
                this._applyTimeWindow(L_.layers.data[name])
            }
        }
    },

    // The tile type takes its time window as live request params, so a
    // main-timeline change never touches TimeControl.applyTimeParams:
    // reloadLayer dispatches straight to the type's own map.timeChange
    // (Tile/map.js), which calls the raw applyTimeParams it imported
    // directly and refreshes the layer itself. That raw call reads the
    // open epoch start with no pin, so _patchSetLayerWmsParams above never
    // sees this path. LayerTypeRegistry.get('tile') returns one cached
    // module object, and wrapping its .map.timeChange here is what
    // LayerInterface.run actually looks up on every dispatch.
    _patchTileTimeChange: function () {
        const self = this
        const tileMap = LayerTypeRegistry.get('tile')?.map
        this._installPatch(tileMap, 'timeChange', (orig) =>
            function (layerObj, ctx) {
                // timeChange's own body reads layerObj.time and issues the
                // refresh itself before returning; pinning AFTER orig() is
                // too late, the un-pinned tiles are already requested.
                const restore = self._narrowTimeBeforeRebuild(layerObj)
                try {
                    return orig(layerObj, ctx)
                } finally {
                    if (restore) restore()
                }
            }
        )
    },

    // ── Tile URL hook ──────────────────────────────────────
    // A rebuilt layer is a new Leaflet instance, so a forecast type's per-request
    // rewrite goes where every tile request is built: the tile layer class's
    // getTileUrl.
    _patchTileUrl: function () {
        const tileLayerPrototype = window.L?.TileLayer?.ColorFilter?.prototype
        const originalGetTileUrl = tileLayerPrototype?.getTileUrl
        if (typeof originalGetTileUrl !== 'function') return
        if (!this._patches) this._patches = []
        if (this._patches.some((p) => p.target === tileLayerPrototype && p.method === 'getTileUrl'))
            return
        // Not _installPatch: a prototype method must run with the tile layer
        // instance as `this`, not bound to the prototype.
        this._patches.push({ target: tileLayerPrototype, method: 'getTileUrl', original: originalGetTileUrl })
        const self = this
        tileLayerPrototype.getTileUrl = function (coords) {
            const url = originalGetTileUrl.call(this, coords)
            return self._tileUrlFor(this, url) || url
        }
    },

    _tileUrlFor: function (tileLayer, url) {
        // Remembered once found; not while missing, since a layer's first
        // tiles can be requested before core registers it.
        if (tileLayer._forecastLayerName == null) {
            const layerName = Object.keys(L_.layers.layer).find(
                (name) => L_.layers.layer[name] === tileLayer
            )
            if (layerName == null) return null
            tileLayer._forecastLayerName = layerName
        }
        const name = tileLayer._forecastLayerName
        const fc = L_.layers.data[name]?.time?.forecast
        if (fc?.enabled !== true) return null
        const forecastType = this._forecastTypeFor(name)
        if (!forecastType?.buildTileUrl) return null
        const step = this.state.cards[name]?.stepIndex ?? 0
        const run = this._forecastBase(fc)
        return forecastType.buildTileUrl(
            this._forecastTypeCall(name, fc, { step, stepTime: stepTime(fc, step, run), url })
        )
    },

    // ── Optimistic card on toggle ──────────────────────────
    // Core notifies toggle subscribers only AFTER the layer builds; a velocity
    // build is a full grib fetch, so the card would lag. Show/remove it the
    // instant a toggle is requested; the real subscription reconciles later.
    _patchToggleLayer: function () {
        const self = this
        this._installPatch(L_, 'toggleLayer', (orig) =>
            function (s, ...rest) {
                if (s && s.time?.forecast?.enabled === true) {
                    const name = s.name
                    // reloadLayer refreshes velocity by toggling off/on
                    // synchronously; a pair in one tick is that reload, keep
                    // the card. A lone toggle is a real user on/off.
                    self._toggleTick[name] = (self._toggleTick[name] || 0) + 1
                    if (self._toggleTick[name] === 1) {
                        Promise.resolve().then(() => {
                            delete self._toggleTick[name]
                        })
                    }
                    if (self._toggleTick[name] >= 2) {
                        self._optimisticOn.add(name)
                    } else if (L_.layers.on[name] === true) {
                        self._optimisticOn.delete(name)
                    } else {
                        self._optimisticOn.add(name)
                        // A fresh toggle-on is a natural retry.
                        invalidateCacheLayer(self._presence, name)
                        self._freshProbe.add(name)
                    }
                    self._rebuildCards()
                    // Before the toggle adds the pre-built layer, so the first
                    // tile requests already carry the narrowed window.
                    self._applyTimeWindow(s)
                }
                return orig(s, ...rest)
            }
        )
    },
}

export default patchMethods

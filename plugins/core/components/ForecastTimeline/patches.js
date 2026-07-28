/**
 * Core patches. The plugin never edits core source; it wraps four core
 * methods at runtime through the registry below, and cleanup restores them.
 *
 *   TimeUI._populateExpandedRows   grey and block future items in the rows
 *   TimeUI._loopTime               stop play/next passing the current hour
 *   TimeControl.setLayerWmsParams  re-apply STAC instant pinning (steps.js)
 *   L_.toggleLayer                 show the card the instant a toggle starts
 */

import TimeControl from '@basics/TimeControl_/TimeControl'
import TimeUI from '@basics/TimeControl_/TimeUI'
import L_ from '@basics/Layers_/Layers_'

import { invalidateCacheLayer } from './common'

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

    // ── STAC instant pinning hook ──────────────────────────

    _patchSetLayerWmsParams: function () {
        const self = this
        const installed = this._installPatch(
            TimeControl,
            'setLayerWmsParams',
            (orig) =>
                function (layer) {
                    orig(layer)
                    self._pinStacInstant(layer)
                }
        )
        // Pre-built tile layers may still carry the open epoch start; pin now.
        if (installed) {
            for (const name in L_.layers.data) {
                this._pinStacInstant(L_.layers.data[name])
            }
        }
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
                        // A fresh toggle-on is a natural retry: drop cached
                        // misses so the availability check runs again.
                        invalidateCacheLayer(self._edgeCache, name)
                        invalidateCacheLayer(self._stacStepMiss, name)
                    }
                    self._rebuildCards()
                    // Pin BEFORE the toggle adds the pre-built layer so the
                    // first tile requests already carry the pinned instant.
                    self._pinStacInstant(s)
                }
                return orig(s, ...rest)
            }
        )
    },
}

export default patchMethods

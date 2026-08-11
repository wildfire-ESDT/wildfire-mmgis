/**
 * Time math and label formatting. Run anchoring, step-unit math and every
 * label the cards render.
 *
 * Anchoring: steps generate from the timeline's selected time floored to the
 * hour, never the wall clock. Daily products anchor to the latest UTC run at
 * or before the selected time (runHourUTC). Anchoring by local calendar date
 * instead pointed at the previous run for hours after a new run was out (a
 * viewer-timezone boundary bug). Labels format real instants through the
 * browser timezone, so hours stay correct across DST and other timezones.
 */

import TimeControl from '@basics/TimeControl_/TimeControl'
import L_ from '@basics/Layers_/Layers_'

import {
    STEP_UNITS,
    LOCAL_TZ,
    FXX_MAX_DEFAULT,
    FXX_MAX_EXTENDED_DEFAULT,
    EXTENDED_RUN_HOURS_UTC_DEFAULT,
    hasInitHour,
    isFxxLayer,
    showWindow,
} from './common'

// ── Pure unit math ─────────────────────────────────────────

// Add N calendar months to a UTC timestamp, anchored to the 1st.
export function addMonths(ms, n) {
    const d = new Date(ms)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)
}

// The instant step i (plus the config's stepOffset) lands on, from a base.
// A missing stepOffset degrades to 0, never to NaN labels/requests.
export function stepTime(fc, i, baseMs) {
    const offset = fc.stepOffset || 0
    return fc.stepUnit === 'month'
        ? addMonths(baseMs, i + offset)
        : baseMs + (i + offset) * (STEP_UNITS[fc.stepUnit] || STEP_UNITS.hour)
}

// [start, end) of the unit-aligned period (UTC month/day/hour) containing ms.
export function periodBounds(unit, ms) {
    if (unit === 'month') {
        const d = new Date(ms)
        return [
            Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
            Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
        ]
    }
    const unitMs = STEP_UNITS[unit] || STEP_UNITS.hour
    const start = Math.floor(ms / unitMs) * unitMs
    return [start, start + unitMs]
}

// ── Shared locale option objects ───────────────────────────

const DATE_SHORT = { timeZone: LOCAL_TZ, month: 'short', day: 'numeric' }
const DATE_NUMERIC = { timeZone: LOCAL_TZ, month: 'numeric', day: 'numeric' }
const TIME_HOUR = { timeZone: LOCAL_TZ, hour: 'numeric', hour12: true }
const DATE_UTC_SHORT = { timeZone: 'UTC', month: 'short', day: 'numeric' }

// The one valid-window formatter (real instants, so hours stay DST-correct).
//   'tick'  → { clock: "7/21–7/22", rel: "5PM–5PM" }
//   'init'  → "Jul 21 5 PM – Jul 22 5 PM PDT"
//   'dates' → "Jul 21 – Jul 28"
export function windowLabel(startMs, endMs, style) {
    const s = new Date(startMs)
    const e = new Date(endMs)
    if (style === 'tick') {
        const t = (d) =>
            d.toLocaleTimeString('en-US', TIME_HOUR).replace(' ', '')
        return {
            clock: `${s.toLocaleDateString('en-US', DATE_NUMERIC)}–${e.toLocaleDateString('en-US', DATE_NUMERIC)}`,
            rel: `${t(s)}–${t(e)}`,
        }
    }
    if (style === 'init') {
        const start = `${s.toLocaleDateString('en-US', DATE_SHORT)} ${s.toLocaleTimeString('en-US', TIME_HOUR)}`
        const end = `${e.toLocaleDateString('en-US', DATE_SHORT)} ${e.toLocaleTimeString('en-US', { ...TIME_HOUR, timeZoneName: 'short' })}`
        return `${start} – ${end}`
    }
    // 'dates'
    return `${s.toLocaleDateString('en-US', DATE_SHORT)} – ${e.toLocaleDateString('en-US', DATE_SHORT)}`
}

// ── Mixin: methods that read plugin/timeline state ─────────

const timeMethods = {
    // Selected-time base floored to the hour. Anchored to the TIMELINE's time,
    // never the wall clock, so probes and steps target the run the layers load.
    _originBase: function () {
        let t = NaN
        if (TimeControl.currentTime) t = new Date(TimeControl.currentTime).getTime()
        if (isNaN(t)) t = this.state.originMs || Date.now()
        const d = new Date(t)
        d.setMinutes(0, 0, 0)
        return d.getTime()
    },

    // The instant a forecast's steps are generated from. Daily products anchor
    // to the latest UTC run (runHourUTC) at or before the selected time (see
    // the header above). Hourly products anchor to the selected hour, except
    // an init-hour card pins to that day's init instant so its labels, caches
    // and probes don't drift with the timeline; _initHourMismatch gates the
    // other hours.
    _forecastBase: function (fc) {
        const base = this._originBase()
        const unit = fc?.stepUnit || 'hour'
        if (unit === 'month') {
            const d = new Date(base)
            return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
        }
        if (unit !== 'day')
            return hasInitHour(fc) ? this._initHourInstant(fc) : base
        const runHourUTC = Number.isFinite(fc.runHourUTC) ? fc.runHourUTC : 0
        const d = new Date(base)
        const runToday = Date.UTC(
            d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
            runHourUTC, 0, 0, 0
        )
        return runToday <= base ? runToday : runToday - STEP_UNITS.day
    },

    // The instant of an hourly model's configured init hour (runHourUTC) on
    // the selected day.
    _initHourInstant: function (fc) {
        const d = new Date(this._originBase())
        return Date.UTC(
            d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
            Number.isFinite(fc?.runHourUTC) ? fc.runHourUTC : 0
        )
    },

    // True when an init-hour card's selected hour is not the init hour. Such
    // a card renders "Model not initialized" and never touches its layer.
    _initHourMismatch: function (fc) {
        if (!hasInitHour(fc)) return false
        return this._initHourInstant(fc) !== this._originBase()
    },

    // Step count. fxx layers derive theirs from the run's UTC init hour and
    // the model's run schedule (config overrides, defaults in common.js);
    // others use configured fc.steps.
    _effectiveSteps: function (fc, name) {
        const ld = name ? L_.layers.data[name] : null
        if (!isFxxLayer(ld)) return fc.steps || 1
        const initHourUTC = new Date(this._originBase()).getUTCHours()
        const extendedHours = Array.isArray(fc.extendedRunHoursUTC)
            ? fc.extendedRunHoursUTC
            : EXTENDED_RUN_HOURS_UTC_DEFAULT
        const isExtendedRun = extendedHours.includes(initHourUTC)
        return (
            (isExtendedRun
                ? fc.fxxMaxExtended ?? FXX_MAX_EXTENDED_DEFAULT
                : fc.fxxMax ?? FXX_MAX_DEFAULT) + 1
        )
    },

    // Step chip label. Config stepLabel wins, else derived from stepSize/unit.
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

    // Compact run identity for the "not yet generated" warning. Daily is
    // UTC-dated to match the run fetched; showWindow cards show their span.
    // atMs overrides the anchor (uninitialized cards name the selected hour).
    _runLabel: function (fc, atMs) {
        const base = atMs != null ? atMs : this._forecastBase(fc || {})
        const unit = fc?.stepUnit || 'hour'
        if (unit === 'month') {
            return new Date(base).toLocaleDateString('en-US', {
                timeZone: 'UTC',
                month: 'short',
                year: 'numeric',
            })
        }
        if (unit === 'day') {
            if (showWindow(fc)) {
                return windowLabel(
                    base,
                    base + (fc.steps || 7) * STEP_UNITS.day,
                    'dates'
                )
            }
            return new Date(base).toLocaleDateString('en-US', DATE_UTC_SHORT)
        }
        return new Date(base).toLocaleString('en-US', {
            timeZone: LOCAL_TZ,
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            hour12: true,
        })
    },

    // INITIALIZED row. Monthly and showWindow cards show their whole valid
    // span; daily is UTC-dated; hourly shows the local instant.
    _formatInit: function (ms, unit, fc) {
        const d = new Date(ms)
        if (unit === 'month') {
            return windowLabel(ms, addMonths(ms, fc?.steps || 1), 'init')
        }
        if (unit === 'day') {
            if (showWindow(fc)) {
                return windowLabel(ms, ms + (fc.steps || 7) * STEP_UNITS.day, 'init')
            }
            return d.toLocaleDateString('en-US', {
                timeZone: 'UTC',
                month: 'short',
                day: 'numeric',
                year: 'numeric',
            })
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

    // Two-line tick label, shared by build and refresh so they always agree.
    // Hourly "7/29 - 9 AM"/"h1", daily "May 13"/"+N", monthly and showWindow cards
    // full windows.
    _tickLabels: function (fc, i, originBase) {
        const unit = fc.stepUnit || 'hour'

        if (unit === 'month') {
            return windowLabel(
                stepTime(fc, i, originBase),
                stepTime(fc, i + 1, originBase),
                'tick'
            )
        }

        const stepMs = stepTime(fc, i, originBase)

        if (unit === 'day') {
            if (showWindow(fc)) {
                return windowLabel(stepMs, stepMs + STEP_UNITS.day, 'tick')
            }
            return {
                clock: new Date(stepMs).toLocaleString('en-US', DATE_UTC_SHORT),
                rel: `+${i + (fc.stepOffset || 0)}`,
            }
        }

        const stepDate = new Date(stepMs)
        return {
            clock: `${stepDate.toLocaleDateString('en-US', DATE_NUMERIC)} - ${stepDate.toLocaleTimeString('en-US', TIME_HOUR)}`,
            rel: `h${i + (fc.stepOffset || 0)}`,
        }
    },
}

export default timeMethods

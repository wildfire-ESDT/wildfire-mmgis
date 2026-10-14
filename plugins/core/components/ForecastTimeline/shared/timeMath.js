/**
 * Time math and labels. Pure: imports nothing from core, so forecast types and
 * unit tests can use it.
 *
 * Steps generate from the timeline's selected time floored to the hour, never
 * the wall clock. Daily products anchor to the latest UTC run at or before the
 * selected time (runHourUTC). Labels format real instants through the browser
 * timezone, so hours stay correct across DST.
 */

import { STEP_UNITS, LOCAL_TZ, hasInitHour, showWindow } from './common'

export function addMonths(ms, n) {
    const d = new Date(ms)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)
}

// The instant step i (plus stepOffset) lands on, from a base.
export function stepTime(fc, i, baseMs) {
    const offset = fc.stepOffset || 0
    return fc.stepUnit === 'month'
        ? addMonths(baseMs, i + offset)
        : baseMs + (i + offset) * (STEP_UNITS[fc.stepUnit] || STEP_UNITS.hour)
}

// [start, end) of the unit-aligned UTC period containing ms.
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

// The instant of an hourly model's init hour (runHourUTC) on the selected day.
export function initHourInstant(fc, originMs) {
    const d = new Date(originMs)
    return Date.UTC(
        d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
        Number.isFinite(fc?.runHourUTC) ? fc.runHourUTC : 0
    )
}

// True when an init-hour card's selected hour is not the init hour.
export function initHourMismatch(fc, originMs) {
    if (!hasInitHour(fc)) return false
    return initHourInstant(fc, originMs) !== originMs
}

// The run a forecast's steps generate from, given the selected hour.
export function forecastBase(fc, originMs) {
    const unit = fc?.stepUnit || 'hour'
    if (unit === 'month') {
        const d = new Date(originMs)
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    }
    if (unit !== 'day')
        return hasInitHour(fc) ? initHourInstant(fc, originMs) : originMs
    const runHourUTC = Number.isFinite(fc.runHourUTC) ? fc.runHourUTC : 0
    const d = new Date(originMs)
    const runToday = Date.UTC(
        d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
        runHourUTC, 0, 0, 0
    )
    return runToday <= originMs ? runToday : runToday - STEP_UNITS.day
}

const DATE_SHORT = { timeZone: LOCAL_TZ, month: 'short', day: 'numeric' }
const DATE_NUMERIC = { timeZone: LOCAL_TZ, month: 'numeric', day: 'numeric' }
const TIME_HOUR = { timeZone: LOCAL_TZ, hour: 'numeric', hour12: true }
const DATE_UTC_SHORT = { timeZone: 'UTC', month: 'short', day: 'numeric' }

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
    return `${s.toLocaleDateString('en-US', DATE_SHORT)} – ${e.toLocaleDateString('en-US', DATE_SHORT)}`
}

// Methods mixed into the plugin. Everything here derives from this._originBase() (ForecastTimeline.js).
const timeMathMethods = {
    _forecastBase: function (fc) {
        return forecastBase(fc, this._originBase())
    },

    _initHourInstant: function (fc) {
        return initHourInstant(fc, this._originBase())
    },

    _initHourMismatch: function (fc) {
        return initHourMismatch(fc, this._originBase())
    },

    // Compact run identity for the "not yet generated" warning. atMs overrides
    // the anchor (uninitialized cards name the selected hour).
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

    // INITIALIZED row text.
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

    // Two-line tick label, shared by build and refresh.
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

export default timeMathMethods

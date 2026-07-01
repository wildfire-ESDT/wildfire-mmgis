/**
 * LocalTimezone - display the Time UI in the viewer's browser-local timezone
 *
 * TimeUI.js is UTC-only. This component, when enabled in a mission config
 * (components: [{ name: "LocalTimezone", js: "LocalTimezone", on: true }]),
 * overrides the handful of timezone-conversion methods on the TimeUI
 * singleton with browser-local-relative versions, then re-renders the
 * already-built TimeUI so the same absolute instants are shown in local
 * (e.g. PDT) wall-clock instead of UTC.
 *
 * Like other components, init() runs after fina() (after TimeUI has rendered),
 * so it captures the true instants first (via the still-UTC removeOffset),
 * swaps the conversion methods, and re-seats the display via updateTimes().
 * The absolute times sent to layers are unchanged - only the reference frame
 * the picker/timeline present (and that a wall-clock selection maps to) changes.
 *
 * Monkey-patching core singletons from a component follows the same pattern as
 * ForecastTimeline (which patches TimeControl.reloadTimeLayers). Every override
 * references the TimeUI singleton directly (not `this`), so assigning them onto
 * TimeUI is safe.
 */
import TimeUI from '@basics/TimeControl_/TimeUI'
import TimeControl from '@basics/TimeControl_/TimeControl'
import $ from 'jquery'
import * as moment from 'moment'

const LocalTimezone = {
    _applied: false,

    init: function () {
        if (LocalTimezone._applied) return
        // TimeUI only exists when the Time control is enabled for the mission.
        if (!TimeControl.enabled) return

        // Capture the true (absolute) instants BEFORE swapping the conversion,
        // using the current (UTC) removeOffset. removeOffset always yields the
        // canonical instant (it is what TimeUI.change() emits), so this is
        // correct regardless of what the raw _*Timestamp fields hold.
        const hasTimes =
            TimeUI._startTimestamp != null && TimeUI._endTimestamp != null
        let trueEnd, trueCurrent
        if (hasTimes) {
            trueEnd = TimeUI.removeOffset(TimeUI._endTimestamp)
            trueCurrent = TimeUI.removeOffset(TimeUI.getCurrentTimestamp())
        }

        LocalTimezone._applyOverrides()
        LocalTimezone._applied = true

        // Lock the Time UI to Point mode only: force Point and remove the
        // Range/Point selector so Point is the sole choice.
        const pointIdx = TimeUI.modes.indexOf('Point')
        if (TimeUI.modeIndex !== pointIdx) {
            TimeUI.changeMode(pointIdx)
        }
        $('#mmgisTimeUIMode').css('display', 'none')

        // Re-seat the already-rendered UI so it displays those same instants in
        // the browser-local frame (identity offsets now in effect). Point mode
        // has no start handle, so only the end/current time is re-seated.
        if (hasTimes) {
            TimeUI.updateTimes(null, trueEnd, trueCurrent)
            TimeUI._remakeTimeSlider()
            if (TimeUI.expanded) TimeUI._populateExpandedRows()
        }
    },

    _applyOverrides: function () {
        TimeUI._utcToDisplay = function (utcMs) {
            const d = new Date(utcMs)
            return {
                year: d.getFullYear(), month: d.getMonth(), day: d.getDate(),
                hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds()
            }
        }

        TimeUI._displayToUtc = function (year, month, day, hour, minute, second) {
            return new Date(year, month, day, hour, minute, second).getTime()
        }

        TimeUI.addOffset = function (timestamp) {
            return new Date(timestamp)
        }

        TimeUI.removeOffset = function (timestamp) {
            return new Date(new Date(timestamp).getTime())
        }

        TimeUI._calculateRangePositions = function (containerType) {
            // Use display-tz fields for range positions
            const _sDisp = TimeUI._utcToDisplay(TimeUI._startTimestamp)
            const _eDisp = TimeUI._utcToDisplay(TimeUI._endTimestamp)
            // Wrap in moment using UTC so .year()/.month()/.date()/.hour() return display-tz digits
            const startTime = moment.utc(Date.UTC(_sDisp.year, _sDisp.month, _sDisp.day, _sDisp.hour, _sDisp.minute, _sDisp.second))
            const endTime = moment.utc(Date.UTC(_eDisp.year, _eDisp.month, _eDisp.day, _eDisp.hour, _eDisp.minute, _eDisp.second))

            const mode = TimeUI.modes[TimeUI.modeIndex]

            let startPercent = 0
            let endPercent = 100

            let startPeriod = null
            let endPeriod = null

            if (containerType === 'years') {
                // Calculate fractional range for years row (last 20 years)
                const currentYear = moment().year()
                const firstVisibleYear = currentYear - 19
                const totalYears = 20

                // Calculate fractional position within the year (in local time)
                const startYearBegin = moment.utc([startTime.year(), 0, 1])
                const startYearEnd = moment.utc([startTime.year() + 1, 0, 1])
                const startYearFraction =
                    (startTime.valueOf() - startYearBegin.valueOf()) /
                    (startYearEnd.valueOf() - startYearBegin.valueOf())

                const endYearBegin = moment.utc([endTime.year(), 0, 1])
                const endYearEnd = moment.utc([endTime.year() + 1, 0, 1])
                const endYearFraction =
                    (endTime.valueOf() - endYearBegin.valueOf()) /
                    (endYearEnd.valueOf() - endYearBegin.valueOf())

                // Calculate position as percentage of visible years
                startPercent =
                    ((startTime.year() - firstVisibleYear + startYearFraction) /
                        totalYears) *
                    100
                endPercent =
                    ((endTime.year() - firstVisibleYear + endYearFraction) /
                        totalYears) *
                    100
                startPeriod = moment(TimeUI._startTimestamp).year()
                endPeriod = moment(TimeUI._endTimestamp).year()
            } else if (containerType === 'months') {
                // Calculate fractional range for months row (12 months)
                const selectedYear = _eDisp.year
                const totalMonths = 12

                // Calculate start position
                if (startTime.year() === selectedYear) {
                    const startMonthBegin = moment.utc([
                        selectedYear,
                        startTime.month(),
                        1,
                    ])
                    // Handle December (month 11) + 1 = month 12 which rolls to next year
                    const startMonthEnd =
                        startTime.month() === 11
                            ? moment.utc([selectedYear + 1, 0, 1])
                            : moment.utc([selectedYear, startTime.month() + 1, 1])
                    const startMonthFraction =
                        (startTime.valueOf() - startMonthBegin.valueOf()) /
                        (startMonthEnd.valueOf() - startMonthBegin.valueOf())
                    startPercent =
                        ((startTime.month() + startMonthFraction) / totalMonths) *
                        100
                    startPeriod = startTime.month()
                } else if (startTime.year() < selectedYear) {
                    startPercent = 0
                    startPeriod = 0
                } else {
                    startPercent = 100
                    startPeriod = 11
                }

                // Calculate end position
                if (endTime.year() === selectedYear) {
                    const endMonthBegin = moment.utc([
                        selectedYear,
                        endTime.month(),
                        1,
                    ])
                    // Handle December (month 11) + 1 = month 12 which rolls to next year
                    const endMonthEnd =
                        endTime.month() === 11
                            ? moment.utc([selectedYear + 1, 0, 1])
                            : moment.utc([selectedYear, endTime.month() + 1, 1])
                    const endMonthFraction =
                        (endTime.valueOf() - endMonthBegin.valueOf()) /
                        (endMonthEnd.valueOf() - endMonthBegin.valueOf())
                    endPercent =
                        ((endTime.month() + endMonthFraction) / totalMonths) * 100
                    endPeriod = endTime.month()
                } else if (endTime.year() > selectedYear) {
                    endPercent = 100
                    endPeriod = 11
                } else {
                    endPercent = 0
                    endPeriod = 0
                }
            } else if (containerType === 'days') {
                // Calculate fractional range for days row
                const selectedYear = moment
                    .utc(moment(TimeUI.removeOffset(TimeUI._endTimestamp)))
                    .year()
                const selectedMonth = moment
                    .utc(moment(TimeUI.removeOffset(TimeUI._endTimestamp)))
                    .month()
                const daysInMonth = moment
                    .utc(moment(TimeUI.removeOffset(TimeUI._endTimestamp)))
                    .daysInMonth()

                // Calculate start position
                if (
                    startTime.year() === selectedYear &&
                    startTime.month() === selectedMonth
                ) {
                    const startDayBegin = moment
                        .utc([selectedYear, selectedMonth, startTime.date()])
                        .startOf('day')
                    const startDayEnd = moment
                        .utc([selectedYear, selectedMonth, startTime.date()])
                        .endOf('day')

                    const startDayFraction =
                        (startTime.valueOf() - startDayBegin.valueOf()) /
                        (startDayEnd.valueOf() - startDayBegin.valueOf())
                    startPercent =
                        ((startTime.date() - 1 + startDayFraction) / daysInMonth) *
                        100
                    startPeriod = startTime.date()
                } else if (
                    startTime.isBefore(moment([selectedYear, selectedMonth, 1]))
                ) {
                    startPercent = 0
                    startPeriod = 0
                } else {
                    startPercent = 100
                    endPeriod = 0
                }

                // Calculate end position
                if (
                    endTime.year() === selectedYear &&
                    endTime.month() === selectedMonth
                ) {
                    const endDayBegin = moment
                        .utc([selectedYear, selectedMonth, endTime.date()])
                        .startOf('day')
                    const endDayEnd = moment
                        .utc([selectedYear, selectedMonth, endTime.date()])
                        .endOf('day')
                    const endDayFraction =
                        (endTime.valueOf() - endDayBegin.valueOf()) /
                        (endDayEnd.valueOf() - endDayBegin.valueOf())
                    endPercent =
                        ((endTime.date() - 1 + endDayFraction) / daysInMonth) * 100
                    endPeriod = endTime.date()
                } else if (
                    endTime.isAfter(
                        moment([selectedYear, selectedMonth, daysInMonth]).endOf(
                            'day'
                        )
                    )
                ) {
                    endPercent = 100
                    endPeriod = daysInMonth
                } else {
                    endPercent = 0
                }
            } else if (containerType === 'hours') {
                // Calculate fractional range for hours row (24 hours)
                const selectedYear = _eDisp.year
                const selectedMonth = _eDisp.month
                const selectedDay = _eDisp.day
                const totalHours = 24

                // Calculate start position
                if (
                    startTime.year() === selectedYear &&
                    startTime.month() === selectedMonth &&
                    startTime.date() === selectedDay
                ) {
                    const startHourFraction = startTime.minute() / 60 + startTime.second() / 3600
                    startPercent = ((startTime.hour() + startHourFraction) / totalHours) * 100
                    startPeriod = startTime.hour()
                } else if (
                    startTime.isBefore(
                        moment([selectedYear, selectedMonth, selectedDay])
                    )
                ) {
                    startPercent = 0
                    startPeriod = 0
                } else {
                    startPercent = 100
                    startPeriod = totalHours
                }

                // Calculate end position
                if (
                    endTime.year() === selectedYear &&
                    endTime.month() === selectedMonth &&
                    endTime.date() === selectedDay
                ) {
                    const endHourFraction = endTime.minute() / 60 + endTime.second() / 3600
                    endPercent = ((endTime.hour() + endHourFraction) / totalHours) * 100
                    endPeriod = endTime.hour()
                } else if (
                    endTime.isAfter(
                        moment([
                            selectedYear,
                            selectedMonth,
                            selectedDay,
                            23,
                        ]).endOf('hour')
                    )
                ) {
                    endPercent = 100
                    endPeriod = totalHours
                } else {
                    endPercent = 0
                    endPeriod = 0
                }
            }

            // Clamp to visible range
            startPercent = Math.max(0, Math.min(100, startPercent))
            endPercent = Math.max(0, Math.min(100, endPercent))

            let widthPercent = endPercent - startPercent

            // In Point mode, show narrow indicator (minimum 2% width)
            if (mode === 'Point') {
                widthPercent = Math.max(2, widthPercent)
            }

            return {
                left: startPercent,
                width: widthPercent,
                startPeriod,
                endPeriod,
            }
        }

        TimeUI._populateYearsRow = function () {
            const container = $('#mmgisTimeUIYearsContainer')
            const rangeIndicator = $('#mmgisTimeUIYearsRange').detach()
            container.empty()
            container.append(rangeIndicator)

            // Get last 20 years
            const currentYear = moment().year()
            const startYear = currentYear - 19

            const selectedYear = TimeUI._utcToDisplay(TimeUI._endTimestamp).year

            for (let year = startYear; year <= currentYear; year++) {
                const yearButton = $('<div>')
                    .addClass('mmgisTimeUIExpandedItem')
                    .text(year)
                    .attr('data-year', year)

                // Highlight if this is the selected year
                if (year === selectedYear) {
                    yearButton.addClass('selected')
                }

                // Add click handler
                yearButton.on('click', function () {
                    TimeUI._selectYear(year)
                })

                container.append(yearButton)
            }
        }

        TimeUI._populateMonthsRow = function () {
            const container = $('#mmgisTimeUIMonthsContainer')
            const rangeIndicator = $('#mmgisTimeUIMonthsRange').detach()
            container.empty()
            container.append(rangeIndicator)

            // Get 12 months
            const months = moment.months()

            const selectedMonth = TimeUI._utcToDisplay(TimeUI._endTimestamp).month

            for (let i = 0; i < months.length; i++) {
                const monthButton = $('<div>')
                    .addClass('mmgisTimeUIExpandedItem')
                    .text(months[i])
                    .attr('data-month', i)

                // Highlight if this is the selected month
                if (i === selectedMonth) {
                    monthButton.addClass('selected')
                }

                // Add click handler
                monthButton.on('click', function () {
                    TimeUI._selectMonth(i)
                })

                container.append(monthButton)
            }
        }

        TimeUI._populateDaysRow = function () {
            const container = $('#mmgisTimeUIDaysContainer')
            const rangeIndicator = $('#mmgisTimeUIDaysRange').detach()
            container.empty()
            container.append(rangeIndicator)

            const _dispEnd = TimeUI._utcToDisplay(TimeUI._endTimestamp)
            const daysInMonth = new Date(_dispEnd.year, _dispEnd.month + 1, 0).getDate()
            const selectedDay = _dispEnd.day

            for (let day = 1; day <= daysInMonth; day++) {
                const dayButton = $('<div>')
                    .addClass('mmgisTimeUIExpandedItem')
                    .text(day)
                    .attr('data-day', day)

                // Highlight if this is the selected day
                if (day === selectedDay) {
                    dayButton.addClass('selected')
                }

                // Add click handler
                dayButton.on('click', function () {
                    TimeUI._selectDay(day)
                })

                container.append(dayButton)
            }
        }

        TimeUI._populateHoursRow = function () {
            const container = $('#mmgisTimeUIHoursContainer')
            const rangeIndicator = $('#mmgisTimeUIHoursRange').detach()
            container.empty()
            container.append(rangeIndicator)

            const selectedHour = TimeUI._utcToDisplay(TimeUI._endTimestamp).hour

            // Generate 24 hours in 12-hour format with AM/PM
            for (let hour = 0; hour < 24; hour++) {
                // Convert to 12-hour format
                const hour12 = hour % 12 === 0 ? 12 : hour % 12
                const ampm = hour < 12 ? 'AM' : 'PM'
                const hourText = `${hour12} ${ampm}`

                const hourButton = $('<div>')
                    .addClass('mmgisTimeUIExpandedItem')
                    .text(hourText)
                    .attr('data-hour', hour)

                // Highlight if this is the selected hour
                if (hour === selectedHour) {
                    hourButton.addClass('selected')
                }

                // Add click handler
                hourButton.on('click', function () {
                    TimeUI._selectHour(hour)
                })

                container.append(hourButton)
            }
        }

        TimeUI._selectMonth = function (monthIndex) {
            const selectedYear = TimeUI._utcToDisplay(TimeUI._endTimestamp).year
            const startOfMonth = TimeUI._displayToUtc(selectedYear, monthIndex, 1, 0, 0, 0)
            const lastDay = new Date(selectedYear, monthIndex + 1, 0).getDate()
            const endOfMonth = TimeUI._displayToUtc(selectedYear, monthIndex, lastDay, 23, 59, 59)

            TimeUI.updateTimes(startOfMonth, endOfMonth, endOfMonth)

            // Pan the timeline to show the selected extent
            TimeUI.fitWindowToTime()

            // Refresh the expanded rows to update selection
            TimeUI._populateExpandedRows()
        }

        TimeUI._selectDay = function (day) {
            const _disp = TimeUI._utcToDisplay(TimeUI._endTimestamp)
            const startOfDay = TimeUI._displayToUtc(_disp.year, _disp.month, day, 0, 0, 0)
            const endOfDay = TimeUI._displayToUtc(_disp.year, _disp.month, day, 23, 59, 59)

            TimeUI.updateTimes(startOfDay, endOfDay, endOfDay)

            // Pan the timeline to show the selected extent
            TimeUI.fitWindowToTime()

            // Refresh the expanded rows to update selection
            TimeUI._populateExpandedRows()
        }

        TimeUI._selectHour = function (hour) {
            const _disp = TimeUI._utcToDisplay(TimeUI._endTimestamp)
            const startOfHour = TimeUI._displayToUtc(_disp.year, _disp.month, _disp.day, hour, 0, 0)
            const endOfHour = TimeUI._displayToUtc(_disp.year, _disp.month, _disp.day, hour, 59, 59)


            TimeUI.updateTimes(startOfHour, endOfHour, startOfHour)

            // Pan the timeline to show the selected extent
            TimeUI.fitWindowToTime()

            // Refresh the expanded rows to update selection
            TimeUI._populateExpandedRows()
        }

    },
}

export default LocalTimezone

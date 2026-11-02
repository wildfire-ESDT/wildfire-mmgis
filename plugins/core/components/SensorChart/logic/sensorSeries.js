// Chart time math kept free of Chart.js and React so it can be unit tested.

export const ONE_HOUR = 3600000
const TICK_STEPS_IN_HOURS = [1, 2, 3, 6, 12, 24, 48, 96, 168]
const PIXELS_BETWEEN_MARKS = 8
const PIXELS_BETWEEN_LABELS = 60
const PICK_DISTANCE = 24
const DRAG_DISTANCE = 4

// The chart's three lines. Observed readings run up to the selected hour, the
// hours not reported yet left empty; the forecast starts at the last observed
// reading at or before its run so the two lines meet; grey bridges cover every
// empty stretch.
export function buildSeries(sensor, unitKey, run, observedTime) {
    const runTime = run ? Date.parse(run) : Infinity
    const toPoints = (readings) => readings.map((reading) => ({ x: Date.parse(reading.time), y: reading[unitKey] ?? null }))
    const observed = toPoints(sensor.observed)
    for (let time = (observed.at(-1)?.x ?? observedTime) + ONE_HOUR; time <= observedTime; time += ONE_HOUR)
        observed.push({ x: time, y: null, notReportedYet: true })
    const observedAtRun = observed.filter((point) => point.x <= runTime && point.y != null).pop()
    const joinPoint = observedAtRun && { ...observedAtRun, joinsObserved: true }
    const forecast = run ? [joinPoint, ...toPoints(sensor.forecasts?.[run] ?? [])].filter(Boolean) : []
    return { observed, forecast, missing: bridgeMissingHours(observed) }
}

// 36 hours ending a day after the run, or at the latest data without one.
export function initialViewRange(runTime, lastTime) {
    const viewEnd = Number.isFinite(runTime) ? runTime + 24 * ONE_HOUR : lastTime
    return { min: viewEnd - 36 * ONE_HOUR, max: viewEnd }
}

// The range, same width, slid to bring a time back on screen; null when it is
// already showing.
export function rangeShowing(time, view, firstTime, lastTime) {
    if (time >= view.min && time <= view.max) return null
    const width = view.max - view.min
    const min = Math.max(firstTime, Math.min(time - width / 2, lastTime - width))
    return { min, max: min + width }
}

// The reading nearest a click, within reach. A press that moved is a drag and
// picks nothing; the join point and empty hours are never picked.
export function pickedPoint(candidates, click, pressedAt) {
    if (pressedAt && click.clientX != null) {
        const moved = Math.hypot(click.clientX - pressedAt.x, click.clientY - pressedAt.y)
        if (moved > DRAG_DISTANCE) return null
    }
    let nearest = null
    for (const { x, y, point, label } of candidates) {
        if (point?.y == null || point.joinsObserved) continue
        const distance = Math.hypot(x - click.x, y - click.y)
        if (distance <= PICK_DISTANCE && (nearest == null || distance < nearest.distance))
            nearest = { distance, time: point.x, label }
    }
    return nearest
}

// The span the chart may zoom over. A sensor with no observed readings yet
// starts at the timeline's hour rather than at NaN.
export function chartTimeRange(sensor, run, observedTime) {
    const firstObservedTime = Date.parse(sensor.observed[0]?.time)
    const firstTime = Number.isFinite(firstObservedTime) ? firstObservedTime : observedTime
    const lastTime = Math.max(
        firstTime,
        Date.parse(sensor.observed.at(-1)?.time) || 0,
        Date.parse(sensor.forecasts?.[run]?.at(-1)?.time) || 0,
        observedTime || 0
    )
    return { firstTime, lastTime }
}

// Hour ticks that fit the zoom, on local hour boundaries. Each tick reads its
// own UTC offset, so a range across a daylight saving change stays aligned.
export function placeHourTicks(axis) {
    const width = axis.chart.chartArea?.width ?? axis.chart.width
    const hoursShown = (axis.max - axis.min) / ONE_HOUR
    const stepThatFits = (pixelsApart, divisibleBy = 1) =>
        TICK_STEPS_IN_HOURS.find((hours) => hoursShown / hours <= width / pixelsApart && hours % divisibleBy === 0) ??
        TICK_STEPS_IN_HOURS.at(-1)
    const markStep = stepThatFits(PIXELS_BETWEEN_MARKS)
    const labelStep = stepThatFits(PIXELS_BETWEEN_LABELS, markStep)
    const firstLocalHour =
        Math.ceil((axis.min - utcOffsetAt(axis.min)) / ONE_HOUR) * ONE_HOUR + utcOffsetAt(axis.min)
    axis.ticks = []
    for (let time = firstLocalHour; time <= axis.max; time += ONE_HOUR) {
        const localHour = localHoursSinceEpoch(time)
        if (localHour % markStep === 0) axis.ticks.push({ value: time, major: localHour % labelStep === 0 })
    }
}

function utcOffsetAt(time) {
    return new Date(time).getTimezoneOffset() * 60000
}

function localHoursSinceEpoch(time) {
    return Math.round((time - utcOffsetAt(time)) / ONE_HOUR)
}

// Grey dashed stand-ins for hours with no reading, interpolated between the
// readings either side, each run broken off from the next with a null point.
export function bridgeMissingHours(points) {
    const bridges = []
    let gapStart = null
    points.forEach((point, index) => {
        if (point.y == null) gapStart ??= index
        else if (gapStart != null) {
            bridges.push(...bridgeGap(points, gapStart, index))
            gapStart = null
        }
    })
    if (gapStart != null) bridges.push(...bridgeGap(points, gapStart, points.length))
    return bridges
}

function bridgeGap(points, gapStart, gapEnd) {
    const before = points[gapStart - 1]
    const after = points[gapEnd]
    const startValue = before?.y ?? after?.y
    const endValue = after?.y ?? before?.y
    if (startValue == null) return []
    const gapLength = gapEnd - gapStart + 1
    const missing = points.slice(gapStart, gapEnd).map((point, offset) => ({
        x: point.x,
        y: startValue + ((endValue - startValue) * (offset + 1)) / gapLength,
        missing: true,
        notReportedYet: point.notReportedYet,
    }))
    const lineBreak = { x: (after ?? missing.at(-1)).x, y: null }
    return [before, ...missing, after, lineBreak].filter(Boolean)
}

import React, { useEffect, useMemo, useRef } from 'react'
import { Chart, registerables } from 'chart.js'
import { Line } from 'react-chartjs-2'
import zoomPlugin from 'chartjs-plugin-zoom'
import styles from './SensorChart.module.css'

Chart.register(...registerables)

const ONE_HOUR = 3600000
const TICK_STEPS_IN_HOURS = [1, 2, 3, 6, 12, 24, 48, 96, 168]
const PIXELS_BETWEEN_MARKS = 8
const PIXELS_BETWEEN_LABELS = 60
export const OBSERVED_COLOR = '#4a9eff'
export const FORECAST_COLOR = '#ffdd5c'
const MISSING_COLOR = '#9e9e9e'
const MISSING = 'Unavailable'
const HOURLY_POINTS_RANGE = 48 * ONE_HOUR
const TEXT = { color: 'rgba(255, 255, 255, 0.6)', font: { family: 'roboto', size: 11 } }

const chartOptions = (firstTime, lastTime) => ({
    animation: false,
    maintainAspectRatio: false,
    parsing: false,
    normalized: true,
    layout: { padding: { top: 8, right: 28 } },
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    scales: {
        x: {
            type: 'linear',
            grid: {
                drawBorder: false,
                tickLength: 4,
                color: ({ tick }) => (tick?.major ? 'rgba(255, 255, 255, 0.05)' : 'transparent'),
                tickColor: ({ tick }) => (tick?.major ? 'rgba(255, 255, 255, 0.35)' : 'rgba(255, 255, 255, 0.15)'),
            },
            afterBuildTicks: placeHourTicks,
            ticks: {
                ...TEXT,
                autoSkip: false,
                maxRotation: 0,
                callback: formatTick,
                color: ({ tick }) => (isMidnight(tick?.value) ? 'rgba(255, 255, 255, 0.9)' : TEXT.color),
                font: ({ tick }) => ({ ...TEXT.font, weight: isMidnight(tick?.value) ? '600' : 'normal' }),
            },
        },
        y: {
            beginAtZero: true,
            grace: '10%',
            grid: { color: 'rgba(255, 255, 255, 0.06)', drawBorder: false },
            ticks: { ...TEXT, maxTicksLimit: 5, padding: 6 },
        },
    },
    plugins: {
        legend: { display: false },
        tooltip: {
            backgroundColor: 'rgba(18, 18, 18, 0.95)',
            borderColor: 'rgba(255, 255, 255, 0.1)',
            borderWidth: 1,
            padding: 8,
            titleFont: { family: 'roboto', size: 11, weight: 'normal' },
            bodyFont: { family: 'roboto', size: 12 },
            usePointStyle: true,
            boxWidth: 6,
            boxHeight: 6,
            filter: (item) => !item.raw.joinsObserved && (item.dataset.label !== MISSING || item.raw.missing),
            callbacks: {
                title: (items) => formatTime(items[0].parsed.x),
                label: (item) => (item.raw.missing ? ' Sensor unavailable' : ` ${item.dataset.label}  ${item.formattedValue}`),
            },
        },
        zoom: {
            limits: { x: { min: firstTime, max: lastTime, minRange: 6 * ONE_HOUR } },
            zoom: { wheel: { enabled: true, modifierKey: 'ctrl', speed: 0.07 }, pinch: { enabled: true }, mode: 'x' },
            pan: { enabled: true, mode: 'x' },
        },
    },
})

const timeMarkers = {
    id: 'timeMarkers',
    afterDatasetsDraw(chart) {
        const { left, right, top, bottom } = chart.chartArea
        const context = chart.ctx
        const inView = (x) => x >= left && x <= right
        context.save()
        for (const { time, color, dashed } of chart.timeMarkers || []) {
            const x = chart.scales.x.getPixelForValue(time)
            if (!inView(x)) continue
            context.strokeStyle = color
            context.setLineDash(dashed ? [3, 3] : [])
            context.beginPath()
            context.moveTo(x, top)
            context.lineTo(x, bottom)
            context.stroke()
        }
        context.setLineDash([])
        context.strokeStyle = '#ffffff'
        context.lineWidth = 2
        for (const point of chart.selectedPoints || []) {
            const x = chart.scales.x.getPixelForValue(point.x)
            if (!inView(x)) continue
            context.fillStyle = point.color
            context.beginPath()
            context.arc(x, chart.scales.y.getPixelForValue(point.y), 5, 0, 2 * Math.PI)
            context.fill()
            context.stroke()
        }
        context.restore()
    },
}
const CHART_PLUGINS = [zoomPlugin, timeMarkers]

export default function SensorTimeSeries({ sensor, unit, run, selectedTime, observedTime }) {
    const chartRef = useRef(null)
    const runTime = run ? Date.parse(run) : Infinity
    const firstTime = Date.parse(sensor.observed[0]?.time)
    const lastTime = Math.max(Date.parse(sensor.observed.at(-1)?.time), Date.parse(sensor.forecasts[run]?.at(-1)?.time) || 0)
    const options = useMemo(() => chartOptions(firstTime, lastTime), [firstTime, lastTime])

    const data = useMemo(() => {
        const toPoints = (readings) => readings.map((reading) => ({ x: Date.parse(reading.time), y: reading[unit] }))
        const observed = toPoints(sensor.observed)
        const observedAtRun = observed.filter((point) => point.x <= runTime && point.y != null).pop()
        const joinPoint = observedAtRun && { ...observedAtRun, joinsObserved: true }
        const forecast = run ? [joinPoint, ...toPoints(sensor.forecasts[run])].filter(Boolean) : []
                return {
            datasets: [
                toLine('Observed', observed, OBSERVED_COLOR),
                toLine('Forecast', forecast, FORECAST_COLOR),
                { ...toLine(MISSING, bridgeMissingHours(observed), MISSING_COLOR), borderDash: [2, 3], borderWidth: 1.5, pointRadius: 0 },
            ],
        }
    }, [sensor, unit, run, runTime])

    useEffect(() => {
        const chart = chartRef.current
        const viewEnd = runTime === Infinity ? lastTime : runTime + 24 * ONE_HOUR
        chart.zoomScale('x', { min: viewEnd - 36 * ONE_HOUR, max: viewEnd }, 'none')

        const panWithWheel = (event) => {
            if (event.ctrlKey) return
            event.preventDefault()
            chart.pan({ x: -(event.deltaX || event.deltaY) }, undefined, 'none')
        }
        chart.canvas.addEventListener('wheel', panWithWheel, { passive: false })
        return () => chart.canvas.removeEventListener('wheel', panWithWheel)
    }, [runTime, lastTime])

    useEffect(() => {
        const [observed, forecast] = data.datasets
        chartRef.current.timeMarkers = [
            run && { time: runTime, color: 'rgba(255, 255, 255, 0.35)' },
            { time: selectedTime, color: 'rgba(255, 255, 255, 0.6)', dashed: true },
        ].filter(Boolean)
        const pointAt = (line, time) => ({ ...line.data.find((point) => point.x === time), color: line.borderColor })
        chartRef.current.selectedPoints = [
            pointAt(observed, observedTime),
            selectedTime > runTime && pointAt(forecast, selectedTime),
        ].filter((point) => point?.y != null)
        chartRef.current.draw()
    }, [data, run, runTime, selectedTime, observedTime])

    return (
        <>
            <div className={styles.chart}>
                <Line ref={chartRef} data={data} options={options} plugins={CHART_PLUGINS} />
            </div>
        </>
    )
}

function bridgeMissingHours(points) {
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
    }))
    const lineBreak = { x: (after ?? missing.at(-1)).x, y: null }
    return [before, ...missing, after, lineBreak].filter(Boolean)
}

function toLine(label, points, color) {
    return {
        label,
        data: points,
        borderColor: color,
        backgroundColor: (context) => fadingFill(context.chart, color),
        pointBackgroundColor: color,
        fill: 'origin',
        borderWidth: 2,
        pointRadius: showHourlyPoints,
        pointBorderWidth: 0,
        pointHoverRadius: 4,
        tension: 0.3,
    }
}

function showHourlyPoints({ chart }) {
    const { min, max } = chart.scales.x
    return max - min <= HOURLY_POINTS_RANGE ? 2 : 0
}

function fadingFill(chart, color) {
    const { chartArea } = chart
    if (!chartArea) return `${color}20`
    const gradient = chart.ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
    gradient.addColorStop(0, `${color}30`)
    gradient.addColorStop(1, `${color}00`)
    return gradient
}

function placeHourTicks(axis) {
    const width = axis.chart.chartArea?.width ?? axis.chart.width
    const hoursShown = (axis.max - axis.min) / ONE_HOUR
    const stepThatFits = (pixelsApart, divisibleBy = 1) =>
        TICK_STEPS_IN_HOURS.find((hours) => hoursShown / hours <= width / pixelsApart && hours % divisibleBy === 0) ??
        TICK_STEPS_IN_HOURS.at(-1)
    const markStep = stepThatFits(PIXELS_BETWEEN_MARKS)
    const labelStep = stepThatFits(PIXELS_BETWEEN_LABELS, markStep)
    const timezoneOffset = new Date(axis.min).getTimezoneOffset() * 60000
    const localHour = (time) => Math.round((time - timezoneOffset) / ONE_HOUR)
    const firstMark = Math.ceil((axis.min - timezoneOffset) / (markStep * ONE_HOUR)) * markStep * ONE_HOUR + timezoneOffset
    axis.ticks = []
    for (let time = firstMark; time <= axis.max; time += markStep * ONE_HOUR)
        axis.ticks.push({ value: time, major: localHour(time) % labelStep === 0 })
}

function formatTick(value, index, ticks) {
    if (!ticks[index].major) return ''
    const date = new Date(value)
    if (isMidnight(value)) return date.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' })
    return date.toLocaleTimeString([], { hour: 'numeric' })
}

function isMidnight(time) {
    return time != null && new Date(time).getHours() === 0
}

export function formatTime(time) {
    const date = new Date(time)
    return `${date.getMonth() + 1}/${date.getDate()} - ${date.toLocaleTimeString([], { hour: 'numeric' })}`
}

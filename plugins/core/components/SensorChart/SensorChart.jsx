import React from 'react'
import { createRoot } from 'react-dom/client'
import L_ from '@basics/Layers_/Layers_'
import Map_ from '@basics/Map_/Map_'
import TimeControl from '@basics/TimeControl_/TimeControl'
import SensorChartPanel from './SensorChartPanel'
import { readingAt, runAt, aqiColor, toHour } from './sensorReadings'

const SELECTED_STROKE = { color: '#ffffff', weight: 3, opacity: 1 }
const SELECTED_RADIUS_GROWTH = 2

const sensorMarkers = new Set()
const baseStrokes = new Map()
const baseRadii = new Map()
let root = null
let selectedMarkers = []
let lastSensorClick = null
let timelineTime = null
let forecastStep = null
let timeUIObserver = null

const SensorChart = {
    init: function () {
        root = createRoot(document.body.appendChild(document.createElement('div')))
        window.addEventListener('resize', measureSpaceAboveTimeline)
        timelineTime = toHour(TimeControl.currentTime ?? TimeControl.endTime ?? Date.now())

        const resetLayerFills = L_.resetLayerFills
        L_.resetLayerFills = (...args) => {
            resetLayerFills(...args)
            sensorMarkers.forEach(rememberBaseStroke)
            sensorMarkers.forEach(colorSensor)
            styleSelectedSensors()
        }
        const highlight = L_.highlight
        L_.highlight = (layer, ...args) => {
            if (sensorMarkers.has(layer)) return styleSelectedSensors()
            return highlight(layer, ...args)
        }

        Map_.map.eachLayer(trackSensorMarker)
        Map_.map.on('layeradd', (event) => trackSensorMarker(event.layer))
        Map_.map.on('layerremove', (event) => {
            sensorMarkers.delete(event.layer)
            if (selectedMarkers.includes(event.layer)) setSelection(selectedMarkers.filter((marker) => marker !== event.layer))
        })
        Map_.map.on('click', (event) => {
            if (event.originalEvent !== lastSensorClick) setSelection([])
        })
        L_.subscribeTimeChange('SensorChart', ({ currentTime, endTime }) => {
            timelineTime = toHour(currentTime ?? endTime)
            forecastStep = null
            colorAllSensors()
        })
        document.addEventListener('forecasttimeline:step', (event) => {
            if (event.detail.stepUnit !== 'hour') return
            forecastStep = event.detail
            colorAllSensors()
        })
        L_.subscribeOnLayerToggle('SensorChart', (layerName, isOn) => {
            if (isOn || layerName !== forecastStep?.layerName) return
            forecastStep = null
            colorAllSensors()
        })
    },
}

// time colors the map. forecastTime is the forecast the panel shows: the step
// picked on the forecast card, or before one is picked, the run's first
// forecast hour, the tick the card opens on.
function viewOf(sensor) {
    const run = runAt(sensor, forecastStep?.run ?? timelineTime)
    const firstForecastTime = run ? Date.parse(sensor.forecasts[run][0]?.time) : NaN
    return {
        time: forecastStep?.time ?? timelineTime,
        forecastTime: forecastStep?.time ?? (Number.isNaN(firstForecastTime) ? timelineTime : firstForecastTime),
        observedTime: timelineTime,
        run,
    }
}

function setSelection(markers) {
    selectedMarkers = markers
    styleSelectedSensors()
    renderPanel()
}

function removeSensor(aqsCode) {
    setSelection(selectedMarkers.filter((marker) => marker.feature.properties.aqs_code !== aqsCode))
}

function renderPanel() {
    measureSpaceAboveTimeline()
    const entries = selectedMarkers.map((marker) => {
        const sensor = marker.feature.properties
        return { sensor, view: viewOf(sensor) }
    })
    root.render(
        <SensorChartPanel
            entries={entries}
            onRemoveSensor={removeSensor}
            onClose={() => setSelection([])}
        />
    )
}

// The panel stops above the timeline and the coordinates readout that sits on
// it. The timeline's height changes as it expands and as forecast cards come
// and go, and the readout moves with it.
function measureSpaceAboveTimeline() {
    const timeUI = document.getElementById('timeUI')
    if (timeUI && !timeUIObserver) {
        timeUIObserver = new ResizeObserver(measureSpaceAboveTimeline)
        timeUIObserver.observe(timeUI)
    }
    const tops = [timeUI, document.getElementById('CoordinatesDiv')]
        .map((element) => element?.getBoundingClientRect())
        .filter((rect) => rect && rect.height > 0)
        .map((rect) => rect.top)
    const lowestAllowed = Math.min(window.innerHeight, ...tops)
    document.documentElement.style.setProperty('--sensor-chart-bottom-space', `${window.innerHeight - lowestAllowed}px`)
}

function trackSensorMarker(layer) {
    if (!layer.feature?.properties?.observed) return
    sensorMarkers.add(layer)
    rememberBaseStroke(layer)
    if (typeof layer.getRadius === 'function') baseRadii.set(layer, layer.getRadius())
    colorSensor(layer)
    layer.off('click', onSensorClick).on('click', onSensorClick)
}

function rememberBaseStroke(marker) {
    if (selectedMarkers.includes(marker)) return
    const { color, weight, opacity } = marker.options
    baseStrokes.set(marker, { color, weight, opacity })
}

function onSensorClick(event) {
    lastSensorClick = event.originalEvent
    const marker = event.target
    setSelection(
        selectedMarkers.includes(marker)
            ? selectedMarkers.filter((selected) => selected !== marker)
            : [...selectedMarkers, marker]
    )
}

function styleSelectedSensors() {
    sensorMarkers.forEach((marker) => {
        const selected = selectedMarkers.includes(marker)
        marker.setStyle(selected ? SELECTED_STROKE : baseStrokes.get(marker) || {})
        const baseRadius = baseRadii.get(marker)
        if (baseRadius != null) marker.setRadius(selected ? baseRadius + SELECTED_RADIUS_GROWTH : baseRadius)
        if (selected) marker.bringToFront?.()
    })
}

function colorAllSensors() {
    sensorMarkers.forEach(colorSensor)
    renderPanel()
}

function colorSensor(marker) {
    const sensor = marker.feature.properties
    const { time, run } = viewOf(sensor)
    sensor.color = aqiColor(readingAt(sensor, time, run)?.aqi)
    marker.setStyle({ fillColor: sensor.color })
}

export default SensorChart

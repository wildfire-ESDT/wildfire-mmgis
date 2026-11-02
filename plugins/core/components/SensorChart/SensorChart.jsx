import React from 'react'
import { createRoot } from 'react-dom/client'
import L_ from '@basics/Layers_/Layers_'
import Map_ from '@basics/Map_/Map_'
import TimeControl from '@basics/TimeControl_/TimeControl'
import SensorChartPanel from './SensorChartPanel'
import { forecastAt, observedAt, runAt, colorFor, toHour } from './sensorReadings'
import { configFor, forecastLayerOf, listsLayer, setSensorConfigs } from './sensorConfig'

// Sensors share the surface's AQI color scale, so a dark ring keeps them visible
// where a reading matches the prediction underneath. Selection keeps the dark ring,
// thicker, alongside the larger radius.
const SENSOR_STROKE = { color: '#1a1a1a', weight: 3, opacity: 1 }
const SELECTED_STROKE = { color: '#1a1a1a', weight: 5, opacity: 1 }
const SELECTED_RADIUS_GROWTH = 4

const sensorMarkers = new Set()
const baseRadii = new Map()
let root = null
let selectedMarkers = []
let lastSensorClick = null
let timelineTime = null
let forecastStep = null
let timeUIObserver = null

const SensorChart = {
    init: function (vars) {
        setSensorConfigs(vars)
        root = createRoot(document.body.appendChild(document.createElement('div')))
        window.addEventListener('resize', measureSpaceAboveTimeline)
        timelineTime = toHour(TimeControl.currentTime ?? TimeControl.endTime ?? Date.now())

        const resetLayerFills = L_.resetLayerFills
        L_.resetLayerFills = (...args) => {
            resetLayerFills(...args)
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
            if (layerName !== forecastStep?.layerName && !isForecastLayer(layerName)) return
            if (!isOn && layerName === forecastStep?.layerName) forecastStep = null
            colorAllSensors()
        })
    },
}

function configOf(marker) {
    return configFor(marker.options?.layerName)
}

function isForecastLayer(layerName) {
    return [...sensorMarkers].some((marker) => listsLayer(configOf(marker).forecastLayers, layerName))
}

// The step of one of the sensor's own forecast layers, if one has stepped.
function stepFor(config) {
    return listsLayer(config.forecastLayers, forecastStep?.layerName) ? forecastStep : null
}

// Forecasts only show while one of the config's forecast layers is on;
// otherwise a sensor is just its observed readings.
function viewOf(sensor, config) {
    const step = stepFor(config)
    const activeForecastLayer = forecastLayerOf(config, (name) => L_.layers.on[name])
    const forecastOn = activeForecastLayer != null
    const run = forecastOn ? runAt(sensor, step?.run ?? timelineTime) : undefined
    const firstForecastTime = run ? Date.parse(sensor.forecasts[run][0]?.time) : NaN
    return {
        time: (forecastOn && step?.time) || timelineTime,
        forecastTime: forecastOn
            ? step?.time ?? (Number.isNaN(firstForecastTime) ? timelineTime : firstForecastTime)
            : timelineTime,
        observedTime: timelineTime,
        run,
        forecastOn,
        forecastLayerName: step?.layerName ?? activeForecastLayer,
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
        const config = configOf(marker)
        return { sensor, config, view: viewOf(sensor, config) }
    })
    root.render(
        <SensorChartPanel
            entries={entries}
            onRemoveSensor={removeSensor}
            onClose={() => setSelection([])}
            onPickObservedTime={moveTimelineTo}
            onPickForecastTime={(time, layerName) => showForecastHour(time, layerName)}
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

// A blue point moves the main timeline; the forecast card follows to the new
// run's first hour on its own.
function moveTimelineTo(time) {
    const iso = new Date(time).toISOString().split('.')[0] + 'Z'
    TimeControl.setTime(TimeControl.getStartTime(), iso, false, '00:00:00', iso)
}

// A yellow point asks the forecast card to step to that hour of its run.
function showForecastHour(time, layerName) {
    document.dispatchEvent(new CustomEvent('forecasttimeline:show-time', { detail: { time, layerName } }))
}

function trackSensorMarker(layer) {
    if (!layer.feature?.properties?.observed) return
    sensorMarkers.add(layer)
    if (typeof layer.getRadius === 'function') baseRadii.set(layer, layer.getRadius())
    colorSensor(layer)
    styleSelectedSensors()
    layer.off('click', onSensorClick).on('click', onSensorClick)
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
        marker.setStyle(selected ? SELECTED_STROKE : SENSOR_STROKE)
        const baseRadius = baseRadii.get(marker)
        if (baseRadius != null) marker.setRadius(selected ? baseRadius + SELECTED_RADIUS_GROWTH : baseRadius)
        if (selected) marker.bringToFront?.()
    })
}

function colorAllSensors() {
    sensorMarkers.forEach(colorSensor)
    renderPanel()
}

// The forecast for the picked hour when there is one, else the reading observed
// at the timeline's hour. Grey only when there is neither.
function colorSensor(marker) {
    const sensor = marker.feature.properties
    const config = configOf(marker)
    const { time, run, observedTime } = viewOf(sensor, config)
    const reading = forecastAt(sensor, time, run, config.colorBy) ?? observedAt(sensor, observedTime, config.colorBy)
    sensor.color = colorFor(config, reading?.[config.colorBy])
    marker.setStyle({ fillColor: sensor.color })
}

export default SensorChart

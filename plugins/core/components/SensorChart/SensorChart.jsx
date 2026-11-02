import React from 'react'
import { createRoot } from 'react-dom/client'
import L_ from '@basics/Layers_/Layers_'
import Map_ from '@basics/Map_/Map_'
import TimeControl from '@basics/TimeControl_/TimeControl'
import SensorChartPanel from './ui/SensorChartPanel'
import { colorFor } from './logic/sensorColors'
import { DEFAULT_SENSOR_CONFIG, normalizeSensorConfigs } from './logic/sensorConfig'
import { toHour } from './logic/sensorReadings'
import { markerReading, sensorView, stepAfterTimeChange } from './logic/sensorView'

// Sensors share the surface's AQI color scale, so a dark ring keeps them visible
// where a reading matches the prediction underneath. Selection keeps the dark ring,
// thicker, alongside the larger radius.
const SENSOR_STROKE = { color: '#1a1a1a', weight: 3, opacity: 1 }
const SELECTED_STROKE = { color: '#1a1a1a', weight: 5, opacity: 1 }
const SELECTED_RADIUS_GROWTH = 4

let sensorConfigs = []
const sensorMarkers = new Set()
const baseRadii = new WeakMap()
const sensorIds = new WeakMap()
let nextSensorId = 0
let root = null
let selectedMarkers = []
let lastSensorClick = null
let timelineTime = null
let forecastStep = null
let timeUIObserver = null

const SensorChart = {
    init: function (vars) {
        sensorConfigs = normalizeSensorConfigs(vars)
        root = createRoot(document.body.appendChild(document.createElement('div')))
        window.addEventListener('resize', measureSpaceAboveTimeline)
        timelineTime = currentTimelineHour()

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
            forecastStep = stepAfterTimeChange(forecastStep, timelineTime)
            colorAllSensors()
        })
        document.addEventListener('forecasttimeline:step', (event) => {
            if (event.detail?.stepUnit !== 'hour') return
            forecastStep = { ...event.detail, timelineTime: currentTimelineHour() }
            colorAllSensors()
        })
        L_.subscribeOnLayerToggle('SensorChart', (layerName, isOn) => {
            if (layerName !== forecastStep?.layerName && !isForecastLayer(layerName)) return
            if (!isOn && layerName === forecastStep?.layerName) forecastStep = null
            colorAllSensors()
        })
    },
}

function currentTimelineHour() {
    return toHour(TimeControl.currentTime ?? TimeControl.endTime ?? Date.now())
}

function configOf(marker) {
    return configFor(marker.options?.layerName)
}

// The entry that lists this layer as a sensor layer. A layer nobody lists is
// still charted, with defaults and no forecast, when its features carry
// observed readings.
function configFor(layerName) {
    return sensorConfigs.find((entry) => listsLayer(entry.sensorLayers, layerName)) ?? DEFAULT_SENSOR_CONFIG
}

// A configured layer may be stored by its name or its display name.
function listsLayer(layers, layerName) {
    if (!layerName) return false
    const displayName = L_.layers.data[layerName]?.display_name
    return layers.some((layer) => layer === layerName || (displayName != null && layer === displayName))
}

// The first layer that is on and is one of the entry's forecast layers.
function forecastLayerOf(config) {
    return Object.keys(L_.layers.data).find((name) => L_.layers.on[name] && listsLayer(config.forecastLayers, name))
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
    return sensorView(sensor, {
        timelineTime,
        step: stepFor(config),
        activeForecastLayer: forecastLayerOf(config),
    })
}

// Markers are told apart by identity, not by a property: a sensor network
// other than AirNow may have no aqs_code, and one site can sit in two layers.
function sensorIdOf(marker) {
    if (!sensorIds.has(marker)) {
        nextSensorId += 1
        sensorIds.set(marker, nextSensorId)
    }
    return sensorIds.get(marker)
}

function setSelection(markers) {
    selectedMarkers = markers
    styleSelectedSensors()
    renderPanel()
}

function removeSensor(sensorId) {
    setSelection(selectedMarkers.filter((marker) => sensorIdOf(marker) !== sensorId))
}

function renderPanel() {
    if (selectedMarkers.length) measureSpaceAboveTimeline()
    const entries = selectedMarkers.map((marker) => {
        const sensor = marker.feature.properties
        const config = configOf(marker)
        return { id: sensorIdOf(marker), sensor, config, view: viewOf(sensor, config) }
    })
    root.render(
        <SensorChartPanel
            entries={entries}
            onRemoveSensor={removeSensor}
            onClose={() => setSelection([])}
            onPickObservedTime={moveTimelineTo}
            onPickForecastTime={showForecastHour}
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
    document.documentElement.style.setProperty(
        '--sensor-chart-bottom-space',
        `${window.innerHeight - lowestAllowed}px`
    )
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
    if (!Array.isArray(layer.feature?.properties?.observed)) return
    sensorMarkers.add(layer)
    if (typeof layer.getRadius === 'function') baseRadii.set(layer, layer.getRadius())
    colorSensor(layer)
    styleSensor(layer)
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

// Icon markers have no path style to set; they still chart when clicked.
function canStyle(marker) {
    return typeof marker.setStyle === 'function'
}

function styleSensor(marker) {
    if (!canStyle(marker)) return
    const selected = selectedMarkers.includes(marker)
    marker.setStyle(selected ? SELECTED_STROKE : SENSOR_STROKE)
    const baseRadius = baseRadii.get(marker)
    if (baseRadius != null) marker.setRadius(selected ? baseRadius + SELECTED_RADIUS_GROWTH : baseRadius)
    if (selected) marker.bringToFront?.()
}

function styleSelectedSensors() {
    sensorMarkers.forEach(styleSensor)
}

function colorAllSensors() {
    sensorMarkers.forEach(colorSensor)
    renderPanel()
}

// The forecast for the picked hour when there is one, else the reading observed
// at the timeline's hour. Grey only when there is neither.
function colorSensor(marker) {
    if (!canStyle(marker)) return
    const sensor = marker.feature.properties
    const config = configOf(marker)
    const reading = markerReading(sensor, viewOf(sensor, config), config.colorBy)
    marker.setStyle({ fillColor: colorFor(config, reading?.[config.colorBy]) })
}

export default SensorChart

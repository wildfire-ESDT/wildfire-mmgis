import React from 'react'
import { createRoot } from 'react-dom/client'
import L_ from '@basics/Layers_/Layers_'
import Map_ from '@basics/Map_/Map_'
import TimeControl from '@basics/TimeControl_/TimeControl'
import SensorChartPanel from './SensorChartPanel'
import { readingAt, runAt, aqiColor, toHour } from './sensorReadings'

const sensorMarkers = new Set()
let root = null
let selectedMarker = null
let lastSensorClick = null
let timelineTime = null
let forecastStep = null

const SensorChart = {
    init: function () {
        root = createRoot(document.body.appendChild(document.createElement('div')))
        timelineTime = toHour(TimeControl.currentTime ?? TimeControl.endTime ?? Date.now())
        const resetLayerFills = L_.resetLayerFills
        L_.resetLayerFills = (...args) => {
            resetLayerFills(...args)
            sensorMarkers.forEach(colorSensor)
        }
        Map_.map.eachLayer(trackSensorMarker)
        Map_.map.on('layeradd', (event) => trackSensorMarker(event.layer))
        Map_.map.on('layerremove', (event) => {
            sensorMarkers.delete(event.layer)
            if (event.layer === selectedMarker) selectMarker(null)
        })
        Map_.map.on('click', (event) => {
            if (event.originalEvent !== lastSensorClick) selectMarker(null)
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

function viewOf(sensor) {
    return {
        time: forecastStep?.time ?? timelineTime,
        observedTime: timelineTime,
        run: runAt(sensor, forecastStep?.run ?? timelineTime),
    }
}

function selectMarker(marker) {
    selectedMarker = marker
    renderPanel()
}

function renderPanel() {
    const sensor = selectedMarker?.feature.properties
    root.render(<SensorChartPanel sensor={sensor} view={sensor && viewOf(sensor)} onClose={() => selectMarker(null)} />)
}

function trackSensorMarker(layer) {
    if (!layer.feature?.properties?.observed) return
    sensorMarkers.add(layer)
    colorSensor(layer)
    layer.off('click', onSensorClick).on('click', onSensorClick)
}

function onSensorClick(event) {
    lastSensorClick = event.originalEvent
    selectMarker(event.target)
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

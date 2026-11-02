// What a sensor shows for the timeline's hour and the forecast step.

import { forecastAt, observedAt, runAt } from './sensorReadings'

// Observed at the timeline's hour, and while one of its forecast layers is on,
// the run starting at that hour (or at the stepped run) with the stepped hour
// or else the run's first.
export function sensorView(sensor, { timelineTime, step, activeForecastLayer }) {
    const forecastOn = activeForecastLayer != null
    const run = forecastOn ? runAt(sensor, step?.run ?? timelineTime) : undefined
    return {
        time: (forecastOn && step?.time) || timelineTime,
        forecastTime: forecastOn ? (step?.time ?? firstForecastTime(sensor, run, timelineTime)) : timelineTime,
        observedTime: timelineTime,
        run,
        forecastOn,
        forecastLayerName: step?.layerName ?? activeForecastLayer,
    }
}

function firstForecastTime(sensor, run, fallbackTime) {
    const time = run ? Date.parse(sensor.forecasts[run][0]?.time) : NaN
    return Number.isNaN(time) ? fallbackTime : time
}

// The reading a marker is colored by: the forecast for the picked hour, else
// the reading observed at the timeline's hour.
export function markerReading(sensor, view, colorKey) {
    return forecastAt(sensor, view.time, view.run, colorKey) ?? observedAt(sensor, view.observedTime, colorKey)
}

// ForecastTimeline may step before or after the plugin hears of a time change,
// so only a step taken at another hour is stale.
export function stepAfterTimeChange(step, timelineTime) {
    return step?.timelineTime === timelineTime ? step : null
}

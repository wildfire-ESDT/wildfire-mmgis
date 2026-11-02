// Finding a sensor's readings by hour, and showing a reading's value.

const ONE_HOUR = 3600000

export function toHour(time) {
    return Math.floor(new Date(time).getTime() / ONE_HOUR) * ONE_HOUR
}

export function runAt(sensor, time) {
    return Object.keys(sensor.forecasts ?? {}).find((run) => Date.parse(run) === time)
}

export function forecastAt(sensor, time, run, colorKey) {
    if (!run || time <= Date.parse(run)) return null
    const forecast = sensor.forecasts?.[run]?.find((reading) => Date.parse(reading.time) === time)
    return forecast?.[colorKey] != null ? { ...forecast, isForecast: true } : null
}

export function observedAt(sensor, time, colorKey) {
    return sensor.observed.find((reading) => reading[colorKey] != null && Date.parse(reading.time) === time)
}

export function readingsAt(sensor, view, colorKey) {
    const observed = observedAt(sensor, view.observedTime, colorKey)
    const forecast = forecastAt(sensor, view.forecastTime, view.run, colorKey)
    const hoursAhead = forecast && Math.round((Date.parse(forecast.time) - Date.parse(view.run)) / ONE_HOUR)
    return { observed, forecast, hoursAhead }
}

// A reading value in a unit: its configured decimals, else at most three, then
// the unit's suffix.
export function formatReading(value, unit) {
    if (value == null) return '—'
    const shown = unit.decimals == null ? Number(value).toLocaleString() : Number(value).toFixed(unit.decimals)
    return unit.suffix ? `${shown} ${unit.suffix}` : shown
}

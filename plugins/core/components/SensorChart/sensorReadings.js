const ONE_HOUR = 3600000
const AQI_COLOR_STOPS = [
    [0, [0, 228, 0]],
    [50, [255, 255, 0]],
    [100, [255, 126, 0]],
    [150, [255, 0, 0]],
    [200, [143, 63, 151]],
    [300, [126, 0, 35]],
]
const NO_READING_COLOR = 'rgb(128, 128, 128)'

export function toHour(time) {
    return Math.floor(new Date(time).getTime() / ONE_HOUR) * ONE_HOUR
}

export function runAt(sensor, time) {
    return Object.keys(sensor.forecasts).find((run) => Date.parse(run) === time)
}

export function forecastAt(sensor, time, run) {
    if (!run || time <= Date.parse(run)) return null
    const forecast = sensor.forecasts[run].find((reading) => Date.parse(reading.time) === time)
    return forecast?.aqi != null ? { ...forecast, isForecast: true } : null
}

export function readingAt(sensor, time, run) {
    const forecast = forecastAt(sensor, time, run)
    if (forecast) return forecast
    return sensor.observed.find((reading) => reading.aqi != null && Date.parse(reading.time) === time)
}
export function readingsAt(sensor, view) {
    const observed = sensor.observed.find((reading) => Date.parse(reading.time) === view.observedTime && reading.aqi != null)
    const selected = readingAt(sensor, view.forecastTime, view.run)
    const forecast = selected?.isForecast ? selected : null
    const hoursAhead = forecast && Math.round((Date.parse(forecast.time) - Date.parse(view.run)) / ONE_HOUR)
    return { observed, forecast, hoursAhead }
}

export function aqiColor(aqi) {
    if (aqi == null) return NO_READING_COLOR
    const upperIndex = AQI_COLOR_STOPS.findIndex(([stopAqi]) => aqi <= stopAqi)
    if (upperIndex === 0) return toRgb(AQI_COLOR_STOPS[0][1])
    if (upperIndex === -1) return toRgb(AQI_COLOR_STOPS.at(-1)[1])
    const [lowerAqi, lowerColor] = AQI_COLOR_STOPS[upperIndex - 1]
    const [upperAqi, upperColor] = AQI_COLOR_STOPS[upperIndex]
    const fraction = (aqi - lowerAqi) / (upperAqi - lowerAqi)
    return toRgb(lowerColor.map((channel, index) => channel + (upperColor[index] - channel) * fraction))
}

function toRgb([red, green, blue]) {
    return `rgb(${Math.round(red)}, ${Math.round(green)}, ${Math.round(blue)})`
}

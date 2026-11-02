// The color scales markers and reading dots are drawn in.

const AQI_COLOR_STOPS = [
    [0, [0, 228, 0]],
    [50, [255, 255, 0]],
    [100, [255, 126, 0]],
    [150, [255, 0, 0]],
    [200, [143, 63, 151]],
    [300, [126, 0, 35]],
]
// Hex stops of the PM2.5 tile colormap (adjacent-servers/resources/colormaps/generate_pm25_levels.py).
const PM25_COLOR_STOPS = [
    [0, [34, 139, 34]],
    [9, [173, 255, 47]],
    [20, [255, 255, 0]],
    [32, [255, 126, 0]],
    [55.4, [255, 0, 0]],
    [65, [143, 63, 151]],
    [75, [126, 0, 35]],
]
const NO_READING_COLOR = 'rgb(128, 128, 128)'

// Color scales a config can name. A scale colors the reading field of the same name.
const COLOR_SCALES = { aqi: aqiColor, pm25: pm25Color }

export function colorFor(config, value) {
    return (COLOR_SCALES[config.colorBy] ?? aqiColor)(value)
}

export function aqiColor(aqi) {
    return rampColor(AQI_COLOR_STOPS, aqi)
}

export function pm25Color(pm25) {
    return rampColor(PM25_COLOR_STOPS, pm25)
}

function rampColor(stops, value) {
    if (value == null) return NO_READING_COLOR
    const upperIndex = stops.findIndex(([stopValue]) => value <= stopValue)
    if (upperIndex === 0) return toRgb(stops[0][1])
    if (upperIndex === -1) return toRgb(stops.at(-1)[1])
    const [lowerValue, lowerColor] = stops[upperIndex - 1]
    const [upperValue, upperColor] = stops[upperIndex]
    const fraction = (value - lowerValue) / (upperValue - lowerValue)
    return toRgb(lowerColor.map((channel, index) => channel + (upperColor[index] - channel) * fraction))
}

function toRgb([red, green, blue]) {
    return `rgb(${Math.round(red)}, ${Math.round(green)}, ${Math.round(blue)})`
}

/**
 * Forecast type registry. A forecast type knows how one kind of forecast layer
 * is stepped and checked. A layer names its type in time.forecast.type; a layer
 * that names none gets `time`. See README.
 */

import timeForecastType from './time'

const forecastTypes = {}
const generics = []

export function registerForecastType(forecastType, { generic = false } = {}) {
    if (!forecastType?.name || typeof forecastType.showStep !== 'function') {
        throw new Error('A forecast type needs a name and a showStep method')
    }
    if (forecastTypes[forecastType.name]) {
        console.warn(`[ForecastTimeline] forecast type "${forecastType.name}" registered twice; the later one wins`)
    }
    forecastTypes[forecastType.name] = forecastType
    if (generic && !generics.includes(forecastType.name)) generics.push(forecastType.name)
    return forecastType
}

export function getForecastType(name) {
    return forecastTypes[name] || null
}

export function genericForecastTypeNames() {
    return generics.slice()
}

// When a layer names no type, pick from its own config fields. Never from URL
// patterns.
export function defaultForecastTypeName(ld) {
    const fc = ld?.time?.forecast
    if (fc?.urlTemplate === true) return 'url-template'
    if (ld?.sourceType === 'stac-collection') return 'stac'
    return timeForecastType.name
}

const noted = new Set()

// The forecast type a layer uses, or null when the named one isn't registered.
export function resolveForecastType(ld) {
    const fc = ld?.time?.forecast
    let name = fc?.type
    if (!name) {
        name = defaultForecastTypeName(ld)
        if (ld?.name && !noted.has(ld.name)) {
            noted.add(ld.name)
            console.info(
                `[ForecastTimeline] "${ld.name}" sets no time.forecast.type; using "${name}". Set it in Configure.`
            )
        }
    }
    const forecastType = getForecastType(name)
    if (!forecastType && ld?.name && !noted.has(`${ld.name}:${name}`)) {
        noted.add(`${ld.name}:${name}`)
        console.error(`[ForecastTimeline] "${ld.name}": forecast type "${name}" not found`)
    }
    return { name, forecastType }
}

registerForecastType(timeForecastType, { generic: true })

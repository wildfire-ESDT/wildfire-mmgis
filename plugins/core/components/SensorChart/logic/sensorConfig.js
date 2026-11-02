// Mission config (variables.sensorCharts) cleaned into entries the plugin can
// trust: a hand-edited config may hold nulls, a string where a list belongs, or
// decimals toFixed would throw on.

const MAX_DECIMALS = 20

export const DEFAULT_UNIT = { key: 'aqi', label: 'AQI' }
export const DEFAULT_SENSOR_CONFIG = {
    sensorLayers: [],
    forecastLayers: [],
    modelName: '',
    modelLogo: '',
    colorBy: 'aqi',
    units: [DEFAULT_UNIT],
}

export function normalizeSensorConfigs(variables) {
    const entries = Array.isArray(variables?.sensorCharts) ? variables.sensorCharts : []
    return entries.filter((entry) => entry != null && typeof entry === 'object').map(normalizeEntry)
}

function normalizeEntry(entry) {
    const units = (Array.isArray(entry.units) ? entry.units : [])
        .filter((unit) => typeof unit?.key === 'string' && unit.key !== '')
        .map(normalizeUnit)
    return {
        ...DEFAULT_SENSOR_CONFIG,
        ...entry,
        sensorLayers: asLayerList(entry.sensorLayers),
        forecastLayers: asLayerList(entry.forecastLayers),
        modelName: asText(entry.modelName),
        modelLogo: asText(entry.modelLogo),
        colorBy: asText(entry.colorBy) || DEFAULT_SENSOR_CONFIG.colorBy,
        units: units.length ? units : DEFAULT_SENSOR_CONFIG.units,
    }
}

function normalizeUnit(unit) {
    return {
        key: unit.key,
        label: asText(unit.label) || unit.key,
        suffix: asText(unit.suffix),
        decimals: asDecimals(unit.decimals),
    }
}

function asLayerList(layers) {
    if (typeof layers === 'string') return layers ? [layers] : []
    return Array.isArray(layers) ? layers.filter((layer) => typeof layer === 'string' && layer !== '') : []
}

function asText(value) {
    return typeof value === 'string' ? value : ''
}

function asDecimals(decimals) {
    if (decimals == null || decimals === '') return undefined
    const count = Number(decimals)
    return Number.isInteger(count) ? Math.min(Math.max(count, 0), MAX_DECIMALS) : undefined
}

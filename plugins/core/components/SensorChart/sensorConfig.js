// Sensor chart settings from the component's mission config
// (variables.sensorCharts). Each entry describes one kind of sensor: which
// layers hold the sensors, which layers forecast them, and what is measured.

import L_ from '@basics/Layers_/Layers_'

const DEFAULT_UNIT = { key: 'aqi', label: 'AQI' }
const DEFAULTS = {
    sensorLayers: [],
    forecastLayers: [],
    modelName: '',
    modelLogo: '',
    colorBy: 'aqi',
    units: [DEFAULT_UNIT],
}

let entries = []

export function setSensorConfigs(variables) {
    entries = (variables?.sensorCharts ?? []).map(normalize)
}

// The entry that lists this layer as a sensor layer. A layer nobody lists is
// still charted, with defaults and no forecast, when its features carry
// observed readings.
export function configFor(layerName) {
    return entries.find((entry) => listsLayer(entry.sensorLayers, layerName)) ?? DEFAULTS
}

// A configured layer may be stored by its name or its display name.
export function listsLayer(layers, layerName) {
    if (!layerName) return false
    const displayName = L_.layers.data[layerName]?.display_name
    return layers.some((layer) => layer === layerName || (displayName != null && layer === displayName))
}

// Whether any of the layer names is one of the layers the entry forecasts with.
export function forecastLayerOf(config, isLayerOn) {
    return Object.keys(L_.layers.data).find((name) => isLayerOn(name) && listsLayer(config.forecastLayers, name))
}

function normalize(entry) {
    const units = (entry.units ?? []).filter((unit) => unit?.key)
    return {
        ...DEFAULTS,
        ...entry,
        sensorLayers: entry.sensorLayers ?? [],
        forecastLayers: entry.forecastLayers ?? [],
        colorBy: entry.colorBy || DEFAULTS.colorBy,
        units: units.length ? units.map((unit) => ({ ...unit, label: unit.label || unit.key })) : DEFAULTS.units,
    }
}

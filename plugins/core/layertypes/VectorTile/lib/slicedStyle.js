/**
 * slicedStyle — resolving a sliced feature's style, shared by the 2D and 3D
 * renderings so the two views agree on what a feature looks like.
 *
 * A sliced layer's features come from a GeoJSON document rather than a vector
 * tileset, so they carry the properties the layer was configured against:
 * both the `style.<x>Prop` indirection vector tiles already support (colour
 * from a feature property) and the `properties.style` object vector layers
 * use. Neither renderer should own that resolution privately — the globe
 * drawing a feature differently from the map is exactly the class of bug this
 * avoids.
 */
import F_ from '@basics/Formulae_/Formulae_'

export const DEFAULT_STYLE = {
    color: '#ffffff',
    weight: 1,
    opacity: 1,
    fillColor: '#3388ff',
    fillOpacity: 0.4,
    radius: 4,
}

/**
 * The layer style overlaid with a feature's own `properties.style`.
 *
 * Opt out with `style.letPropertiesStyleOverride === false` for a layer whose
 * data carries a `style` property that isn't meant as styling.
 */
export function mergedStyle(style = {}, properties = {}) {
    if (style.letPropertiesStyleOverride === false) return style
    const own = properties?.style
    return own != null && typeof own === 'object' ? { ...style, ...own } : style
}

/**
 * One style value, preferring the feature's own property when the layer
 * configured a `…Prop` key for it (`colorProp`, `fillColorProp`, …). The key
 * may be a dotted path into the properties object.
 */
export function styleValue(style, properties, key) {
    const propKey = style[`${key}Prop`]
    if (propKey) {
        const value = F_.getIn(properties, propKey)
        if (value != null) return value
    }
    return style[key] ?? DEFAULT_STYLE[key]
}

/**
 * A feature's fully-resolved style: layer config, then `properties.style`,
 * then any per-property overrides, with defaults for whatever is left unset.
 *
 * @param {object} style - the layer's `style` config
 * @param {object} properties - the feature's properties
 * @returns {{color, weight, opacity, fillColor, fillOpacity, radius}}
 */
export function resolveFeatureStyle(style, properties) {
    const merged = mergedStyle(style, properties)
    const number = (value, fallback) => {
        const parsed = parseFloat(value)
        return isNaN(parsed) ? fallback : parsed
    }
    return {
        color: styleValue(merged, properties, 'color'),
        fillColor: styleValue(merged, properties, 'fillColor'),
        weight: number(
            styleValue(merged, properties, 'weight'),
            DEFAULT_STYLE.weight
        ),
        opacity: number(
            styleValue(merged, properties, 'opacity'),
            DEFAULT_STYLE.opacity
        ),
        fillOpacity: number(
            styleValue(merged, properties, 'fillOpacity'),
            DEFAULT_STYLE.fillOpacity
        ),
        radius: number(
            styleValue(merged, properties, 'radius'),
            DEFAULT_STYLE.radius
        ),
    }
}

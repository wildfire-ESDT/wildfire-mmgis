/**
 * sliceMetadata — turning a sliced feature's raw properties into something a
 * user actually wants to read (e.g. "Fire Incident: <name> / Acres: <n>")
 * instead of a raw source-data property name like `poly_IncidentName`.
 *
 * Shared by the 2D map (hover tooltip, description-panel header) and the
 * Cesium globe (hover tooltip) so both say the same thing about the same
 * feature.
 */

// Common WFIGS/NIFC field names for burned acreage, most-specific first.
// Not configurable per layer (yet) — these are the field names actually seen
// on WFIGS "Interagency Perimeters" feeds; a layer using a differently-named
// source would need this list extended.
const ACRES_KEYS = [
    'poly_GISAcres',
    'attr_IncidentSize',
    'attr_DiscoveryAcres',
    'GISAcres',
    'DAILY_AC',
    'acres',
]

const NAME_FALLBACK_KEYS = [
    'poly_IncidentName',
    'attr_IncidentName',
    'IncidentName',
    'name',
]

/** The first non-empty value among a list of property keys, or null. */
function firstValue(properties, keys) {
    for (const key of keys) {
        const value = properties?.[key]
        if (value != null && value !== '') return value
    }
    return null
}

function incidentNameKeys(layerObj) {
    const configured = layerObj?.variables?.useKeyAsName
    const configuredKeys = Array.isArray(configured)
        ? configured
        : configured
        ? [configured]
        : []
    return [...configuredKeys, ...NAME_FALLBACK_KEYS]
}

/**
 * The best name for a feature: the layer's own configured
 * `variables.useKeyAsName` first (so a layer author's choice always wins),
 * then a few common incident-name field names.
 */
export function pickIncidentName(layerObj, properties) {
    return firstValue(properties, incidentNameKeys(layerObj))
}

/**
 * Which property key `pickIncidentName` actually read the value from, or
 * null. For a caller that needs to point at the real property (e.g.
 * `useKeyAsName`) rather than copy its value under an invented key — an
 * invented key changes the feature's property set, and the globe's
 * highlight-sync matches a 2D-originated selection by exact property
 * equality, so a feature carrying an extra key never matches its own,
 * unmodified copy on the globe's side.
 */
export function pickIncidentNameKey(layerObj, properties) {
    return (
        incidentNameKeys(layerObj).find((key) => {
            const value = properties?.[key]
            return value != null && value !== ''
        }) ?? null
    )
}

/** Burned acreage from whichever common field name the source data used. */
export function pickAcres(properties) {
    const value = firstValue(properties, ACRES_KEYS)
    if (value == null) return null
    const num = parseFloat(value)
    return isNaN(num) ? value : num
}

/**
 * A short, human-facing label for a feature — "Fire Incident: <name>", with
 * "Acres: <n>" appended on its own line when available. Returns null when
 * there's nothing to show (e.g. neither field exists on this feature).
 */
export function frontFacingLabel(layerObj, properties) {
    const name = pickIncidentName(layerObj, properties)
    const acres = pickAcres(properties)

    const parts = []
    if (name != null) parts.push(`Fire Incident: ${name}`)
    if (acres != null)
        parts.push(
            `Acres: ${typeof acres === 'number' ? acres.toLocaleString() : acres}`
        )

    // CursorInfo's tooltip div is `white-space: pre-wrap`, so a plain
    // newline is enough to put each on its own line — no HTML needed (and
    // CursorInfo.update renders this via `.text()`, so an HTML entity like
    // "&middot;" would've shown up as those literal characters, not a dot).
    return parts.length ? parts.join('\n') : null
}

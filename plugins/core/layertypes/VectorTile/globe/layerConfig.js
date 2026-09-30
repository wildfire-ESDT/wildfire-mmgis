/**
 * VectorTile layer type — globe layer config.
 *
 * Two globe renderings exist for this type, and `isRenderable` answers for
 * both engines which (if either) a layer wants:
 *   - extruded MVT: true 3D volumes built from an existing tileset
 *   - sliced GeoJSON: a big GeoJSON tiled client-side and draped as raster
 *     imagery (see lib/CesiumSlicedVectorLayer)
 * A flat, non-sliced vector tileset remains a 2D-map-only rendering.
 */
import L_ from '@basics/Layers_/Layers_'
import { timeResolvedSliceUrl } from '../lib/sliceTime'

/**
 * True when the layer's source is a GeoJSON document to be tiled at runtime
 * rather than an existing `{z}/{x}/{y}` tileset.
 *
 * `sliceEnabled: true` forces it; otherwise a url with no tile placeholders
 * and no `geodatasets:` scheme can only be a whole document, so it is sliced
 * even when `sliceEnabled` was saved as false.
 */
export function isSliced(layerObj) {
    if (layerObj.sliceEnabled === true) return true

    const url = layerObj.url || ''
    if (url === '') return false
    if (url.split(':')[0].toLowerCase() === 'geodatasets') return false
    return !/\{z\}|\{x\}|\{y\}/.test(url)
}

export function isRenderable(layerObj) {
    return layerObj.extrudeEnabled === true || isSliced(layerObj)
}

// geojson-vt throws outright for a maxZoom outside 0–24 ("maxZoom should be
// in the 0-24 range"), and a layer's maxZoom is routinely set past that.
const MAX_SLICE_ZOOM = 24
const DEFAULT_SLICE_ZOOM = 18
const DEFAULT_SLICE_TOLERANCE = 3

/**
 * The GeoJSONSlicer options for a sliced layer. Both the 2D map and the globe
 * ask `sliceUrl` for exactly these, which is what lets them share one fetch
 * and one slice of the document (sliceUrl caches by URL + options).
 *
 * `maxZoom` is the slice's full-detail zoom: the layer's native zoom when it
 * has one, else its max zoom, clamped to what geojson-vt accepts. Neither
 * renderer asks the slicer for anything deeper — both overzoom its deepest
 * tiles instead (Leaflet's maxNativeZoom, Cesium's imagery maximumLevel).
 */
export function sliceOptions(layerObj) {
    const zoom = [layerObj.maxNativeZoom, layerObj.maxZoom]
        .map((z) => parseInt(z, 10))
        .find((z) => !isNaN(z))
    const tolerance = parseFloat(layerObj.sliceTolerance)
    return {
        maxZoom: Math.max(
            0,
            Math.min(zoom ?? DEFAULT_SLICE_ZOOM, MAX_SLICE_ZOOM)
        ),
        tolerance: isNaN(tolerance)
            ? DEFAULT_SLICE_TOLERANCE
            : Math.max(0, tolerance),
    }
}

export function toGlobeConfig(layerObj) {
    const s = layerObj
    const sliced = isSliced(s)
    const slice = sliced ? sliceOptions(s) : {}

    return {
        name: s.name,
        path: sliced ? timeResolvedSliceUrl(s) : L_.getUrl(s.type, s.url, s),
        opacity: L_.layers.opacity[s.name],
        sliced,
        // Resolved by sliceOptions — the same values the 2D map slices with,
        // so the globe reuses the map's slice rather than making its own.
        sliceMaxZoom: slice.maxZoom,
        sliceTolerance: slice.tolerance,
        style: s.style || {},
        // Only consumed by the sliced hover label (sliceMetadata.pickIncidentName)
        // — the same field a sliced layer's 2D hover/click already reads.
        useKeyAsName: s.variables?.useKeyAsName,
        vtLayer:
            s.extrudeVtLayer ||
            (s.style?.vtLayer ? Object.keys(s.style.vtLayer)[0] : 'building'),
        extrudeHeightProperty: s.extrudeHeightProperty || 'render_height',
        extrudeDefaultHeight: s.extrudeDefaultHeight ?? 0,
        extrudeBaseProperty: s.extrudeBaseProperty || null,
        extrudeColor: s.extrudeColor || '#cccccc',
        extrudeOverrideFeatureColor: s.extrudeOverrideFeatureColor || false,
        extrudeOpacity: s.extrudeOpacity ?? 0.9,
        minZoom: s.minZoom,
        maxZoom: s.maxNativeZoom,
    }
}

/**
 * Extruded geometry is expensive to build, so it stays loaded on the globe and
 * is hidden in place; `make` toggles it back on instead of rebuilding it.
 */
export function onToggle(layerObj, gctx) {
    if (gctx.visible) return
    if (isRenderable(layerObj)) gctx.toggleLayer(layerObj.name, false)
    else gctx.removeLayer(layerObj.name)
}

/** Show extruded tiles already on the globe, or build them. */
export function makeWith(layerObj, gctx, render) {
    if (!isRenderable(layerObj)) return
    if (gctx.hasLayer(layerObj.name))
        return gctx.toggleLayer(layerObj.name, true)
    return render(toGlobeConfig(layerObj), gctx)
}

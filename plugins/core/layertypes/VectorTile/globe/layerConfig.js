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

/**
 * True when the layer's source is a GeoJSON document to be tiled at runtime
 * rather than an existing `{z}/{x}/{y}` tileset.
 *
 * Explicit `sliceEnabled` wins; otherwise a url with no tile placeholders and
 * no `geodatasets:` scheme can only be a whole document, so slicing is what
 * the user must have meant.
 */
export function isSliced(layerObj) {
    if (layerObj.sliceEnabled === true) return true
    if (layerObj.sliceEnabled === false) return false

    const url = layerObj.url || ''
    if (url === '') return false
    if (url.split(':')[0].toLowerCase() === 'geodatasets') return false
    return !/\{z\}|\{x\}|\{y\}/.test(url)
}

export function isRenderable(layerObj) {
    return layerObj.extrudeEnabled === true || isSliced(layerObj)
}

export function toGlobeConfig(layerObj) {
    const s = layerObj

    return {
        name: s.name,
        path: L_.getUrl(s.type, s.url, s),
        opacity: L_.layers.opacity[s.name],
        sliced: isSliced(s),
        sliceTolerance: s.sliceTolerance,
        style: s.style || {},
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

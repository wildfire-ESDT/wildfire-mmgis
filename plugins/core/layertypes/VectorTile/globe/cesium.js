/**
 * VectorTile layer type — Cesium globe renderer.
 *
 * Owns all Cesium-specific vector-tile content and dispatches between the
 * type's two globe renderings:
 *   - extruded MVT tilesets → CesiumMVTLayer (true 3D volumes)
 *   - client-sliced GeoJSON → CesiumSlicedVectorLayer (draped raster imagery)
 * plus per-layer removal/visibility/opacity for both. GlobeRenderer stays the
 * middleware — it owns the shared `_layers` registry and the generic
 * cleanup/render-request around these calls, and dispatches here through
 * LayerTypeRegistry.
 *
 * gctx (cesium) = { engine, renderer, layers, requestRender, ... }
 */
import CesiumMVTLayer from '@basics/Globe_/CesiumMVTLayer'
import CesiumSlicedVectorLayer from '../lib/CesiumSlicedVectorLayer'
import L_ from '@basics/Layers_/Layers_'
import { makeWith, onToggle } from './layerConfig'

function make(layerObj, gctx) {
    return makeWith(layerObj, gctx, render)
}

// Add an already-built globe layer config (engine-facing entry point).
function render(layerConfig, gctx) {
    const { renderer, layers } = gctx

    if (layerConfig.sliced) return renderSliced(layerConfig, gctx)

    const mvtLayer = new CesiumMVTLayer(renderer, {
        name: layerConfig.name,
        url: layerConfig.path,
        vtLayer: layerConfig.vtLayer,
        extrudeHeightProperty: layerConfig.extrudeHeightProperty,
        extrudeDefaultHeight: layerConfig.extrudeDefaultHeight,
        extrudeBaseProperty: layerConfig.extrudeBaseProperty,
        extrudeColor: layerConfig.extrudeColor,
        extrudeOpacity: layerConfig.extrudeOpacity,
        minZoom: layerConfig.minZoom,
        maxZoom: layerConfig.maxZoom,
        opacity: layerConfig.opacity,
    })

    layers[layerConfig.name] = {
        type: 'vectortile',
        kind: 'mvt',
        mvtLayer: mvtLayer,
        visible: true,
    }
}

/**
 * A GeoJSON document tiled in the browser and drawn as draped imagery.
 *
 * Registered with `kind: 'sliced'` and a `pick` hook, which is how
 * GlobeRenderer's global click handler finds a feature on a layer that has no
 * entities to pick — a texture carries no geometry, so the layer answers the
 * hit-test itself from the tile under the cursor.
 */
function renderSliced(layerConfig, gctx) {
    const { renderer, layers } = gctx
    const { name } = layerConfig

    const slicedLayer = new CesiumSlicedVectorLayer(renderer, {
        name,
        url: layerConfig.path,
        style: layerConfig.style,
        opacity: layerConfig.opacity,
        minZoom: layerConfig.minZoom,
        maxZoom: layerConfig.maxZoom,
        sliceTolerance: layerConfig.sliceTolerance,
        onReady: () => gctx.requestRender(),
    })

    layers[name] = {
        type: 'vectortile',
        kind: 'sliced',
        slicedLayer,
        visible: true,
        pick: (lng, lat) => slicedLayer.featureAt(lng, lat),
        onClick: (feature) => L_.selectFeature(name, feature),
    }
}

// Engine-specific teardown only; GlobeRenderer performs the generic `_layers`
// cleanup and render request.
function destroy(name, gctx) {
    const layerInfo = gctx.layers[name]
    if (!layerInfo) return
    if (layerInfo.kind === 'sliced') layerInfo.slicedLayer.destroy()
    else layerInfo.mvtLayer.destroy()
}

function setVisibility(name, visible, gctx) {
    const layerInfo = gctx.layers[name]
    if (!layerInfo) return
    if (layerInfo.kind === 'sliced') layerInfo.slicedLayer.setVisible(visible)
    else layerInfo.mvtLayer.setVisible(visible)
    layerInfo.visible = visible
}

function setOpacity(name, opacity, gctx) {
    const layerInfo = gctx.layers[name]
    if (!layerInfo) return
    if (layerInfo.kind === 'sliced') layerInfo.slicedLayer.setOpacity(opacity)
    else layerInfo.mvtLayer.setOpacity(opacity)
    gctx.requestRender()
}

export default {
    make,
    onToggle,
    render,
    destroy,
    setVisibility,
    setOpacity,
}

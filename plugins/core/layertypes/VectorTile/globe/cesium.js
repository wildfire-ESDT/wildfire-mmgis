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
import { makeWith, onToggle as hideOrRemove, isSliced } from './layerConfig'
import { frontFacingLabel } from '../lib/sliceMetadata'
import {
    layerInteractionsDisabled,
    selectSlicedFeature,
    clearSlicedSelection,
} from '../lib/slicedSelection'

function make(layerObj, gctx) {
    return makeWith(layerObj, gctx, render)
}

/**
 * A sliced layer toggled off is removed from the globe outright, releasing
 * its imagery, rather than kept hidden the way extruded tiles are: the
 * expensive part — the fetched, sliced document — stays cached by sliceUrl
 * (and in use by the 2D map), so turning it back on only re-adds imagery.
 */
function onToggle(layerObj, gctx) {
    if (!gctx.visible && isSliced(layerObj))
        return gctx.removeLayer(layerObj.name)
    return hideOrRemove(layerObj, gctx)
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
        // The same slice options the 2D map uses (layerConfig.sliceOptions),
        // so sliceUrl hands both views the one slice.
        maxZoom: layerConfig.sliceMaxZoom,
        sliceTolerance: layerConfig.sliceTolerance,
        onReady: () => gctx.requestRender(),
        // A failed build must not leave a dead entry behind: `make` treats
        // any registered layer as present and only re-shows it, so the
        // layer could never be rebuilt. Unregistered, the next toggle-on
        // tries again.
        onError: () => {
            if (layers[name]?.slicedLayer === slicedLayer)
                gctx.removeLayer(name)
        },
    })

    layers[name] = {
        type: 'vectortile',
        kind: 'sliced',
        slicedLayer,
        visible: true,
        pick: (lng, lat) => slicedLayer.featureAt(lng, lat),
        // Everything a 2D click on the feature does (map.js), not just the
        // highlight: the Description panel and tools listening for
        // setActiveFeature must hear about a globe selection too.
        onClick: (feature) => {
            if (layerInteractionsDisabled()) return
            selectSlicedFeature(name, feature)
        },
        // A globe click that hit nothing: deselect, as an empty 2D click
        // does — if the selection is this layer's to clear.
        onClickEmpty: () => {
            if (
                L_.activeFeature?.layerName === name ||
                slicedLayer.highlightedIndex != null
            )
                clearSlicedSelection()
        },
        // Same "Fire Incident: <name> / Acres: <n>" label the 2D map's
        // hover shows, driven by GlobeRenderer's hover hit-test (mirrors
        // pick/onClick above, which is that same hit-test for a click).
        onHover: (feature) =>
            frontFacingLabel(
                { variables: { useKeyAsName: layerConfig.useKeyAsName } },
                feature.properties
            ),
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

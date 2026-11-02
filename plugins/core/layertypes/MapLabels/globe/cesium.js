/**
 * 3D Roads and Labels on the Cesium globe, the layer type's entry: place names,
 * road names and freeway lines from OpenMapTiles vector tiles, drawn as 3D
 * objects so they stay readable over terrain and Google's photorealistic mesh.
 */
import L_ from '@basics/Layers_/Layers_'
import { DEFAULT_TILES_URL, MAP_LABELS_LAYER_TYPE } from '../logic/constants'
import CesiumMapLabelsLayer from '../render/CesiumMapLabelsLayer'

// A hidden layer stays loaded, so turning it back on only shows it.
function make(missionLayerConfig, globeContext) {
    if (globeContext.hasLayer(missionLayerConfig.name))
        return globeContext.toggleLayer(missionLayerConfig.name, true)

    const mapLabelsLayer = new CesiumMapLabelsLayer(globeContext.renderer, {
        tilesUrl: missionLayerConfig.url || DEFAULT_TILES_URL,
        showPlaceNames: missionLayerConfig.showPlaceNames,
        showRoadNames: missionLayerConfig.showRoadNames,
        showRoadLines: missionLayerConfig.showRoadLines,
        fontSizePixels: missionLayerConfig.labelFontSize,
        opacity: L_.layers.opacity[missionLayerConfig.name] ?? 1,
    })
    mapLabelsLayer.ready.catch((loadError) =>
        console.error(`3D Roads and Labels layer "${missionLayerConfig.name}" failed to start:`, loadError)
    )
    globeContext.layers[missionLayerConfig.name] = {
        type: MAP_LABELS_LAYER_TYPE,
        kind: 'maplabels',
        mapLabelsLayer,
        visible: true,
    }
}

function onToggle(missionLayerConfig, globeContext) {
    const isBeingTurnedOff = !globeContext.visible
    if (isBeingTurnedOff) globeContext.toggleLayer(missionLayerConfig.name, false)
}

function destroy(layerName, globeContext) {
    globeContext.layers[layerName]?.mapLabelsLayer.destroy()
}

function setVisibility(layerName, isVisible, globeContext) {
    const mapLabelsEntry = globeContext.layers[layerName]
    if (!mapLabelsEntry) return
    mapLabelsEntry.visible = isVisible
    mapLabelsEntry.mapLabelsLayer.setVisible(isVisible)
}

function setOpacity(layerName, opacity, globeContext) {
    globeContext.layers[layerName]?.mapLabelsLayer.setOpacity(opacity)
}

export default {
    make,
    onToggle,
    destroy,
    setVisibility,
    setOpacity,
}

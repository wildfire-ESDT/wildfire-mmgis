/**
 * Photorealistic 3D Tiles from Cesium ion on the Cesium globe, the layer type's
 * entry. While visible, it hides the globe surface, shows the provider's
 * required credits, drapes the chosen layers over the mesh and turns its linked
 * layers on with it.
 */
import L_ from '@basics/Layers_/Layers_'
import { ION_PHOTOREALISTIC_LAYER_TYPE } from '../logic/constants'
import { tilesetSettingsFrom } from '../logic/tilesetSettings'
import { drapeLayersOnTileset } from '../render/drapedLayers'
import { updateGlobeSurfaceAndCreditBar } from '../render/globeSurface'
import {
    applyTilesetOpacity,
    loadPhotorealisticTileset,
    whenReadyToShow,
} from '../render/photorealisticTileset'
import { setLinkedLayersOn } from './linkedLayers'

// The Cesium ion access token is deployment-wide and comes from the server
// environment, never from the mission config.
function getIonAccessToken() {
    return process.env.CESIUM_ION_ACCESS_TOKEN || ''
}

// A hidden tileset stays loaded, so turning it back on only shows it.
function make(missionLayerConfig, globeContext) {
    const tilesetSettings = tilesetSettingsFrom(missionLayerConfig)
    setLinkedLayersOn(tilesetSettings.linkedLayerNames, true)
    if (globeContext.hasLayer(missionLayerConfig.name))
        return globeContext.toggleLayer(missionLayerConfig.name, true)
    return render(
        {
            ...tilesetSettings,
            opacity: L_.layers.opacity[missionLayerConfig.name] ?? 1,
            drapedLayerIds: tilesetSettings.drapedLayerNames
                .map((drapedLayerName) => L_.asLayerUUID(drapedLayerName))
                .filter((drapedLayerId) => drapedLayerId != null),
        },
        globeContext
    )
}

function onToggle(missionLayerConfig, globeContext) {
    const isBeingTurnedOff = !globeContext.visible
    if (isBeingTurnedOff) {
        globeContext.toggleLayer(missionLayerConfig.name, false)
        setLinkedLayersOn(
            tilesetSettingsFrom(missionLayerConfig).linkedLayerNames,
            false
        )
    }
}

async function render(tilesetSettings, globeContext) {
    const {
        renderer: cesiumViewer,
        layers: globeLayersByName,
        loadingLayers: layersCurrentlyLoading,
    } = globeContext
    const { layerName } = tilesetSettings

    if (layersCurrentlyLoading[layerName]) return
    const ionAccessToken = getIonAccessToken()
    if (!ionAccessToken) {
        console.error(
            `Photorealistic tiles layer "${layerName}": no Cesium ion access token (set CESIUM_ION_ACCESS_TOKEN on the server).`
        )
        return
    }
    layersCurrentlyLoading[layerName] = true

    try {
        const photorealisticTileset = await loadPhotorealisticTileset(
            tilesetSettings.ionAssetId,
            ionAccessToken,
            tilesetSettings.maximumScreenSpaceError
        )
        delete layersCurrentlyLoading[layerName]

        photorealisticTileset.show = false
        cesiumViewer.scene.primitives.add(photorealisticTileset)

        const tilesEntry = {
            type: ION_PHOTOREALISTIC_LAYER_TYPE,
            kind: 'tileset',
            tileset: photorealisticTileset,
            visible: true,
            isReadyToShow: false,
            hideGlobeSurface: tilesetSettings.hideGlobeSurface,
            opacity: tilesetSettings.opacity,
            stopDrapingLayers: drapeLayersOnTileset(
                photorealisticTileset,
                tilesetSettings.drapedLayerIds,
                tilesetSettings.drapedOpacity,
                globeContext
            ),
        }
        globeLayersByName[layerName] = tilesEntry
        applyTilesetOpacity(photorealisticTileset, tilesEntry.opacity)

        whenReadyToShow(photorealisticTileset, () => {
            tilesEntry.isReadyToShow = true
            photorealisticTileset.show = tilesEntry.visible
            updateGlobeSurfaceAndCreditBar(globeContext)
        })
    } catch (loadError) {
        delete layersCurrentlyLoading[layerName]
        console.error(
            `Failed to load photorealistic tiles layer "${layerName}":`,
            loadError
        )
    }
}

// Core deletes the entry after this returns, so mark it hidden first.
function destroy(layerName, globeContext) {
    const tilesEntry = globeContext.layers[layerName]
    if (!tilesEntry) return
    tilesEntry.visible = false
    tilesEntry.stopDrapingLayers?.()
    globeContext.renderer.scene.primitives.remove(tilesEntry.tileset)
    updateGlobeSurfaceAndCreditBar(globeContext)
}

function setVisibility(layerName, isVisible, globeContext) {
    const tilesEntry = globeContext.layers[layerName]
    if (!tilesEntry) return
    tilesEntry.visible = isVisible
    tilesEntry.tileset.show = isVisible && tilesEntry.isReadyToShow
    updateGlobeSurfaceAndCreditBar(globeContext)
}

function setOpacity(layerName, opacity, globeContext) {
    const tilesEntry = globeContext.layers[layerName]
    if (!tilesEntry) return
    tilesEntry.opacity = opacity
    applyTilesetOpacity(tilesEntry.tileset, opacity)
    globeContext.requestRender()
}

export default {
    make,
    onToggle,
    render,
    destroy,
    setVisibility,
    setOpacity,
}

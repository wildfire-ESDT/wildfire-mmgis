/**
 * Photorealistic 3D Tiles from Cesium ion on the Cesium globe. While visible,
 * hides the globe surface, shows the provider's required credits, and drapes
 * the chosen layers over the mesh.
 */
import * as Cesium from 'cesium'
import L_ from '@basics/Layers_/Layers_'

const ION_PHOTOREALISTIC_LAYER_TYPE = 'ionphotorealistic'

// Toggled on the viewer container while any such layer is visible, so the
// credits hidden globally in mmgis.css show for tilesets that require on-screen
// attribution (Google Photorealistic 3D Tiles served through Cesium ion).
const CREDITS_CLASS = 'mmgis-cesium-credits'

// The Cesium ion access token is deployment-wide and comes from the server
// environment, never from the mission config.
function getIonAccessToken() {
    return process.env.CESIUM_ION_ACCESS_TOKEN || ''
}

function buildTilesetSettings(missionLayerConfig) {
    const drapedLayerNames = missionLayerConfig.drapedLayers || []
    return {
        layerName: missionLayerConfig.name,
        ionAssetId: Number(missionLayerConfig.ionAssetId) || 2275207,
        opacity: L_.layers.opacity[missionLayerConfig.name] ?? 1,
        // Configure saves an empty number field as "", which must mean 16.
        maximumScreenSpaceError:
            Number(missionLayerConfig.maximumScreenSpaceError) || 16,
        hideGlobeSurface: missionLayerConfig.hideGlobe !== false,
        drapedLayerIds: drapedLayerNames
            .map((drapedLayerName) => L_.asLayerUUID(drapedLayerName))
            .filter((drapedLayerId) => drapedLayerId != null),
    }
}

// A hidden tileset stays loaded, so turning it back on only shows it.
function make(missionLayerConfig, globeContext) {
    if (globeContext.hasLayer(missionLayerConfig.name))
        return globeContext.toggleLayer(missionLayerConfig.name, true)
    return render(buildTilesetSettings(missionLayerConfig), globeContext)
}

function onToggle(missionLayerConfig, globeContext) {
    const isBeingTurnedOff = !globeContext.visible
    if (isBeingTurnedOff)
        globeContext.toggleLayer(missionLayerConfig.name, false)
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
        const ionResource = await Cesium.IonResource.fromAssetId(
            Number(tilesetSettings.ionAssetId),
            { accessToken: ionAccessToken }
        )
        const photorealisticTileset = await Cesium.Cesium3DTileset.fromUrl(
            ionResource,
            {
                maximumScreenSpaceError:
                    tilesetSettings.maximumScreenSpaceError,
                // Providers like Google require attribution on screen, not
                // only in Cesium's "Data attribution" lightbox.
                showCreditsOnScreen: true,
                preloadWhenHidden: true,
            }
        )
        delete layersCurrentlyLoading[layerName]

        // Hidden until the first view has fully loaded, so it never shows blurry.
        photorealisticTileset.show = false
        cesiumViewer.scene.primitives.add(photorealisticTileset)

        const tilesEntry = {
            type: ION_PHOTOREALISTIC_LAYER_TYPE,
            kind: 'tileset',
            tileset: photorealisticTileset,
            visible: true,
            initialViewHasLoaded: false,
            hideGlobeSurface: tilesetSettings.hideGlobeSurface,
            opacity: tilesetSettings.opacity,
            stopDrapingLayers: drapeLayersOnTileset(
                photorealisticTileset,
                tilesetSettings.drapedLayerIds,
                globeContext
            ),
        }
        globeLayersByName[layerName] = tilesEntry
        applyTilesetOpacity(tilesEntry)

        photorealisticTileset.initialTilesLoaded.addEventListener(() => {
            tilesEntry.initialViewHasLoaded = true
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
    tilesEntry.tileset.show =
        isVisible && tilesEntry.initialViewHasLoaded
    updateGlobeSurfaceAndCreditBar(globeContext)
}

function setOpacity(layerName, opacity, globeContext) {
    const tilesEntry = globeContext.layers[layerName]
    if (!tilesEntry) return
    tilesEntry.opacity = opacity
    applyTilesetOpacity(tilesEntry)
    globeContext.requestRender()
}

function applyTilesetOpacity(tilesEntry) {
    const isFaded = tilesEntry.opacity < 1
    tilesEntry.tileset.style = isFaded
        ? new Cesium.Cesium3DTileStyle({
              color: `color("white", ${tilesEntry.opacity})`,
          })
        : undefined
}

// The chosen layers' globe imagery is replaced whenever they are toggled,
// restyled or reloaded, so any change marks the copies for updating on the
// next frame, where only the differences are applied.
function drapeLayersOnTileset(tileset, drapedLayerIds, globeContext) {
    const globeImageryLayers = globeContext.renderer.imageryLayers
    const tilesetImageryLayers = tileset.imageryLayers
    const tilesetCopyByGlobeLayer = new Map()
    let copiesNeedUpdating = true

    const findGlobeImageryLayersOf = (drapedLayerId) => {
        const globeLayerEntry = globeContext.layers[drapedLayerId]
        if (globeLayerEntry?.kind === 'imagery') return [globeLayerEntry.layer]
        if (globeLayerEntry?.kind === 'sliced')
            return globeLayerEntry.slicedLayer.globeImageryLayers
        return []
    }

    const updateCopies = () => {
        const globeLayersToDrape = drapedLayerIds
            .flatMap(findGlobeImageryLayersOf)
            .filter((globeLayer) => globeImageryLayers.contains(globeLayer))
            .sort(
                (globeLayerA, globeLayerB) =>
                    globeImageryLayers.indexOf(globeLayerA) -
                    globeImageryLayers.indexOf(globeLayerB)
            )

        for (const [globeLayer, tilesetCopy] of tilesetCopyByGlobeLayer) {
            if (globeLayersToDrape.includes(globeLayer)) continue
            tilesetImageryLayers.remove(tilesetCopy)
            tilesetCopyByGlobeLayer.delete(globeLayer)
        }

        globeLayersToDrape.forEach((globeLayer, index) => {
            const existingCopy = tilesetCopyByGlobeLayer.get(globeLayer)
            if (!existingCopy) {
                const tilesetCopy = new Cesium.ImageryLayer(
                    globeLayer.imageryProvider,
                    {
                        alpha: globeLayer.alpha,
                        show: globeLayer.show,
                    }
                )
                tilesetImageryLayers.add(tilesetCopy, index)
                tilesetCopyByGlobeLayer.set(globeLayer, tilesetCopy)
            } else if (tilesetImageryLayers.indexOf(existingCopy) !== index) {
                tilesetImageryLayers.remove(existingCopy, false)
                tilesetImageryLayers.add(existingCopy, index)
            }
        })
    }

    // Opacity changes fire no event, so check each frame.
    const updateCopiesAndSyncOpacityAndVisibility = () => {
        if (copiesNeedUpdating) {
            copiesNeedUpdating = false
            updateCopies()
        }
        for (const [globeLayer, tilesetCopy] of tilesetCopyByGlobeLayer) {
            if (tilesetCopy.alpha !== globeLayer.alpha)
                tilesetCopy.alpha = globeLayer.alpha
            if (tilesetCopy.show !== globeLayer.show)
                tilesetCopy.show = globeLayer.show
        }
    }

    const markCopiesForUpdating = () => {
        copiesNeedUpdating = true
        globeContext.requestRender()
    }

    const removeListeners = [
        globeImageryLayers.layerAdded.addEventListener(markCopiesForUpdating),
        globeImageryLayers.layerRemoved.addEventListener(markCopiesForUpdating),
        globeImageryLayers.layerMoved.addEventListener(markCopiesForUpdating),
        globeImageryLayers.layerShownOrHidden.addEventListener(
            markCopiesForUpdating
        ),
        globeContext.renderer.scene.preRender.addEventListener(
            updateCopiesAndSyncOpacityAndVisibility
        ),
    ]
    globeContext.requestRender()
    return () => {
        removeListeners.forEach((removeListener) => removeListener())
        tilesetImageryLayers.removeAll()
    }
}

function updateGlobeSurfaceAndCreditBar(globeContext) {
    const shownEntries = Object.values(globeContext.layers).filter(
        (globeLayerEntry) =>
            globeLayerEntry.type === ION_PHOTOREALISTIC_LAYER_TYPE &&
            globeLayerEntry.visible &&
            globeLayerEntry.initialViewHasLoaded
    )
    globeContext.renderer.scene.globe.show = !shownEntries.some(
        (entry) => entry.hideGlobeSurface
    )
    globeContext.renderer.container?.classList.toggle(
        CREDITS_CLASS,
        shownEntries.length > 0
    )
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


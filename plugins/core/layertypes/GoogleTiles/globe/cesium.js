/**
 * Google Photorealistic 3D Tiles on the Cesium globe. While visible, hides the
 * globe surface, shows Google's required credits, and drapes the chosen
 * layers over the mesh.
 */
import * as Cesium from 'cesium'
import L_ from '@basics/Layers_/Layers_'

const GOOGLE_TILES_LAYER_TYPE = 'googletiles'

function buildTilesetSettings(missionLayerConfig) {
    const drapedLayerNames = missionLayerConfig.drapedLayers || []
    return {
        layerName: missionLayerConfig.name,
        googleApiKey: missionLayerConfig.googleApiKey,
        opacity: L_.layers.opacity[missionLayerConfig.name] ?? 1,
        maximumScreenSpaceError:
            missionLayerConfig.maximumScreenSpaceError ?? 16,
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
    if (!tilesetSettings.googleApiKey) {
        console.error(`Google 3D Tiles layer "${layerName}" has no API key.`)
        return
    }
    layersCurrentlyLoading[layerName] = true

    try {
        const googleTileset = await Cesium.createGooglePhotorealistic3DTileset(
            {
                key: tilesetSettings.googleApiKey,
                onlyUsingWithGoogleGeocoder: true,
            },
            {
                maximumScreenSpaceError:
                    tilesetSettings.maximumScreenSpaceError,
                showCreditsOnScreen: true,
                preloadWhenHidden: true,
            }
        )
        delete layersCurrentlyLoading[layerName]

        // Hidden until the first view has fully loaded, so it never shows blurry.
        googleTileset.show = false
        cesiumViewer.scene.primitives.add(googleTileset)

        const googleTilesEntry = {
            type: GOOGLE_TILES_LAYER_TYPE,
            kind: 'tileset',
            tileset: googleTileset,
            visible: true,
            initialViewHasLoaded: false,
            hideGlobeSurface: tilesetSettings.hideGlobeSurface,
            opacity: tilesetSettings.opacity,
            stopDrapingLayers: drapeLayersOnTileset(
                googleTileset,
                tilesetSettings.drapedLayerIds,
                globeContext
            ),
        }
        globeLayersByName[layerName] = googleTilesEntry
        applyTilesetOpacity(googleTilesEntry)

        googleTileset.initialTilesLoaded.addEventListener(() => {
            googleTilesEntry.initialViewHasLoaded = true
            googleTileset.show = googleTilesEntry.visible
            updateGlobeSurfaceAndCreditBar(globeContext)
        })
    } catch (loadError) {
        delete layersCurrentlyLoading[layerName]
        console.error(
            `Failed to load Google 3D Tiles layer "${layerName}":`,
            loadError
        )
    }
}

// Core deletes the entry after this returns, so mark it hidden first.
function destroy(layerName, globeContext) {
    const googleTilesEntry = globeContext.layers[layerName]
    if (!googleTilesEntry) return
    googleTilesEntry.visible = false
    googleTilesEntry.stopDrapingLayers?.()
    globeContext.renderer.scene.primitives.remove(googleTilesEntry.tileset)
    updateGlobeSurfaceAndCreditBar(globeContext)
}

function setVisibility(layerName, isVisible, globeContext) {
    const googleTilesEntry = globeContext.layers[layerName]
    if (!googleTilesEntry) return
    googleTilesEntry.visible = isVisible
    googleTilesEntry.tileset.show =
        isVisible && googleTilesEntry.initialViewHasLoaded
    updateGlobeSurfaceAndCreditBar(globeContext)
}

function setOpacity(layerName, opacity, globeContext) {
    const googleTilesEntry = globeContext.layers[layerName]
    if (!googleTilesEntry) return
    googleTilesEntry.opacity = opacity
    applyTilesetOpacity(googleTilesEntry)
    globeContext.requestRender()
}

function applyTilesetOpacity(googleTilesEntry) {
    const isFaded = googleTilesEntry.opacity < 1
    googleTilesEntry.tileset.style = isFaded
        ? new Cesium.Cesium3DTileStyle({
              color: `color("white", ${googleTilesEntry.opacity})`,
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
    const shownGoogleTilesEntries = Object.values(globeContext.layers).filter(
        (globeLayerEntry) =>
            globeLayerEntry.type === GOOGLE_TILES_LAYER_TYPE &&
            globeLayerEntry.visible &&
            globeLayerEntry.initialViewHasLoaded
    )
    globeContext.renderer.scene.globe.show = !shownGoogleTilesEntries.some(
        (googleTilesEntry) => googleTilesEntry.hideGlobeSurface
    )

    const creditBarElement = globeContext.renderer.container.querySelector(
        '.cesium-widget-credits'
    )
    if (creditBarElement) {
        // Inline !important is the only way to beat mmgis.css's !important.
        if (shownGoogleTilesEntries.length > 0)
            creditBarElement.style.setProperty('display', 'block', 'important')
        else creditBarElement.style.removeProperty('display')
    }
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


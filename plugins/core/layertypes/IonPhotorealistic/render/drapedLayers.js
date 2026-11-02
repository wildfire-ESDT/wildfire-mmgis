// Draping the chosen layers onto the tileset: copies of their globe imagery,
// kept in the globe's order, visibility and (scaled) opacity.

import * as Cesium from 'cesium'
import { withoutCoarseImagery } from './coarseImageryFilter'

// The chosen layers' globe imagery is replaced whenever they are toggled,
// restyled or reloaded, so any change marks the copies for updating on the
// next frame, where only the differences are applied. Returns a function that
// stops draping.
export function drapeLayersOnTileset(
    tileset,
    drapedLayerIds,
    drapedOpacity,
    globeContext
) {
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
                    withoutCoarseImagery(globeLayer.imageryProvider),
                    {
                        alpha: globeLayer.alpha * drapedOpacity,
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
            const drapedAlpha = globeLayer.alpha * drapedOpacity
            if (tilesetCopy.alpha !== drapedAlpha)
                tilesetCopy.alpha = drapedAlpha
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

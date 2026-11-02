// What a layer's config asks of the tileset. Configure saves an empty number
// field as "", which must mean the field's default.

import {
    DEFAULT_DRAPED_OPACITY,
    DEFAULT_ION_ASSET_ID,
    DEFAULT_MAXIMUM_SCREEN_SPACE_ERROR,
    MINIMUM_DRAPED_IMAGERY_LEVEL,
} from './constants'

export function tilesetSettingsFrom(missionLayerConfig) {
    return {
        layerName: missionLayerConfig.name,
        ionAssetId:
            Number(missionLayerConfig.ionAssetId) || DEFAULT_ION_ASSET_ID,
        maximumScreenSpaceError:
            Number(missionLayerConfig.maximumScreenSpaceError) ||
            DEFAULT_MAXIMUM_SCREEN_SPACE_ERROR,
        hideGlobeSurface: missionLayerConfig.hideGlobe !== false,
        drapedLayerNames: missionLayerConfig.drapedLayers || [],
        drapedOpacity: drapedOpacityOf(missionLayerConfig),
        linkedLayerNames: missionLayerConfig.linkedLayers || [],
    }
}

// Draped layers are drawn partly see-through so the mesh under them still reads.
export function drapedOpacityOf(missionLayerConfig) {
    const configuredOpacity = Number(missionLayerConfig.drapedOpacity)
    if (
        missionLayerConfig.drapedOpacity === '' ||
        !Number.isFinite(configuredOpacity)
    )
        return DEFAULT_DRAPED_OPACITY
    return Math.min(Math.max(configuredOpacity, 0), 1)
}

// The coarsest imagery level draped on the mesh. A source that tops out sooner
// is let through from just below its own most detailed level.
export function lowestDrapedImageryLevel(imageryMaximumLevel) {
    return Math.min(
        MINIMUM_DRAPED_IMAGERY_LEVEL,
        (imageryMaximumLevel ?? Infinity) - 1
    )
}

// Loading the ion tileset, deciding when it is ready to show, and fading it.

import * as Cesium from 'cesium'
import { FIRST_TILES_GRACE_MS, TILE_CACHE_BYTES } from '../logic/constants'

export async function loadPhotorealisticTileset(
    ionAssetId,
    ionAccessToken,
    maximumScreenSpaceError
) {
    const ionResource = await Cesium.IonResource.fromAssetId(ionAssetId, {
        accessToken: ionAccessToken,
    })
    return Cesium.Cesium3DTileset.fromUrl(ionResource, {
        maximumScreenSpaceError,
        // Providers like Google require attribution on screen, not only in
        // Cesium's "Data attribution" lightbox.
        showCreditsOnScreen: true,
        preloadWhenHidden: true,
        cacheBytes: TILE_CACHE_BYTES,
    })
}

// Ready once the first view has loaded, or shortly after the first tile arrives
// if that is sooner; it then sharpens in place.
export function whenReadyToShow(tileset, onReadyToShow) {
    let isReadyToShow = false
    const becomeReadyToShow = () => {
        if (isReadyToShow) return
        isReadyToShow = true
        onReadyToShow()
    }
    tileset.initialTilesLoaded.addEventListener(becomeReadyToShow)
    const removeFirstTileListener = tileset.tileLoad.addEventListener(() => {
        removeFirstTileListener()
        setTimeout(becomeReadyToShow, FIRST_TILES_GRACE_MS)
    })
}

export function applyTilesetOpacity(tileset, opacity) {
    tileset.style =
        opacity < 1
            ? new Cesium.Cesium3DTileStyle({
                  color: `color("white", ${opacity})`,
              })
            : undefined
}

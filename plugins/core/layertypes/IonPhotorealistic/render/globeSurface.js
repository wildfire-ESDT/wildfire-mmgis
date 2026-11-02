// While any photorealistic tileset is showing, the plain globe is hidden under
// it (if that layer asks) and the provider's credits are shown.

import {
    CREDITS_CLASS,
    ION_PHOTOREALISTIC_LAYER_TYPE,
} from '../logic/constants'

export function updateGlobeSurfaceAndCreditBar(globeContext) {
    const shownEntries = Object.values(globeContext.layers).filter(
        (globeLayerEntry) =>
            globeLayerEntry.type === ION_PHOTOREALISTIC_LAYER_TYPE &&
            globeLayerEntry.visible &&
            globeLayerEntry.isReadyToShow
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

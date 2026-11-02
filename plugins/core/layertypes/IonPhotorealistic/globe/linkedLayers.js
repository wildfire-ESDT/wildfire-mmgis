// Turning the layers linked to a tileset on and off with it.

import L_ from '@basics/Layers_/Layers_'

// Deferred so the tileset's own toggle finishes before the linked ones start.
export function setLinkedLayersOn(linkedLayerNames, shouldBeOn) {
    setTimeout(() => {
        for (const linkedLayerName of linkedLayerNames) {
            const linkedLayerId = L_.asLayerUUID(linkedLayerName)
            const linkedLayer = L_.layers.data[linkedLayerId]
            if (
                linkedLayer &&
                Boolean(L_.layers.on[linkedLayerId]) !== shouldBeOn
            )
                L_.toggleLayer(linkedLayer)
        }
    }, 0)
}

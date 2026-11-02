// An imagery source for draping that answers coarse requests with a
// transparent tile, so the coarse mesh tiles shown first stay bare.

import { DEFAULT_IMAGERY_TILE_PIXELS } from '../logic/constants'
import { lowestDrapedImageryLevel } from '../logic/tilesetSettings'

export function withoutCoarseImagery(imageryProvider) {
    const lowestDrapedLevel = lowestDrapedImageryLevel(
        imageryProvider.maximumLevel
    )
    return new Proxy(imageryProvider, {
        get(target, property) {
            if (property === 'requestImage')
                return (x, y, level, request) =>
                    level < lowestDrapedLevel
                        ? Promise.resolve(transparentTileFor(target))
                        : target.requestImage(x, y, level, request)
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
        },
    })
}

const transparentTilesBySize = new Map()
function transparentTileFor(imageryProvider) {
    const width = imageryProvider.tileWidth || DEFAULT_IMAGERY_TILE_PIXELS
    const height = imageryProvider.tileHeight || DEFAULT_IMAGERY_TILE_PIXELS
    const sizeKey = `${width}x${height}`
    if (!transparentTilesBySize.has(sizeKey)) {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        transparentTilesBySize.set(sizeKey, canvas)
    }
    return transparentTilesBySize.get(sizeKey)
}

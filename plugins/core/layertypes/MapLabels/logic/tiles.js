// Web Mercator tile math, and the "tileZoom/x/y@labelDetailZoom" keys the layer tracks tiles by.

import { EARTH_CIRCUMFERENCE_METERS, MAXIMUM_LABEL_DETAIL_ZOOM, MAXIMUM_TILES_IN_VIEW } from './constants'

export function cameraZoomAt(cameraHeightMeters) {
    return Math.log2(EARTH_CIRCUMFERENCE_METERS / Math.max(cameraHeightMeters, 1))
}

export function tileKeyOf(tileZoom, tileX, tileY, labelDetailZoom) {
    return `${tileZoom}/${tileX}/${tileY}@${labelDetailZoom}`
}

export function parseTileKey(tileKey) {
    const [tilePart, labelDetailPart] = tileKey.split('@')
    const [tileZoom, tileX, tileY] = tilePart.split('/').map(Number)
    return { tilePart, tileZoom, tileX, tileY, labelDetailZoom: Number(labelDetailPart) }
}

/**
 * The keys of the tiles covering a view (bounds in degrees). A tilted view can reach the horizon, so the tile
 * zoom steps down until the view fits in a sensible number of tiles instead of loading nothing.
 */
export function tileKeysInView(viewBounds, cameraZoom, maximumTileZoom) {
    const labelDetailZoom = Math.min(Math.floor(cameraZoom), MAXIMUM_LABEL_DETAIL_ZOOM)
    let tileZoom = Math.min(Math.floor(cameraZoom), maximumTileZoom)
    let tileRange = tileRangeForBounds(viewBounds, tileZoom)
    while (tileRange.count > MAXIMUM_TILES_IN_VIEW && tileZoom > 0) {
        tileZoom -= 1
        tileRange = tileRangeForBounds(viewBounds, tileZoom)
    }

    const tileKeys = new Set()
    for (let tileX = tileRange.minimumX; tileX <= tileRange.maximumX; tileX++) {
        for (let tileY = tileRange.minimumY; tileY <= tileRange.maximumY; tileY++) {
            tileKeys.add(tileKeyOf(tileZoom, tileX, tileY, labelDetailZoom))
        }
    }
    return tileKeys
}

export function tileXAt(longitude, zoom) {
    return Math.floor(((longitude + 180) / 360) * Math.pow(2, zoom))
}

export function tileYAt(latitude, zoom) {
    const latitudeRadians = (Math.max(Math.min(latitude, 85.0511), -85.0511) * Math.PI) / 180
    return Math.floor(((1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) / 2)
        * Math.pow(2, zoom))
}

export function tileRangeForBounds(bounds, zoom) {
    const tilesAcross = Math.pow(2, zoom)
    const minimumX = Math.max(0, tileXAt(bounds.west, zoom))
    const maximumX = Math.min(tilesAcross - 1, tileXAt(bounds.east, zoom))
    const minimumY = Math.max(0, tileYAt(bounds.north, zoom))
    const maximumY = Math.min(tilesAcross - 1, tileYAt(bounds.south, zoom))
    return {
        minimumX, maximumX, minimumY, maximumY,
        count: Math.max(0, maximumX - minimumX + 1) * Math.max(0, maximumY - minimumY + 1),
    }
}

export function tileContainsPoint(tileZoom, tileX, tileY, longitude, latitude) {
    return tileXAt(longitude, tileZoom) === tileX && tileYAt(latitude, tileZoom) === tileY
}

/** Whether bounds in degrees contain a point; bounds whose west is past their east cross the antimeridian. */
export function boundsContain(bounds, longitude, latitude) {
    const { west, east, south, north } = bounds
    return latitude >= south && latitude <= north
        && (west <= east ? longitude >= west && longitude <= east : longitude >= west || longitude <= east)
}

/** Whether two tile keys cover any of the same ground. */
export function tilesOverlap(tileKeyA, tileKeyB) {
    const tileA = parseTileKey(tileKeyA)
    const tileB = parseTileKey(tileKeyB)
    const sharedZoom = Math.min(tileA.tileZoom, tileB.tileZoom)
    return tileA.tileX >> (tileA.tileZoom - sharedZoom) === tileB.tileX >> (tileB.tileZoom - sharedZoom)
        && tileA.tileY >> (tileA.tileZoom - sharedZoom) === tileB.tileY >> (tileB.tileZoom - sharedZoom)
}

/** The old tiles whose whole area is covered by needed tiles that are drawn. */
export function replacedStaleTileKeys(staleTileKeys, neededTileKeys, isTileDrawn) {
    return staleTileKeys.filter((staleTileKey) => neededTileKeys
        .filter((neededTileKey) => tilesOverlap(neededTileKey, staleTileKey))
        .every(isTileDrawn))
}

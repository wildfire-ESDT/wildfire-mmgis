// What each vector tile feature becomes: label specs (text, spot, look, rank) and freeway line paths.
// A tile is { tileZoom, tileX, tileY, labelDetailZoom }.

import {
    BIG_CITY_MINIMUM_ZOOM,
    DEFAULT_PLACE_MINIMUM_ZOOM,
    DEFAULT_PLACE_PRIORITY,
    DEFAULT_PLACE_STYLE,
    FREEWAY_NAME_PRIORITY,
    FREEWAY_NAME_STYLE,
    PLACE_CLASS_MAXIMUM_ZOOM,
    PLACE_CLASS_MINIMUM_ZOOM,
    PLACE_CLASS_PRIORITY,
    PLACE_CLASS_STYLE,
    PLACE_LABEL_COLOR,
    ROAD_LINE_CLASS_STYLE,
    ROAD_NAME_CLASS_MINIMUM_ZOOM,
    ROAD_NAME_PRIORITY,
    ROAD_NAME_SPACING_TILES,
    ROAD_NAME_STYLE,
} from './constants'
import { linePiecesOf, pointsAlongLine } from './lines'
import { tileContainsPoint } from './tiles'

export function placeLabelsIn(placeLayer, { tileZoom, tileX, tileY, labelDetailZoom }) {
    const labelSpecs = []
    for (let index = 0; index < placeLayer.length; index++) {
        const feature = placeLayer.feature(index)
        const { name, name_en: englishName, class: placeClass, rank } = feature.properties
        if (!name) continue
        if (labelDetailZoom < placeMinimumZoom(placeClass, rank)) continue
        if (labelDetailZoom > (PLACE_CLASS_MAXIMUM_ZOOM[placeClass] ?? Infinity)) continue
        const geometry = feature.toGeoJSON(tileX, tileY, tileZoom).geometry
        if (geometry.type !== 'Point') continue
        const [longitude, latitude] = geometry.coordinates
        // Tiles repeat places just past their edges; the tile the place is in labels it.
        if (!tileContainsPoint(tileZoom, tileX, tileY, longitude, latitude)) continue
        const text = englishName || name
        const isRegion = placeClass === 'state' || placeClass === 'province'
        labelSpecs.push({
            ...(PLACE_CLASS_STYLE[placeClass] || DEFAULT_PLACE_STYLE),
            text: isRegion ? text.toUpperCase() : text,
            longitude,
            latitude,
            color: PLACE_LABEL_COLOR,
            priority: placePriority(placeClass, rank),
        })
    }
    return labelSpecs
}

/** A road's name repeats along it, so it stays on screen when zoomed in closer than a tile; never closer to itself. */
export function roadNameLabelsIn(roadNameLayer, { tileZoom, tileX, tileY, labelDetailZoom }) {
    const labelSpecs = []
    const spacingDegrees = (360 / Math.pow(2, labelDetailZoom)) * ROAD_NAME_SPACING_TILES
    const placedPositionsByText = new Map()
    for (let index = 0; index < roadNameLayer.length; index++) {
        const feature = roadNameLayer.feature(index)
        const { name, class: roadClass, subclass } = feature.properties
        // Freeway exits come as points carrying the exit number; they aren't road names.
        if (subclass === 'junction') continue
        const minimumZoom = ROAD_NAME_CLASS_MINIMUM_ZOOM[roadClass]
        if (minimumZoom === undefined || labelDetailZoom < minimumZoom) continue
        // Freeways read better by route (I-10) than by long names.
        const isFreeway = roadClass === 'motorway' || roadClass === 'trunk'
        const text = (isFreeway && routeLabel(feature.properties)) || name
        if (!text) continue
        if (!placedPositionsByText.has(text)) placedPositionsByText.set(text, [])
        const placedPositions = placedPositionsByText.get(text)
        for (const piece of linePiecesOf(feature.toGeoJSON(tileX, tileY, tileZoom).geometry)) {
            for (const [longitude, latitude] of pointsAlongLine(piece, spacingDegrees)) {
                if (!tileContainsPoint(tileZoom, tileX, tileY, longitude, latitude)) continue
                const isNearSameName = placedPositions.some(([placedLongitude, placedLatitude]) =>
                    Math.hypot(longitude - placedLongitude, latitude - placedLatitude) < spacingDegrees)
                if (isNearSameName) continue
                placedPositions.push([longitude, latitude])
                labelSpecs.push({
                    ...(isFreeway ? FREEWAY_NAME_STYLE : ROAD_NAME_STYLE),
                    text,
                    longitude,
                    latitude,
                    priority: isFreeway ? FREEWAY_NAME_PRIORITY : ROAD_NAME_PRIORITY,
                })
            }
        }
    }
    return labelSpecs
}

export function freewayLinesIn(roadLayer, { tileZoom, tileX, tileY, labelDetailZoom }) {
    const lineSpecs = []
    for (let index = 0; index < roadLayer.length; index++) {
        const feature = roadLayer.feature(index)
        const style = ROAD_LINE_CLASS_STYLE[feature.properties.class]
        if (!style || labelDetailZoom < style.minimumZoom || feature.properties.brunnel === 'tunnel') continue
        for (const piece of linePiecesOf(feature.toGeoJSON(tileX, tileY, tileZoom).geometry)) {
            if (piece.length < 2) continue
            lineSpecs.push({ coordinates: piece, widthPixels: style.widthPixels, color: style.color })
        }
    }
    return lineSpecs
}

/** Cities show from the zoom of their rank (bigger cities, lower ranks, sooner) until the city zoom. */
export function placeMinimumZoom(placeClass, rank) {
    if (placeClass === 'city' && rank != null) {
        return Math.min(Math.max(rank, BIG_CITY_MINIMUM_ZOOM), PLACE_CLASS_MINIMUM_ZOOM.city)
    }
    return PLACE_CLASS_MINIMUM_ZOOM[placeClass] ?? DEFAULT_PLACE_MINIMUM_ZOOM
}

export function placePriority(placeClass, rank) {
    if (placeClass === 'city') return PLACE_CLASS_PRIORITY.city + Math.min(rank ?? 9, 9) / 10
    return PLACE_CLASS_PRIORITY[placeClass] ?? DEFAULT_PLACE_PRIORITY
}

/** A freeway's route as signs show it (I-10, US 101, CA 2), or null without a route number. */
export function routeLabel({ ref: routeNumber, network }) {
    if (!routeNumber) return null
    if (network === 'us-interstate') return `I-${routeNumber}`
    if (network === 'us-highway') return `US ${routeNumber}`
    if (network === 'us-state') return `CA ${routeNumber}`
    return /^\d+[A-Z]?$/.test(routeNumber) ? null : routeNumber
}

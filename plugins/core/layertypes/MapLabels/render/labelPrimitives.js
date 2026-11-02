// Turning label and line specs into Cesium labels and ground polylines.

import * as Cesium from 'cesium'
import {
    LABEL_FONT_FAMILY,
    LABEL_LIFT_PIXELS,
    LABEL_OUTLINE_ALPHA,
    LABEL_OUTLINE_WIDTH_PIXELS,
    ROAD_LINE_ALPHA,
} from '../logic/constants'
import { labelBoxSize } from '../logic/labelLayout'

/** Adds a spec's label to the collection and returns what the layout needs about it. */
export function addLabel(labelCollection, labelSpec, { fontSizePixels, opacity }) {
    const { text, longitude, latitude, fontScale, fontWeight, farthestMeters, color, priority } = labelSpec
    const labelFontSizePixels = Math.round(fontSizePixels * fontScale)
    const label = labelCollection.add({
        // Shown by the layout once it is known not to overlap another label.
        show: false,
        text,
        position: Cesium.Cartesian3.fromDegrees(longitude, latitude),
        // Not clamped: the collection reuses removed labels' letters, and a clamped letter keeps its old
        // spot until the ground height under its new one loads. Drawn over everything, height doesn't show.
        heightReference: Cesium.HeightReference.NONE,
        font: `${fontWeight} ${labelFontSizePixels}px ${LABEL_FONT_FAMILY}`,
        fillColor: Cesium.Color.fromCssColorString(color).withAlpha(opacity),
        outlineColor: Cesium.Color.BLACK.withAlpha(LABEL_OUTLINE_ALPHA * opacity),
        outlineWidth: LABEL_OUTLINE_WIDTH_PIXELS,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -LABEL_LIFT_PIXELS),
        // Always drawn over buildings and terrain, never hidden inside them.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, farthestMeters),
    })
    return { label, longitude, latitude, priority, ...labelBoxSize(text, labelFontSizePixels) }
}

/** One primitive for a tile's freeway lines, or null without any. They classify terrain and 3D Tiles both. */
export function createFreewayLinesPrimitive(lineSpecs, opacity) {
    if (lineSpecs.length === 0) return null
    return new Cesium.GroundPolylinePrimitive({
        geometryInstances: lineSpecs.map((lineSpec) => new Cesium.GeometryInstance({
            geometry: new Cesium.GroundPolylineGeometry({
                positions: Cesium.Cartesian3.fromDegreesArray(lineSpec.coordinates.flat()),
                width: lineSpec.widthPixels,
            }),
            attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                    Cesium.Color.fromCssColorString(lineSpec.color).withAlpha(ROAD_LINE_ALPHA * opacity)
                ),
            },
        })),
        appearance: new Cesium.PolylineColorAppearance(),
        classificationType: Cesium.ClassificationType.BOTH,
    })
}

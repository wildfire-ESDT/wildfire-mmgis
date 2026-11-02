// Where the camera is and looks, saved so the layer can tell when it has moved since its last update.

import * as Cesium from 'cesium'

export function createCameraSnapshot() {
    return { position: new Cesium.Cartesian3(), direction: new Cesium.Cartesian3() }
}

export function saveCamera(camera, cameraSnapshot) {
    Cesium.Cartesian3.clone(camera.positionWC, cameraSnapshot.position)
    Cesium.Cartesian3.clone(camera.directionWC, cameraSnapshot.direction)
}

export function cameraMovedSince(camera, cameraSnapshot) {
    return !Cesium.Cartesian3.equalsEpsilon(camera.positionWC, cameraSnapshot.position, 0, 1)
        || !Cesium.Cartesian3.equalsEpsilon(camera.directionWC, cameraSnapshot.direction, 1e-5)
}

/** The part of the ellipsoid in view, in degrees, or null when none of it is. */
export function viewBoundsOf(camera, ellipsoid) {
    const viewRectangle = camera.computeViewRectangle(ellipsoid)
    if (!viewRectangle) return null
    return {
        west: Cesium.Math.toDegrees(viewRectangle.west),
        south: Cesium.Math.toDegrees(viewRectangle.south),
        east: Cesium.Math.toDegrees(viewRectangle.east),
        north: Cesium.Math.toDegrees(viewRectangle.north),
    }
}

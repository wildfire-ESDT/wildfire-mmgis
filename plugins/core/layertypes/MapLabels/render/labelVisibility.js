// Which labels show this frame. Labels are drawn through everything, so the ones out of view or past the
// horizon are hidden here, and of the rest only those that fit without overlapping show.

import * as Cesium from 'cesium'
import { STALE_LABEL_PRIORITY_PENALTY } from '../logic/constants'
import { labelsThatFit } from '../logic/labelLayout'
import { boundsContain } from '../logic/tiles'
import { viewBoundsOf } from './camera'

/** Shows and hides the tiles' labels; old tiles' labels yield to the new ones. Returns whether any changed. */
export function showLabelsThatFit(scene, shownTiles, staleTiles) {
    const camera = scene.camera
    const ellipsoid = scene.globe.ellipsoid
    const viewBounds = viewBoundsOf(camera, ellipsoid)
    const horizon = new Cesium.EllipsoidalOccluder(ellipsoid, camera.positionWC)
    let anyLabelChanged = false
    const setShown = (label, isShown) => {
        if (label.show === isShown) return
        label.show = isShown
        anyLabelChanged = true
    }

    const candidates = []
    const addCandidates = (tile, priorityPenalty) => {
        for (const labelEntry of tile.labelEntries) {
            const { label } = labelEntry
            const isOutOfSight = (viewBounds && !boundsContain(viewBounds, labelEntry.longitude, labelEntry.latitude))
                || !horizon.isPointVisible(label.position)
                || Cesium.Cartesian3.distance(camera.positionWC, label.position) > label.distanceDisplayCondition.far
            const windowPosition = isOutOfSight
                ? undefined
                : Cesium.SceneTransforms.worldToWindowCoordinates(scene, label.position)
            if (!windowPosition) {
                setShown(label, false)
                continue
            }
            candidates.push({
                labelEntry,
                priority: labelEntry.priority + priorityPenalty,
                isShown: label.show,
                windowX: windowPosition.x,
                windowY: windowPosition.y,
                halfWidthPixels: labelEntry.halfWidthPixels,
                heightPixels: labelEntry.heightPixels,
            })
        }
    }
    shownTiles.forEach((tile) => addCandidates(tile, 0))
    staleTiles.forEach((tile) => addCandidates(tile, STALE_LABEL_PRIORITY_PENALTY))

    const fittingCandidates = labelsThatFit(candidates)
    for (const candidate of candidates) setShown(candidate.labelEntry.label, fittingCandidates.has(candidate))
    return anyLabelChanged
}

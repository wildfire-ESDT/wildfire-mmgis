// Keeping labels apart on screen: each label's box, and which labels fit where boxes overlap.

import {
    LABEL_BOX_PADDING_PIXELS,
    LABEL_HALF_WIDTH_EMS_PER_CHARACTER,
    LABEL_LINE_HEIGHT_EMS,
    SCREEN_AREA_CELL_PIXELS,
} from './constants'

export function labelBoxSize(text, fontSizePixels) {
    return {
        halfWidthPixels: text.length * fontSizePixels * LABEL_HALF_WIDTH_EMS_PER_CHARACTER + LABEL_BOX_PADDING_PIXELS,
        heightPixels: Math.round(fontSizePixels * LABEL_LINE_HEIGHT_EMS) + LABEL_BOX_PADDING_PIXELS,
    }
}

/**
 * The candidates that fit, given { priority, isShown, windowX, windowY, halfWidthPixels, heightPixels } with the
 * window spot at the bottom middle of the label. Where boxes overlap the lower priority wins, and labels already
 * showing win ties so they don't swap places as the camera moves.
 */
export function labelsThatFit(candidates) {
    const rankedCandidates = [...candidates].sort((candidateA, candidateB) => candidateA.priority - candidateB.priority
        || Number(candidateB.isShown) - Number(candidateA.isShown))
    const takenAreas = new ScreenAreaGrid()
    const fittingCandidates = new Set()
    for (const candidate of rankedCandidates) {
        const area = {
            left: candidate.windowX - candidate.halfWidthPixels,
            right: candidate.windowX + candidate.halfWidthPixels,
            top: candidate.windowY - candidate.heightPixels,
            bottom: candidate.windowY,
        }
        if (takenAreas.overlaps(area)) continue
        takenAreas.add(area)
        fittingCandidates.add(candidate)
    }
    return fittingCandidates
}

/** Screen rectangles already taken by labels, bucketed so each check only looks nearby. */
class ScreenAreaGrid {
    constructor() {
        this._areasByCell = new Map()
    }

    _cellKeysOf(area) {
        const cellKeys = []
        const cellPixels = SCREEN_AREA_CELL_PIXELS
        for (let column = Math.floor(area.left / cellPixels); column <= Math.floor(area.right / cellPixels); column++) {
            for (let row = Math.floor(area.top / cellPixels); row <= Math.floor(area.bottom / cellPixels); row++) {
                cellKeys.push(`${column},${row}`)
            }
        }
        return cellKeys
    }

    overlaps(area) {
        return this._cellKeysOf(area).some((cellKey) => (this._areasByCell.get(cellKey) || []).some((takenArea) =>
            area.left < takenArea.right && area.right > takenArea.left
            && area.top < takenArea.bottom && area.bottom > takenArea.top))
    }

    add(area) {
        for (const cellKey of this._cellKeysOf(area)) {
            if (!this._areasByCell.has(cellKey)) this._areasByCell.set(cellKey, [])
            this._areasByCell.get(cellKey).push(area)
        }
    }
}

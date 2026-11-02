import * as Cesium from 'cesium'
import { resolveTileSource, VectorTileCache } from '../data/vectorTiles'
import {
    DEFAULT_FONT_SIZE_PIXELS,
    DEFAULT_MAXIMUM_TILE_ZOOM,
    LABEL_LAYOUT_INTERVAL_MS,
    LOWEST_LABEL_ZOOM,
    STALE_TILES_LIMIT_MS,
    TILE_UPDATE_INTERVAL_MS,
} from '../logic/constants'
import { freewayLinesIn, placeLabelsIn, roadNameLabelsIn } from '../logic/labelRules'
import { cameraZoomAt, parseTileKey, replacedStaleTileKeys, tileKeysInView } from '../logic/tiles'
import { cameraMovedSince, createCameraSnapshot, saveCamera, viewBoundsOf } from './camera'
import { addLabel, createFreewayLinesPrimitive } from './labelPrimitives'
import { showLabelsThatFit } from './labelVisibility'

/**
 * Place names, road names and freeway lines drawn as 3D objects on the Cesium globe from OpenMapTiles vector
 * tiles (e.g. OpenFreeMap). Labels are upright, face the camera and are drawn over terrain and buildings (3D Tiles
 * such as Google's photorealistic mesh), so they stay readable where a draped 2D label overlay smears across roofs
 * and walls.
 *
 * This keeps the tiles in view loaded and swaps them as the camera moves; which features become labels, how they
 * rank and fit, and the tile math are in ../logic.
 */
class CesiumMapLabelsLayer {
    /**
     * @param {Cesium.Viewer} viewer
     * @param {object} settings
     * @param {string} settings.tilesUrl - TileJSON URL, or a {z}/{x}/{y} vector tile URL
     * @param {boolean} [settings.showPlaceNames=true]
     * @param {boolean} [settings.showRoadNames=true]
     * @param {boolean} [settings.showRoadLines=true]
     * @param {number} [settings.fontSizePixels=14]
     * @param {number} [settings.opacity=1]
     */
    constructor(viewer, settings) {
        this.viewer = viewer
        this.tilesUrlSetting = settings.tilesUrl
        this.showPlaceNames = settings.showPlaceNames !== false
        this.showRoadNames = settings.showRoadNames !== false
        this.showRoadLines = settings.showRoadLines !== false
        this.fontSizePixels = settings.fontSizePixels || DEFAULT_FONT_SIZE_PIXELS
        this.opacity = settings.opacity ?? 1

        this._vectorTiles = null
        this._maximumTileZoom = DEFAULT_MAXIMUM_TILE_ZOOM
        this._isVisible = true
        this._isDestroyed = false
        // "tileZoom/x/y@labelDetailZoom" -> { labelEntries, roadLines, buildVersion }
        this._shownTiles = {}
        // Same keys, for tiles left on screen until the tiles replacing them are drawn
        this._staleTiles = {}
        this._staleTilesTimer = null
        this._tileKeysBeingShown = new Set()
        this._neededTileKeys = new Set()
        // Bumped when every tile must be rebuilt, e.g. for a new opacity
        this._buildVersion = 0
        this._renderTimer = null
        this._lastLabelLayoutTime = 0
        this._labelLayoutCamera = createCameraSnapshot()
        this._lastTileUpdateTime = 0
        this._tileUpdateCamera = createCameraSnapshot()

        this._rootCollection = new Cesium.PrimitiveCollection()
        this.viewer.scene.primitives.add(this._rootCollection)
        // One collection for every tile's labels, so each letter is drawn into its texture once, not per tile.
        this._labels = this._rootCollection.add(new Cesium.LabelCollection({ scene: this.viewer.scene }))

        this._onCameraMoveEnd = this._onCameraMoveEnd.bind(this)
        this.viewer.camera.moveEnd.addEventListener(this._onCameraMoveEnd)
        this._onPostRender = this._onPostRender.bind(this)
        this.viewer.scene.postRender.addEventListener(this._onPostRender)

        // Ground polylines wait on Cesium's terrain height table; fetching it now spares the first roads that wait.
        if (this.showRoadLines) Cesium.GroundPolylinePrimitive.initializeTerrainHeights().catch(() => {})

        this.ready = this._openTileSource().then(() => this._updateTiles())
    }

    async _openTileSource() {
        const { tileUrlTemplate, maximumTileZoom } = await resolveTileSource(this.tilesUrlSetting,
            DEFAULT_MAXIMUM_TILE_ZOOM)
        this._maximumTileZoom = maximumTileZoom
        this._vectorTiles = new VectorTileCache(tileUrlTemplate)
    }

    _onCameraMoveEnd() {
        this._updateTiles()
        this._layOutLabels()
    }

    // Cesium only renders on demand and announces a stopped camera on a later render, so updates
    // skipped while moving are caught up by asking for one more render once they're due.
    _onPostRender() {
        this._removeStaleTilesIfReplaced()
        const camera = this.viewer.camera
        if (cameraMovedSince(camera, this._tileUpdateCamera)) {
            const msUntilTileUpdate = this._lastTileUpdateTime + TILE_UPDATE_INTERVAL_MS - performance.now()
            if (msUntilTileUpdate <= 0) this._updateTiles()
            else this._requestRenderAfter(msUntilTileUpdate)
        }
        if (cameraMovedSince(camera, this._labelLayoutCamera)) {
            const msUntilLayout = this._lastLabelLayoutTime + LABEL_LAYOUT_INTERVAL_MS - performance.now()
            if (msUntilLayout <= 0) this._layOutLabels()
            else this._requestRenderAfter(msUntilLayout)
        }
    }

    _requestRenderAfter(milliseconds) {
        if (this._renderTimer) return
        this._renderTimer = setTimeout(() => {
            this._renderTimer = null
            this.viewer.scene.requestRender()
        }, milliseconds)
    }

    _layOutLabels() {
        this._lastLabelLayoutTime = performance.now()
        saveCamera(this.viewer.camera, this._labelLayoutCamera)
        if (!this._isVisible) return
        const anyLabelChanged = showLabelsThatFit(this.viewer.scene, Object.values(this._shownTiles),
            Object.values(this._staleTiles))
        if (anyLabelChanged) this.viewer.scene.requestRender()
    }

    // Run in the same step that adds or removes tiles, so no frame shows old labels gone and new ones not yet placed.
    _refreshLabelLayout() {
        this._layOutLabels()
        this.viewer.scene.requestRender()
    }

    _updateTiles() {
        if (!this._isVisible || this._isDestroyed || !this._vectorTiles) return
        const camera = this.viewer.camera
        this._lastTileUpdateTime = performance.now()
        saveCamera(camera, this._tileUpdateCamera)

        const cameraZoom = cameraZoomAt(camera.positionCartographic.height)
        if (cameraZoom < LOWEST_LABEL_ZOOM) {
            this._removeAllTiles()
            return
        }
        const viewBounds = viewBoundsOf(camera, this.viewer.scene.globe.ellipsoid)
        if (!viewBounds) return
        const neededTileKeys = tileKeysInView(viewBounds, cameraZoom, this._maximumTileZoom)

        this._neededTileKeys = neededTileKeys
        for (const [tileKey, shownTile] of Object.entries(this._shownTiles)) {
            if (!neededTileKeys.has(tileKey)) this._makeStale(tileKey, shownTile)
        }
        const neededTileParts = new Set([...neededTileKeys].map((tileKey) => parseTileKey(tileKey).tilePart))
        this._vectorTiles.abortLoadsOutside(neededTileParts)
        for (const tileKey of neededTileKeys) {
            if (this._shownTiles[tileKey] || this._tileKeysBeingShown.has(tileKey)) continue
            const staleTile = this._staleTiles[tileKey]
            if (staleTile?.buildVersion === this._buildVersion) {
                delete this._staleTiles[tileKey]
                this._shownTiles[tileKey] = staleTile
            } else {
                this._showTile(tileKey)
            }
        }
        this._removeStaleTilesIfReplaced()
    }

    async _showTile(tileKey) {
        const tile = parseTileKey(tileKey)
        this._tileKeysBeingShown.add(tileKey)

        try {
            const vectorTile = await this._vectorTiles.vectorTileFor(tile.tilePart)
            if (this._isDestroyed || !this._neededTileKeys.has(tileKey)) return

            const shownTile = { labelEntries: [], roadLines: null, buildVersion: this._buildVersion }
            if (vectorTile) {
                const { place, transportation_name: roadNames, transportation: roads } = vectorTile.layers
                const labelSpecs = [
                    ...(this.showPlaceNames && place ? placeLabelsIn(place, tile) : []),
                    ...(this.showRoadNames && roadNames ? roadNameLabelsIn(roadNames, tile) : []),
                ]
                const labelLook = { fontSizePixels: this.fontSizePixels, opacity: this.opacity }
                shownTile.labelEntries = labelSpecs.map((labelSpec) => addLabel(this._labels, labelSpec, labelLook))
                if (this.showRoadLines && roads) {
                    const roadLines = createFreewayLinesPrimitive(freewayLinesIn(roads, tile), this.opacity)
                    if (roadLines) shownTile.roadLines = this._rootCollection.add(roadLines)
                }
            }
            this._shownTiles[tileKey] = shownTile
            this._refreshLabelLayout()
        } finally {
            this._tileKeysBeingShown.delete(tileKey)
        }
    }

    _makeStale(tileKey, shownTile) {
        delete this._shownTiles[tileKey]
        if (this._staleTiles[tileKey]) this._dropTile(this._staleTiles[tileKey])
        this._staleTiles[tileKey] = shownTile
        if (!this._staleTilesTimer) {
            this._staleTilesTimer = setTimeout(() => this._removeStaleTiles(), STALE_TILES_LIMIT_MS)
        }
    }

    // Each old tile stays until the new tiles over its area are drawn, so zooming neither blanks nor piles up labels.
    _removeStaleTilesIfReplaced() {
        const staleTileKeys = Object.keys(this._staleTiles)
        if (staleTileKeys.length === 0) return
        const replacedTileKeys = replacedStaleTileKeys(staleTileKeys, [...this._neededTileKeys],
            (neededTileKey) => isTileDrawn(this._shownTiles[neededTileKey]))
        for (const staleTileKey of replacedTileKeys) {
            this._dropTile(this._staleTiles[staleTileKey])
            delete this._staleTiles[staleTileKey]
        }
        if (Object.keys(this._staleTiles).length === 0) {
            clearTimeout(this._staleTilesTimer)
            this._staleTilesTimer = null
        }
        if (replacedTileKeys.length > 0) this._refreshLabelLayout()
    }

    _removeStaleTiles() {
        clearTimeout(this._staleTilesTimer)
        this._staleTilesTimer = null
        for (const staleTile of Object.values(this._staleTiles)) this._dropTile(staleTile)
        this._staleTiles = {}
        this._refreshLabelLayout()
    }

    _dropTile(tile) {
        for (const labelEntry of tile.labelEntries) this._labels.remove(labelEntry.label)
        if (tile.roadLines) this._rootCollection.remove(tile.roadLines)
    }

    _removeAllTiles() {
        for (const shownTile of Object.values(this._shownTiles)) this._dropTile(shownTile)
        this._shownTiles = {}
        this._neededTileKeys = new Set()
        this._removeStaleTiles()
        this._vectorTiles?.abortAllLoads()
    }

    setVisible(isVisible) {
        this._isVisible = isVisible
        this._rootCollection.show = isVisible
        if (isVisible) this._updateTiles()
        this._refreshLabelLayout()
    }

    /** Colors are baked into each tile's labels and lines, so tiles are rebuilt from the cached data. */
    setOpacity(opacity) {
        this.opacity = opacity
        this._buildVersion++
        for (const [tileKey, shownTile] of Object.entries(this._shownTiles)) this._makeStale(tileKey, shownTile)
        this._updateTiles()
    }

    destroy() {
        this._isDestroyed = true
        this.viewer.camera.moveEnd.removeEventListener(this._onCameraMoveEnd)
        this.viewer.scene.postRender.removeEventListener(this._onPostRender)
        clearTimeout(this._renderTimer)
        this._removeAllTiles()
        this._vectorTiles?.clear()
        this.viewer.scene.primitives.remove(this._rootCollection)
        this.viewer.scene.requestRender()
    }
}

// Ground polylines build in workers, so a tile with roads counts as drawn once its lines are ready.
function isTileDrawn(tile) {
    return Boolean(tile) && (!tile.roadLines || tile.roadLines.ready)
}

export default CesiumMapLabelsLayer

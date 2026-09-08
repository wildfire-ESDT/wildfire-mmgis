/**
 * CesiumSlicedVectorLayer — draws a client-sliced GeoJSON on the Cesium globe
 * as terrain-draped raster imagery instead of per-feature geometry.
 *
 * Why raster, and not entities or primitives
 * ------------------------------------------
 * The `vector` layer type builds one Cesium Entity per feature and keeps them
 * all resident, so camera movement costs work proportional to the whole
 * dataset every frame — a few hundred complex polygons is enough to make
 * panning visibly stutter. Extruded MVT (CesiumMVTLayer) is tiled and
 * viewport-limited, but still manages real 3D geometry per tile.
 *
 * For a layer that is simply draped on the ground — fire perimeters, county
 * boundaries, anything whose 3D-ness is "follows the terrain" — neither is
 * necessary. Rasterizing each tile to a canvas and handing it to Cesium as an
 * ImageryLayer puts the data on the same path as every basemap: Cesium's
 * quadtree pager decides which tiles are needed, at which level of detail,
 * caches them, and blends them across LOD changes. Frame cost becomes
 * "composite some textures" and stops scaling with feature count at all, which
 * is the whole point.
 *
 * The trade is that Cesium can no longer pick a feature for us — a texture has
 * no features. `featureAt` restores that: it hit-tests the click's lng/lat
 * against the features of the single tile under the cursor (see
 * GeoJSONSlicer.featureAt), which is cheap because it is bounded by one tile's
 * contents rather than the dataset. GlobeRenderer's global click handler calls
 * it for layers of this kind, so selection behaves as it does for any other
 * layer type.
 *
 * Not for extrusion: a layer with `extrudeEnabled` wants true 3D volumes and
 * stays on the CesiumMVTLayer primitive path.
 */
import * as Cesium from 'cesium'
import GeoJSONSlicer, { sliceUrl, SOURCE_INDEX_KEY } from './GeoJSONSlicer'
import { resolveFeatureStyle } from './slicedStyle'

const TILE_SIZE = 256

// geojson-vt tile geometry types.
const TYPE_POINT = 1
const TYPE_LINE = 2
const TYPE_POLYGON = 3

/** A `rgba()` string for a CSS colour at an opacity, or null if unusable. */
function rgba(css, opacity) {
    if (css == null) return null
    const alpha = parseFloat(opacity)
    const color = Cesium.Color.fromCssColorString(css)
    if (color == null) return null
    return `rgba(${Math.round(color.red * 255)}, ${Math.round(
        color.green * 255
    )}, ${Math.round(color.blue * 255)}, ${isNaN(alpha) ? 1 : alpha})`
}

/**
 * A Cesium ImageryProvider that rasterizes sliced GeoJSON tiles on demand.
 *
 * Tiles are drawn synchronously into a canvas — there is no network request
 * per tile, since the slicer holds the whole pyramid in memory, so the usual
 * reason for an async imagery provider doesn't apply.
 */
class SlicedVectorImageryProvider {
    /**
     * @param {GeoJSONSlicer} slicer
     * @param {object} options
     * @param {object} options.style - the layer's `style` config
     * @param {number} [options.minimumLevel=0]
     * @param {number} [options.maximumLevel=18]
     */
    constructor(slicer, options = {}) {
        this._slicer = slicer
        this._style = options.style || {}
        this._errorEvent = new Cesium.Event()
        this._tilingScheme = new Cesium.WebMercatorTilingScheme()
        this._minimumLevel = options.minimumLevel ?? 0
        this._maximumLevel = options.maximumLevel ?? 18
        // The one feature drawn in selection colours, by source index.
        this._highlightIndex = null
    }

    get tileWidth() {
        return TILE_SIZE
    }
    get tileHeight() {
        return TILE_SIZE
    }
    get maximumLevel() {
        return this._maximumLevel
    }
    get minimumLevel() {
        return this._minimumLevel
    }
    get tilingScheme() {
        return this._tilingScheme
    }
    get rectangle() {
        return this._tilingScheme.rectangle
    }
    get tileDiscardPolicy() {
        return undefined
    }
    get errorEvent() {
        return this._errorEvent
    }
    get credit() {
        return undefined
    }
    get proxy() {
        return undefined
    }
    get hasAlphaChannel() {
        return true
    }
    // Retained for Cesium versions that still consult them on an imagery
    // provider; harmless on those that no longer do.
    get ready() {
        return true
    }
    get readyPromise() {
        return Promise.resolve(true)
    }

    getTileCredits() {
        return []
    }

    /** We do our own picking (see CesiumSlicedVectorLayer.featureAt). */
    pickFeatures() {
        return undefined
    }

    /**
     * Cesium's ImageryLayer awaits this (its own tile-loading queue is what
     * throttles/paces requests), so a synchronously-drawn canvas still needs
     * wrapping in a resolved Promise — returning it bare fails with
     * "imagePromise.then is not a function" deep in ImageryLayer's request
     * pipeline. An empty tile resolves to undefined, which Cesium treats as
     * "nothing to draw here" rather than "try again".
     */
    requestImage(x, y, level) {
        // Cesium's own error surfacing ("Failed to obtain image tile…") gives
        // no detail about what actually went wrong inside a synchronous
        // rasterize — catch here so the real cause is visible instead of a
        // dead end, and so one bad tile can't take out ones around it (a
        // thrown rejection here is treated by Cesium as a load failure, not
        // as "this tile has no data", so it's worth distinguishing the two).
        try {
            return Promise.resolve(this._renderTile(x, y, level))
        } catch (err) {
            console.error(
                `SlicedVectorImageryProvider failed to render tile ${level}/${x}/${y}:`,
                err
            )
            return Promise.resolve(undefined)
        }
    }

    /** Synchronously rasterize one tile, or undefined if it has no features. */
    _renderTile(x, y, level) {
        const tile = this._slicer.getTile(level, x, y)
        if (!tile || !tile.features || tile.features.length === 0)
            return undefined

        const canvas = document.createElement('canvas')
        canvas.width = TILE_SIZE
        canvas.height = TILE_SIZE
        const ctx = canvas.getContext('2d')

        // Tile coordinates run 0..extent; draw in that space and let the
        // canvas transform scale to the 256px texture, so geometry needs no
        // per-vertex scaling.
        const scale = TILE_SIZE / this._slicer.extent
        ctx.scale(scale, scale)
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'

        for (const feature of tile.features) {
            // One malformed feature (e.g. a degenerate ring after
            // simplification) must not blank the rest of an otherwise-good
            // tile, and definitely must not turn into a rejected tile.
            try {
                this._drawFeature(ctx, feature, scale)
            } catch (err) {
                console.error(
                    `SlicedVectorImageryProvider failed to draw a feature in tile ${level}/${x}/${y}:`,
                    err,
                    feature
                )
            }
        }

        return canvas
    }

    /** Draw one tile feature in its resolved style. */
    _drawFeature(ctx, feature, scale) {
        const properties = feature.tags || {}
        const style = resolveFeatureStyle(this._style, properties)
        const highlighted =
            this._highlightIndex != null &&
            properties[SOURCE_INDEX_KEY] === this._highlightIndex

        const stroke = highlighted
            ? 'rgba(255, 0, 0, 1)'
            : rgba(style.color, style.opacity)
        const fill = rgba(style.fillColor, style.fillOpacity)
        // Widths are specified in screen pixels, but the canvas is scaled to
        // tile-coordinate space, so undo the scale to keep strokes constant.
        const weight = style.weight / scale
        const lineWidth = highlighted ? Math.max(weight, 1 / scale) * 3 : weight

        if (feature.type === TYPE_POINT) {
            const radius = style.radius / scale
            for (const point of feature.geometry) {
                ctx.beginPath()
                ctx.arc(point[0], point[1], radius, 0, 2 * Math.PI)
                if (fill) {
                    ctx.fillStyle = fill
                    ctx.fill()
                }
                if (stroke && lineWidth > 0) {
                    ctx.strokeStyle = stroke
                    ctx.lineWidth = lineWidth
                    ctx.stroke()
                }
            }
            return
        }

        if (feature.type !== TYPE_LINE && feature.type !== TYPE_POLYGON) return

        const isPolygon = feature.type === TYPE_POLYGON

        ctx.beginPath()
        for (const ring of feature.geometry) {
            if (ring.length === 0) continue
            ctx.moveTo(ring[0][0], ring[0][1])
            for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i][0], ring[i][1])
            if (isPolygon) ctx.closePath()
        }

        // One path for all rings so 'evenodd' cuts holes out of the fill.
        if (isPolygon && fill) {
            ctx.fillStyle = fill
            ctx.fill('evenodd')
        }
        if (stroke && lineWidth > 0) {
            ctx.strokeStyle = stroke
            ctx.lineWidth = lineWidth
            ctx.stroke()
        }
    }

    /** Which source feature (if any) currently draws in selection colours. */
    setHighlightIndex(index) {
        this._highlightIndex = index
    }
}

/**
 * Manages the imagery layer for one sliced GeoJSON layer: builds it once the
 * document has been fetched and sliced, and owns visibility/opacity/removal
 * plus the picking entry point.
 */
class CesiumSlicedVectorLayer {
    /**
     * @param {Cesium.Viewer} viewer
     * @param {object} config
     * @param {string} config.name - layer name
     * @param {string} config.url - URL of the source GeoJSON document
     * @param {object} [config.geojson] - already-fetched GeoJSON; skips the fetch
     * @param {object} [config.style] - the layer's style config
     * @param {number} [config.opacity=1]
     * @param {number} [config.minZoom]
     * @param {number} [config.maxZoom]
     * @param {number} [config.sliceTolerance] - geojson-vt simplification
     * @param {function} [config.onReady] - called with this once sliced
     */
    constructor(viewer, config) {
        this.viewer = viewer
        this.name = config.name
        this.url = config.url
        this.style = config.style || {}
        this.opacity = config.opacity ?? 1
        this.minZoom = config.minZoom ?? 0
        this.maxZoom = config.maxZoom ?? 18

        this._visible = true
        this._destroyed = false
        this._imageryLayer = null
        this._provider = null
        this.slicer = null

        this._sliceOptions = {
            maxZoom: this.maxZoom,
            tolerance: config.sliceTolerance ?? 3,
        }

        this._ready = this._build(config)
    }

    /** Resolves once the layer is on the globe (or has failed to slice). */
    whenReady() {
        return this._ready
    }

    async _build(config) {
        try {
            const slicer = config.geojson
                ? new GeoJSONSlicer(config.geojson, this._sliceOptions)
                : await sliceUrl(this.url, this._sliceOptions)

            // The layer may have been turned off or removed while we fetched.
            if (this._destroyed) return

            this.slicer = slicer
            this._provider = new SlicedVectorImageryProvider(slicer, {
                style: this.style,
                minimumLevel: this.minZoom,
                maximumLevel: this.maxZoom,
            })
            this._imageryLayer = this.viewer.imageryLayers.addImageryProvider(
                this._provider
            )
            this._imageryLayer.alpha = this.opacity
            this._imageryLayer.show = this._visible
            this.viewer.scene.requestRender()
            if (config.onReady) config.onReady(this)
        } catch (err) {
            console.error(
                `Failed to slice GeoJSON for layer "${this.name}":`,
                err
            )
        }
    }

    /** The zoom level the camera is currently showing, for hit-testing. */
    _currentZoom() {
        const height = this.viewer.camera.positionCartographic.height
        const EARTH_CIRCUMFERENCE = 40075017
        return Math.round(Math.log2(EARTH_CIRCUMFERENCE / Math.max(height, 1)))
    }

    /**
     * The source feature at a lng/lat, or null — the globe's equivalent of
     * clicking a feature on the 2D map.
     */
    featureAt(lng, lat) {
        if (!this.slicer || !this._visible) return null
        const zoom = Math.max(
            this.minZoom,
            Math.min(this._currentZoom(), this.maxZoom)
        )
        return this.slicer.featureAt(lng, lat, zoom)
    }

    /**
     * Draw one feature in selection colours, or none when passed null.
     *
     * Only the tiles showing that feature need redrawing, but Cesium has no
     * per-tile invalidation for an imagery provider, so the layer is rebuilt
     * in place. That is cheap here: rasterizing the handful of visible tiles
     * is the same work a pan does, and it happens once per selection rather
     * than per frame.
     */
    setHighlightedFeature(sourceIndex) {
        if (!this._provider) return
        if (this._provider._highlightIndex === sourceIndex) return
        this._provider.setHighlightIndex(sourceIndex)
        this._refreshImagery()
    }

    /** Rebuild the imagery layer in place, preserving position and settings. */
    _refreshImagery() {
        if (!this._imageryLayer) return
        const layers = this.viewer.imageryLayers
        const index = layers.indexOf(this._imageryLayer)
        const alpha = this._imageryLayer.alpha
        const show = this._imageryLayer.show

        layers.remove(this._imageryLayer, true)
        this._imageryLayer = layers.addImageryProvider(
            this._provider,
            index >= 0 ? index : undefined
        )
        this._imageryLayer.alpha = alpha
        this._imageryLayer.show = show
        this.viewer.scene.requestRender()
    }

    setVisible(visible) {
        this._visible = visible
        if (this._imageryLayer) this._imageryLayer.show = visible
        this.viewer.scene.requestRender()
    }

    setOpacity(opacity) {
        this.opacity = opacity
        if (this._imageryLayer) this._imageryLayer.alpha = opacity
        this.viewer.scene.requestRender()
    }

    /** Restyle after a style change, reusing the already-sliced pyramid. */
    setStyle(style) {
        this.style = style || {}
        if (!this._provider) return
        this._provider._style = this.style
        this._refreshImagery()
    }

    destroy() {
        this._destroyed = true
        if (this._imageryLayer) {
            this.viewer.imageryLayers.remove(this._imageryLayer, true)
            this._imageryLayer = null
        }
        this._provider = null
        this.slicer = null
    }
}

export { SlicedVectorImageryProvider }
export default CesiumSlicedVectorLayer

/**
 * LeafletSlicedVectorGrid — an L.VectorGrid backed directly by our own
 * GeoJSONSlicer, in place of the vendored L.VectorGrid.Slicer.
 *
 * Why not the vendored Slicer
 * ----------------------------
 * `leaflet.vectorGrid.bundled.js` ships `VectorGrid.Slicer` with its own,
 * separately bundled copy of geojson-vt running inside a Web Worker — code we
 * can't step through or reason about, from a project last touched years ago.
 * It was also, it turned out, never actually exercised by MMGIS before this
 * feature (only `.protobuf()` was ever called). Debugging feature ids and
 * interactivity through an opaque worker with its own tile-format conversion
 * proved unworkable.
 *
 * This instead drives the same `GeoJSONSlicer` already used (and verified) for
 * the Cesium globe rendering, so both views of a sliced layer come from one
 * well-understood implementation. It runs on the main thread rather than in a
 * worker — `GeoJSONSlicer.getTile` is a plain object lookup once the index is
 * built, fast enough not to need one.
 *
 * Geometry format
 * ----------------
 * `L.VectorGrid`'s render pipeline (`PolyBase._makeFeatureParts`, the
 * protobuf path's `loadGeometry()`) expects each geometry point as an
 * `{x, y}` `L.Point`, not a plain `[x, y]` pair — `GeoJSONSlicer.getTile`
 * returns the latter (geojson-vt's native tile format), so `_getVectorTilePromise`
 * converts on the way out.
 */
import GeoJSONSlicer, { SOURCE_INDEX_KEY } from './GeoJSONSlicer'

const L = window.L

// geojson-vt tile geometry types.
const TYPE_POINT = 1

/**
 * A tile feature's geometry, converted from geojson-vt's plain `[x, y]`
 * pairs to `L.Point`s. Points (type 1) are a flat array of points; lines and
 * polygons (types 2/3) are an array of rings, each a list of points — the two
 * shapes need different nesting here.
 */
function toLeafletGeometry(type, geometry) {
    if (type === TYPE_POINT)
        return geometry.map((point) => L.point(point[0], point[1]))
    return geometry.map((ring) =>
        ring.map((point) => L.point(point[0], point[1]))
    )
}

const LeafletSlicedVectorGrid = L.VectorGrid.extend({
    /**
     * @param {GeoJSONSlicer|object} source - an already-built slicer (map.js
     *        passes the one `sliceUrl` shares with the globe), or a GeoJSON
     *        document to slice here
     * @param {object} options - L.VectorGrid options, plus `sliceMaxZoom` /
     *        `tolerance` when `source` is a document. `sliceMaxZoom` is kept
     *        apart from `maxZoom`, which is Leaflet's own cutoff for showing
     *        the layer at all.
     */
    initialize(source, options) {
        L.VectorGrid.prototype.initialize.call(this, options)
        // extent is intentionally not forwarded here — nothing in this
        // layer's construction sets one, and GeoJSONSlicer's own default
        // (4096, matching this class's tile-space math) is correct.
        this._slicer =
            source instanceof GeoJSONSlicer
                ? source
                : new GeoJSONSlicer(source, {
                      maxZoom: options.sliceMaxZoom,
                      tolerance: options.tolerance,
                  })
        this._configuredMaxNativeZoom = this.options.maxNativeZoom
        this._clampMaxNativeZoom()
    },

    _clampMaxNativeZoom() {
        // The slicer can't serve a tile deeper than its own max zoom, so
        // past it the grid overzooms that zoom's tiles instead of asking.
        const maxNativeZoom = parseInt(this._configuredMaxNativeZoom, 10)
        this.options.maxNativeZoom = isNaN(maxNativeZoom)
            ? this._slicer.maxZoom
            : Math.min(maxNativeZoom, this._slicer.maxZoom)
    },

    setSlicer(slicer) {
        this._slicer = slicer
        this._clampMaxNativeZoom()
        this._overriddenStyles = {}
        this.highlight = null
        this.redraw()
    },

    /** The source feature behind a rendered tile feature (for callers that
     * want the untiled, unsimplified original — matching what a `vector`
     * layer's click handler would have seen). */
    sourceFeatureFor(tileFeatureProperties) {
        const index = tileFeatureProperties?.[SOURCE_INDEX_KEY]
        return index == null ? null : this._slicer.features[index] || null
    },

    /**
     * The source feature at a Leaflet LatLng, or null.
     *
     * Click/hover on this layer are answered from this rather than from
     * Leaflet's per-tile DOM interactivity (see the file header) — this is
     * the same GeoJSONSlicer.featureAt the Cesium globe rendering already
     * uses, so map.js drives it directly from a map-level click instead of
     * depending on the vendored tile renderer's own event delegation.
     */
    featureAt(latlng, zoom) {
        return this._slicer.featureAt(latlng.lng, latlng.lat, zoom)
    },

    _getVectorTilePromise(coords) {
        const tile = this._slicer.getTile(coords.z, coords.x, coords.y)
        const features = tile?.features || []
        return Promise.resolve({
            layers: {
                [this.options.vectorTileLayerName || 'sliced']: {
                    extent: this._slicer.extent,
                    features: features.map((f) => ({
                        type: f.type,
                        properties: f.tags || {},
                        geometry: toLeafletGeometry(f.type, f.geometry),
                    })),
                },
            },
        })
    },
})

L.vectorGrid = L.vectorGrid || {}
L.vectorGrid.geojsonSliced = function (source, options) {
    return new LeafletSlicedVectorGrid(source, options)
}

export default LeafletSlicedVectorGrid

/**
 * GeoJSONSlicer — turns one large GeoJSON document into an on-demand tile
 * pyramid, client-side, with no pre-tiling step and no database.
 *
 * Why this exists
 * ---------------
 * A vector layer backed by a big GeoJSON has, until now, had exactly two
 * renderings in MMGIS, and neither scales:
 *
 *   - The `vector` layer type hands the whole document to Leaflet / Cesium's
 *     GeoJsonDataSource, which builds one renderable per feature and keeps
 *     every one of them resident at full vertex detail no matter where the
 *     camera is. Panning the globe then costs work proportional to the whole
 *     dataset, every frame, even for the features off screen.
 *   - The `vectortile` layer type is properly tiled and viewport-limited, but
 *     only consumes tiles someone else already made: a `{z}/{x}/{y}.pbf`
 *     tileset baked with tippecanoe, or PostGIS `ST_AsMVT()` after ingesting
 *     the data into a geodataset.
 *
 * This module fills the gap between them. `geojson-vt` slices the document
 * into a quadtree of tiles in memory, and — the part that matters for
 * performance — simplifies each zoom level independently: zoomed-out tiles
 * keep only the vertices that survive a Douglas-Peucker pass at that scale,
 * and features too small to see are dropped entirely. That is the vector
 * analog of a COG's overview pyramid: coarse-and-cheap when zoomed out, full
 * detail only where you're actually looking, all derived from a single source
 * document at runtime.
 *
 * What callers get
 * ----------------
 * `getTile(z, x, y)` returns a tile of features in tile-local integer
 * coordinates (0..extent), ready to rasterize to a canvas or hand to Leaflet.
 * `featureAt(lng, lat, z)` answers "what did the user click?" by testing only
 * the features in the one tile under the cursor, and returns the ORIGINAL
 * untiled feature — full properties, unsimplified geometry — so downstream
 * MMGIS code (info panels, selection, interactions) sees exactly what it would
 * have seen from a `vector` layer.
 *
 * Index sharing
 * -------------
 * `sliceUrl` caches by URL, so a layer drawn on both the 2D map and the 3D
 * globe fetches and slices once rather than twice.
 */
import geojsonvt from 'geojson-vt'

// Property key holding a feature's position in the source document. Tiling
// clips and splits features across tiles, so a tile feature is not the source
// feature; this is how we get back to the original on a hit-test.
const SOURCE_INDEX_KEY = '__mmgisSourceIndex'

// geojson-vt tile geometry types.
const TYPE_POINT = 1
const TYPE_LINE = 2
const TYPE_POLYGON = 3

const DEFAULT_EXTENT = 4096

// geojson-vt's simplification is worst-case O(n²) per ring. A ring with tens
// of thousands of points (plausible for satellite/GPS-traced boundaries such
// as fire perimeters) can turn that into billions of operations — enough to
// freeze or crash the tab outright rather than just slice slowly. Capping the
// point count per ring before it ever reaches geojson-vt bounds the worst case
// no matter how dense the source data gets; a cheap stride-based decimation
// (not full Douglas-Peucker) is enough since geojson-vt will simplify further
// per zoom level anyway.
const MAX_RING_POINTS = 2000

/** Evenly drop points from a ring so it has at most `max` of them, keeping
 * the first and last (closing) point. Cheap O(n), not shape-preserving —
 * geojson-vt's own per-zoom simplification is what actually shapes the
 * output; this only exists to bound its input size. */
function decimateRing(ring, max) {
    if (ring.length <= max) return ring
    const stride = ring.length / max
    const out = []
    for (let i = 0; i < max - 1; i++) out.push(ring[Math.floor(i * stride)])
    out.push(ring[ring.length - 1])
    return out
}

/** Apply decimateRing to every ring in a geometry, whatever its nesting. */
function decimateGeometry(geometry) {
    if (geometry == null) return geometry
    switch (geometry.type) {
        case 'LineString':
            return {
                ...geometry,
                coordinates: decimateRing(
                    geometry.coordinates,
                    MAX_RING_POINTS
                ),
            }
        case 'Polygon':
            return {
                ...geometry,
                coordinates: geometry.coordinates.map((ring) =>
                    decimateRing(ring, MAX_RING_POINTS)
                ),
            }
        case 'MultiLineString':
            return {
                ...geometry,
                coordinates: geometry.coordinates.map((line) =>
                    decimateRing(line, MAX_RING_POINTS)
                ),
            }
        case 'MultiPolygon':
            return {
                ...geometry,
                coordinates: geometry.coordinates.map((polygon) =>
                    polygon.map((ring) => decimateRing(ring, MAX_RING_POINTS))
                ),
            }
        default:
            // Point/MultiPoint have no rings expensive enough to matter.
            return geometry
    }
}

// Slicing defaults. `maxZoom` is where the pyramid stops simplifying and
// serves full detail; requests deeper than it reuse that tile's geometry
// (which is correct — past this zoom there is nothing left to reveal).
// geojson-vt's own default (100000) — NOT 0. 0 doesn't mean "unbounded",
// it disables the check entirely ('numPoints <= indexMaxPoints' is never
// true), which forces eager indexing to fully split every tile down to
// indexMaxZoom regardless of how sparse/simple it already is. For a
// nationwide dataset of complex, many-vertex polygons (satellite-traced fire
// perimeters), that eager over-splitting at construction time is enough
// extra CPU/memory to crash the tab outright — this was found the hard way.
const DEFAULT_OPTIONS = {
    maxZoom: 18,
    indexMaxZoom: 5,
    indexMaxPoints: 100000,
    tolerance: 3,
    extent: DEFAULT_EXTENT,
    buffer: 64,
}

/** Web-mercator lng/lat → fractional tile coordinates at a zoom. */
export function lngLatToTile(lng, lat, z) {
    const n = Math.pow(2, z)
    const latRad = (lat * Math.PI) / 180
    return {
        x: ((lng + 180) / 360) * n,
        y:
            ((1 -
                Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
                2) *
            n,
    }
}

/** Tile x/y/z → its lng/lat bounds in degrees. */
export function tileBounds(z, x, y) {
    const n = Math.pow(2, z)
    return {
        west: (x / n) * 360 - 180,
        east: ((x + 1) / n) * 360 - 180,
        north:
            (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
        south:
            (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) /
            Math.PI,
    }
}

/**
 * Squared distance from point P to segment A→B, in whatever units the inputs
 * are. Squared so the hit-test inner loop never calls Math.sqrt.
 */
function sqDistToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax
    const dy = by - ay
    const segLenSq = dx * dx + dy * dy
    let t = segLenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / segLenSq
    if (t < 0) t = 0
    else if (t > 1) t = 1
    const ex = px - (ax + t * dx)
    const ey = py - (ay + t * dy)
    return ex * ex + ey * ey
}

/**
 * Even-odd ray casting across every ring of a polygon feature.
 *
 * Holes need no special handling under the even-odd rule: a point inside a
 * hole crosses both the outer ring and the hole ring, an even number of
 * times, and correctly reads as outside.
 */
function pointInRings(px, py, rings) {
    let inside = false
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0]
            const yi = ring[i][1]
            const xj = ring[j][0]
            const yj = ring[j][1]
            if (
                (yi > py) !== (yj > py) &&
                px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
            )
                inside = !inside
        }
    }
    return inside
}

class GeoJSONSlicer {
    /**
     * @param {object} geojson - source FeatureCollection (or single Feature)
     * @param {object} [options] - geojson-vt options; see DEFAULT_OPTIONS
     */
    constructor(geojson, options = {}) {
        // Object spread copies a key even when its value is `undefined`
        // (`{...DEFAULT_OPTIONS, extent: undefined}` overwrites 4096 with
        // undefined, it does not "leave it at the default") — an explicit
        // `undefined` from a caller must not silently displace a real
        // default. geojson-vt's own option merging has the identical
        // footgun (`dest[i] = src[i]` unconditionally), so an undefined
        // `extent` slipping through corrupts its coordinate-transform math
        // and can send its world-wrap duplication into unbounded allocation
        // — confirmed by reproduction, not theory: a 300-feature dataset
        // spanning the continental US OOM-crashed the process this way.
        const defined = Object.fromEntries(
            Object.entries(options).filter(([, v]) => v !== undefined)
        )
        const opts = { ...DEFAULT_OPTIONS, ...defined }
        this.extent = opts.extent
        this.maxZoom = opts.maxZoom

        // Keep the untiled features so a hit-test can return the real one.
        this.features =
            geojson?.type === 'FeatureCollection'
                ? geojson.features || []
                : geojson?.type === 'Feature'
                ? [geojson]
                : []

        // Tag a copy with source indices rather than the caller's object: the
        // layer's own GeoJSON is shared with the 2D map, and slicing must not
        // leave bookkeeping keys in the properties MMGIS shows the user.
        const tagged = {
            type: 'FeatureCollection',
            features: this.features.map((feature, index) => ({
                ...feature,
                // Decimated for geojson-vt's sake only — this.features (what
                // hit-testing and highlighting resolve back to) keeps the
                // original, undecimated geometry.
                geometry: decimateGeometry(feature.geometry),
                properties: {
                    ...(feature.properties || {}),
                    [SOURCE_INDEX_KEY]: index,
                },
            })),
        }

        this.index = geojsonvt(tagged, opts)
    }

    /** How many features the source document held. */
    get featureCount() {
        return this.features.length
    }

    /**
     * The tile at z/x/y, or null where the pyramid has nothing.
     *
     * Requests past `maxZoom` are served from the deepest tile that covers
     * them — geojson-vt stops simplifying there, so a deeper tile would carry
     * the same geometry at greater cost.
     */
    getTile(z, x, y) {
        if (z > this.maxZoom) {
            const shift = z - this.maxZoom
            return this.index.getTile(
                this.maxZoom,
                x >> shift,
                y >> shift
            )
        }
        return this.index.getTile(z, x, y)
    }

    /** The source feature a tile feature came from. */
    sourceFeature(tileFeature) {
        const index = tileFeature?.tags?.[SOURCE_INDEX_KEY]
        return index == null ? null : this.features[index] || null
    }

    /**
     * The source feature at a lng/lat, or null.
     *
     * Only the features of the single tile containing the point are tested,
     * so cost is bounded by tile density rather than dataset size — this is
     * what keeps picking cheap on a layer with thousands of features.
     *
     * @param {number} lng
     * @param {number} lat
     * @param {number} z - zoom to test at (the one being displayed)
     * @param {number} [tolerancePx=5] - click slop for points and lines, in
     *        screen-ish pixels (tile coordinates are scaled to a 256px tile)
     */
    featureAt(lng, lat, z, tolerancePx = 5) {
        const zoom = Math.max(0, Math.min(Math.round(z), this.maxZoom))
        const fractional = lngLatToTile(lng, lat, zoom)
        const tileX = Math.floor(fractional.x)
        const tileY = Math.floor(fractional.y)

        const tile = this.getTile(zoom, tileX, tileY)
        if (!tile || !tile.features) return null

        // Point → tile-local coordinates, matching the tile's own extent.
        const px = (fractional.x - tileX) * this.extent
        const py = (fractional.y - tileY) * this.extent
        // A tile is drawn 256px wide, so a pixel of slop is extent/256 units.
        const tolerance = tolerancePx * (this.extent / 256)
        const sqTolerance = tolerance * tolerance

        // Last drawn wins, mirroring the painter's-algorithm order the
        // rasterizer uses: whatever is on top is what the user aimed at.
        for (let i = tile.features.length - 1; i >= 0; i--) {
            const feature = tile.features[i]
            if (this._featureHit(feature, px, py, sqTolerance))
                return this.sourceFeature(feature)
        }
        return null
    }

    /** Whether a tile feature contains / is within tolerance of a point. */
    _featureHit(feature, px, py, sqTolerance) {
        const geometry = feature.geometry
        if (!geometry || geometry.length === 0) return false

        if (feature.type === TYPE_POINT) {
            for (const point of geometry) {
                const dx = point[0] - px
                const dy = point[1] - py
                if (dx * dx + dy * dy <= sqTolerance) return true
            }
            return false
        }

        if (feature.type === TYPE_LINE) {
            for (const line of geometry) {
                for (let i = 1; i < line.length; i++) {
                    const d = sqDistToSegment(
                        px,
                        py,
                        line[i - 1][0],
                        line[i - 1][1],
                        line[i][0],
                        line[i][1]
                    )
                    if (d <= sqTolerance) return true
                }
            }
            return false
        }

        if (feature.type === TYPE_POLYGON) return pointInRings(px, py, geometry)

        return false
    }
}

// url → Promise<GeoJSONSlicer>. Shared so the 2D and 3D renderings of one
// layer fetch and slice a single time.
const _sliceCache = {}

/** Cache key: the same URL sliced with different options is a different index. */
function _cacheKey(url, options) {
    return `${url}::${options.maxZoom ?? ''}:${options.tolerance ?? ''}:${
        options.extent ?? ''
    }`
}

/**
 * Fetch a GeoJSON document and slice it, reusing an in-flight or completed
 * slice of the same URL.
 *
 * @param {string} url
 * @param {object} [options] - geojson-vt options
 * @returns {Promise<GeoJSONSlicer>}
 */
export function sliceUrl(url, options = {}) {
    const key = _cacheKey(url, options)
    if (_sliceCache[key]) return _sliceCache[key]

    const promise = fetch(url)
        .then((response) => {
            if (!response.ok)
                throw new Error(`HTTP ${response.status} fetching ${url}`)
            return response.json()
        })
        .then((geojson) => new GeoJSONSlicer(geojson, options))
        .catch((err) => {
            // Don't cache a failure: a transient error would otherwise make
            // the layer permanently un-loadable for the session.
            delete _sliceCache[key]
            throw err
        })

    _sliceCache[key] = promise
    return promise
}

/** Drop a URL's cached index (a refreshed layer must re-slice new data). */
export function invalidateSlice(url) {
    for (const key of Object.keys(_sliceCache))
        if (key.startsWith(`${url}::`)) delete _sliceCache[key]
}

export { SOURCE_INDEX_KEY }
export default GeoJSONSlicer

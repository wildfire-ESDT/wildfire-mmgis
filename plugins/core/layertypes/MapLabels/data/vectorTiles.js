// Loading OpenMapTiles vector tiles: the tile URL behind a TileJSON, and a cache of parsed tiles.

import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'
import { MAXIMUM_CACHED_TILES } from '../logic/constants'

/** A TileJSON URL is read for its current tile URL, which some providers version. */
export async function resolveTileSource(tilesUrlSetting, defaultMaximumTileZoom) {
    if (tilesUrlSetting.includes('{z}')) {
        return { tileUrlTemplate: tilesUrlSetting, maximumTileZoom: defaultMaximumTileZoom }
    }
    const response = await fetch(tilesUrlSetting)
    if (!response.ok) throw new Error(`TileJSON request failed: HTTP ${response.status}`)
    const tileJson = await response.json()
    return { tileUrlTemplate: tileJson.tiles[0], maximumTileZoom: tileJson.maxzoom ?? defaultMaximumTileZoom }
}

/** Parsed tiles by "tileZoom/x/y", each fetched once and reused at every label detail zoom; least recently used first. */
export class VectorTileCache {
    constructor(tileUrlTemplate) {
        this._tileUrlTemplate = tileUrlTemplate
        // tilePart -> { vectorTile: Promise, abortController, isLoading }
        this._tiles = new Map()
    }

    get size() {
        return this._tiles.size
    }

    /** The tile's parsed data, or null when it is empty, missing or failed to load. */
    vectorTileFor(tilePart) {
        const cachedTile = this._tiles.get(tilePart)
        if (cachedTile) {
            this._tiles.delete(tilePart)
            this._tiles.set(tilePart, cachedTile)
            return cachedTile.vectorTile
        }

        const tile = { abortController: new AbortController(), isLoading: true }
        tile.vectorTile = fetchVectorTile(this._urlOf(tilePart), tile.abortController.signal)
            .catch((error) => {
                if (this._tiles.get(tilePart) === tile) this._tiles.delete(tilePart)
                if (error.name !== 'AbortError') console.warn(`3D Roads and Labels: tile ${tilePart} failed:`, error)
                return null
            })
            .finally(() => {
                tile.isLoading = false
            })
        this._tiles.set(tilePart, tile)
        if (this._tiles.size > MAXIMUM_CACHED_TILES) this._tiles.delete(this._tiles.keys().next().value)
        return tile.vectorTile
    }

    /** Stops downloads the view no longer needs; tiles already loaded stay cached. */
    abortLoadsOutside(neededTileParts) {
        for (const [tilePart, tile] of this._tiles) {
            if (tile.isLoading && !neededTileParts.has(tilePart)) {
                tile.abortController.abort()
                this._tiles.delete(tilePart)
            }
        }
    }

    abortAllLoads() {
        for (const tile of this._tiles.values()) {
            if (tile.isLoading) tile.abortController.abort()
        }
    }

    clear() {
        this._tiles.clear()
    }

    _urlOf(tilePart) {
        const [tileZoom, tileX, tileY] = tilePart.split('/')
        return this._tileUrlTemplate.replace('{z}', tileZoom).replace('{x}', tileX).replace('{y}', tileY)
    }
}

async function fetchVectorTile(url, signal) {
    const response = await fetch(url, { signal })
    if (!response.ok) return null
    const tileBytes = await gunzipIfNeeded(await response.arrayBuffer())
    return tileBytes.byteLength === 0 ? null : new VectorTile(new Pbf(tileBytes))
}

async function gunzipIfNeeded(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer)
    if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes
    const decompressed = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')))
    return new Uint8Array(await decompressed.arrayBuffer())
}

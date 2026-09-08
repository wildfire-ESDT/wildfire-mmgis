/**
 * VectorTile layer type — map renderer.
 *
 * Renders Mapbox Vector Tiles (MVT/PBF) on the 2D map via L.vectorGrid
 * (or the simplified variant for dense extrusion tiles). Feature interactions
 * (click → metadata capture + interaction pipeline, hover → cursor info) are
 * engine-neutral MMGIS logic and live here; the Leaflet VectorGrid construction
 * rides through the MapRenderer escape hatch (`mctx.raw`).
 *
 * Frozen renderer interface:
 *   ctx = { evenIfOff, forceGeoJSON, isRefresh, mapContext, resolvedUrl }
 */
import L_ from '@basics/Layers_/Layers_'
import LayerTypeRegistry from '@basics/Layers_/registry/LayerTypeRegistry'
import MapRenderer from '@basics/Map_/MapRenderer'
import MetadataCapturer from '@basics/Layers_/capture/MetadataCapturer.js'
import {
    runInteractions,
    resolveLayerInteractions,
} from '@basics/InteractionRunner/InteractionRunner'
import CursorInfo from '@basics/UserInterface_/components/CursorInfo/CursorInfo'
import './lib/SimplifiedVectorGrid'
import './lib/LeafletSlicedVectorGrid'
import { isSliced } from './globe/layerConfig'
import { resolveFeatureStyle } from './lib/slicedStyle'
import { SOURCE_INDEX_KEY } from './lib/GeoJSONSlicer'
import { pickIncidentNameKey, frontFacingLabel } from './lib/sliceMetadata'

// The single sublayer name our sliced grid gives generated tiles.
const SLICED_VT_LAYER = 'sliced'

/** The GeoJSON document behind a sliced layer, or null if it can't be had. */
async function fetchGeoJSON(url, layerName) {
    try {
        const response = await fetch(url)
        if (!response.ok)
            throw new Error(`HTTP ${response.status} fetching ${url}`)
        return await response.json()
    } catch (err) {
        console.error(
            `Failed to fetch GeoJSON for sliced layer "${layerName}":`,
            err
        )
        return null
    }
}

async function make(layerObj, ctx = {}) {
    const mctx = MapRenderer.context(ctx.mapContext)
    const L = mctx.raw
    const Map_ = L_.Map_

    let layerUrl = L_.getUrl(layerObj.type, layerObj.url, layerObj)

    let urlSplit = layerObj.url.split(':')

    if (urlSplit[0].toLowerCase() === 'geodatasets' && urlSplit[1] != null) {
        layerUrl =
            `${window.mmgisglobal.ROOT_PATH || ''}/api/geodatasets/get?layer=${
                urlSplit[1]
            }` + '&type=mvt&x={x}&y={y}&z={z}'
    }

    // A sliced layer's source is one GeoJSON document rather than a tileset,
    // so the tiles come from our own GeoJSONSlicer (LeafletSlicedVectorGrid)
    // instead of per-tile requests. Everything downstream — styling, click,
    // hover — is the same VectorGrid, so only the factory differs.
    const sliced = isSliced(layerObj)

    var clearHighlight = function () {
        for (let l of Object.keys(L_.layers.data)) {
            if (L_.layers.layer[l]) {
                var highlight = L_.layers.layer[l].highlight
                if (highlight) {
                    L_.layers.layer[l].resetFeatureStyle(highlight)
                }
                L_.layers.layer[l].highlight = null
            }
        }
    }
    var timedSelectTimeout = null
    var timedSelect = function (layer, layerName, e) {
        clearTimeout(timedSelectTimeout)
        timedSelectTimeout = setTimeout(
            (function (layer, layerName, e) {
                return function () {
                    let ell = { latlng: null }
                    if (e.latlng != null)
                        ell.latlng = JSON.parse(JSON.stringify(e.latlng))
                    MetadataCapturer.populateMetadata(layer, async () => {
                        const layerData = L_.layers.data[layerName]
                        const typeInteractions =
                            LayerTypeRegistry.defaultInteractions(
                                layerData.type
                            )
                        const pipeline = resolveLayerInteractions(
                            layerData,
                            undefined,
                            typeInteractions.ids
                        ).click

                        L_.clearFeatureAttachments()

                        const ctx = {
                            Map_,
                            feature:
                                L_.layers.layer[layerName].activeFeatures[0],
                            layer,
                            layerName,
                            layerData,
                            layerVar: layerData.variables || {},
                            event: ell,
                            eventType: 'click',
                            layerTypeChain: LayerTypeRegistry.typeChain(
                                layerData.type
                            ),
                            typeInteractionConfigs: typeInteractions.settings,
                            additional: null,
                            stop: false,
                            state: {
                                preFeatures:
                                    L_.layers.layer[layerName].activeFeatures,
                            },
                        }

                        await runInteractions(pipeline, ctx)
                        L_.layers.layer[layerName].activeFeatures = []
                    })
                }
            })(layer, layerName, e),
            100
        )
    }

    // A sliced layer has exactly one sublayer, generated here rather than
    // authored in the tileset, so it is styled from the layer's own style
    // fields (resolved per feature, as the globe does) instead of from a
    // vtLayer map the user would have no way to name.
    const slicedStyles = {
        // L.VectorGrid calls this per feature, inline in its own render loop
        // with no try/catch around it — an exception here doesn't just style
        // that feature wrong, it aborts the rest of that tile's feature loop
        // silently (no click/hover for anything the tile hadn't gotten to
        // yet). Catching defensively here keeps one bad feature from taking
        // the whole tile's interactivity down with it.
        [SLICED_VT_LAYER]: (properties) => {
            try {
                const style = resolveFeatureStyle(
                    layerObj.style || {},
                    properties
                )
                return {
                    color: style.color,
                    weight: style.weight,
                    opacity: style.opacity,
                    fill: true,
                    fillColor: style.fillColor,
                    fillOpacity: style.fillOpacity,
                    radius: style.radius,
                    // L.SVG._initPath only adds the 'leaflet-interactive'
                    // CSS class (which is what makes a path's fill, not just
                    // its stroke, register pointer events) when the path's
                    // OWN options say so — this is the feature-level style
                    // object, so it has to be set here, same as any other
                    // interactive Leaflet path.
                    interactive: true,
                }
            } catch (err) {
                console.error(
                    `Sliced style resolution failed for layer "${layerObj.name}":`,
                    err
                )
                return L.Path.prototype.options
            }
        },
    }

    // Hide sublayers not explicitly listed in vtLayer styles.
    // Without this, L.vectorGrid renders all sublayers with default blue styling.
    const vtLayerStyles = layerObj.style.vtLayer || {}
    const resolvedVtLayerStyles = new Proxy(vtLayerStyles, {
        get(target, prop) {
            if (prop in target) return target[prop]
            return {
                fill: false,
                stroke: false,
                weight: 0,
                fillOpacity: 0,
                opacity: 0,
            }
        },
        has() {
            return true
        },
    })

    var vectorTileOptions = {
        layerName: layerObj.name,
        // Deliberately L.svg.tile even for sliced layers, not L.canvas.tile:
        // this vendored bundle's L.Canvas.Tile overrides onAdd to a no-op,
        // which skips the base Renderer's _initEvents() — its _onClick/
        // _onMouseMove exist but are never wired to any DOM event, so canvas
        // tiles in this bundle are silently non-interactive. (Tried it while
        // chasing a since-fixed crash that turned out to be unrelated to the
        // renderer — see GeoJSONSlicer's extent-merge fix.)
        rendererFactory: L.svg.tile,
        vectorTileLayerStyles: sliced ? slicedStyles : resolvedVtLayerStyles,
        interactive: true,
        minZoom: layerObj.minZoom,
        maxZoom: layerObj.maxZoom,
        maxNativeZoom: layerObj.maxNativeZoom,
        // Called unconditionally per feature in the vendor library's render
        // loop with no surrounding try/catch — an exception here silently
        // drops that feature's interactivity and, per that loop's structure,
        // every feature after it in the same tile. Caught defensively so a
        // parse failure on one feature can't take the whole tile down.
        getFeatureId: (function (vtId) {
            return function (f) {
                try {
                    if (
                        f.properties.properties &&
                        typeof f.properties.properties === 'string'
                    ) {
                        f.properties = JSON.parse(f.properties.properties)
                    }
                    // A sliced layer's features come from a GeoJSON document
                    // that needn't carry a unique property, so fall back to
                    // the id GeoJSONSlicer stamps on every feature (see
                    // SOURCE_INDEX_KEY) — without one, selection highlighting
                    // (setFeatureStyle) has nothing to key on.
                    const id = f.properties[vtId]
                    return id != null ? id : f.properties[SOURCE_INDEX_KEY]
                } catch (err) {
                    console.error(
                        `getFeatureId failed for layer "${layerObj.name}":`,
                        err
                    )
                    return undefined
                }
            }
        })(layerObj.style.vtId),
    }

    // For extrusion-enabled layers (e.g., OSM buildings), use the simplified
    // variant with a moderate tolerance to reduce polygon vertex counts. This
    // significantly improves 2D rendering performance for dense tiles.
    if (layerObj.extrudeEnabled && layerObj.simplifyTolerance !== 0) {
        vectorTileOptions.simplifyTolerance = layerObj.simplifyTolerance ?? 4
    }

    // Slice mode fetches the document up front and tiles it with our own
    // GeoJSONSlicer (see LeafletSlicedVectorGrid — same slicer the globe
    // uses, run on the main thread); tileset mode requests tiles as the map
    // needs them.
    let grid
    if (sliced) {
        const geojson = await fetchGeoJSON(layerUrl, layerObj.name)
        if (geojson == null) {
            L_._layersLoaded[L_._layersOrdered.indexOf(layerObj.name)] = true
            L_.Map_.allLayersLoaded()
            return
        }
        grid = L.vectorGrid.geojsonSliced(geojson, {
            ...vectorTileOptions,
            vectorTileLayerName: SLICED_VT_LAYER,
            // geojson-vt stops simplifying here; past it the same geometry is
            // reused, so this is the layer's full-detail zoom.
            maxZoom: layerObj.maxNativeZoom ?? layerObj.maxZoom ?? 14,
            tolerance: layerObj.sliceTolerance ?? 3,
        })
    } else {
        const vectorGridFactory =
            vectorTileOptions.simplifyTolerance > 0
                ? L.simplifiedVectorGrid.protobuf
                : L.vectorGrid.protobuf
        grid = vectorGridFactory(layerUrl, vectorTileOptions)
    }

    L_.layers.layer[layerObj.name] = grid
        .on('click', function (e, b, x) {
            let layerName = e.target.options.layerName
            let vtId = L_.layers.layer[layerName].vtId
            // getFeatureId is what setFeatureStyle actually keys highlighting
            // off of — reading properties[vtId] directly here skips its
            // fallback (the id geojson-vt generates when a sliced layer's
            // data carries no configured vtId), so nothing would highlight.
            const getFeatureId = L_.layers.layer[layerName].options.getFeatureId
            clearHighlight()
            L_.layers.layer[layerName].highlight = getFeatureId
                ? getFeatureId(e.layer)
                : e.layer.properties[vtId]

            L_.layers.layer[layerName].setFeatureStyle(
                L_.layers.layer[layerName].highlight,
                {
                    weight: 2,
                    color: 'red',
                    opacity: 1,
                    fillColor: 'red',
                    fill: true,
                    radius: 4,
                    fillOpacity: 1,
                }
            )
            L_.layers.layer[layerName].activeFeatures =
                L_.layers.layer[layerName].activeFeatures || []
            L_.layers.layer[layerName].activeFeatures.push({
                type: 'Feature',
                properties: e.layer.properties,
                geometry: {},
            })

            Map_.activeLayer = e.layer
            if (Map_.activeLayer) L_.Map_._justSetActiveLayer = true

            let p = e.sourceTarget._point

            if (p) {
                for (var i in e.layer._renderer._features) {
                    if (
                        e.layer._renderer._features[i].feature._pxBounds.min
                            .x <= p.x &&
                        e.layer._renderer._features[i].feature._pxBounds.max
                            .x >= p.x &&
                        e.layer._renderer._features[i].feature._pxBounds.min
                            .y <= p.y &&
                        e.layer._renderer._features[i].feature._pxBounds.max
                            .y >= p.y &&
                        (getFeatureId
                            ? getFeatureId(
                                  e.layer._renderer._features[i].feature
                              ) != getFeatureId(e.layer)
                            : e.layer._renderer._features[i].feature
                                  .properties[vtId] !=
                              e.layer.properties[vtId])
                    ) {
                        L_.layers.layer[layerName].activeFeatures.push({
                            type: 'Feature',
                            properties:
                                e.layer._renderer._features[i].feature
                                    .properties,
                            geometry: {},
                        })
                    }
                }
            }

            timedSelect(e.layer, layerName, e)

            L.DomEvent.stop(e)
        })
        .on(
            'mouseover',
            (function (vtKey) {
                return function (e, a, b, c) {
                    if (vtKey != null)
                        CursorInfo.update(
                            vtKey + ': ' + e.layer.properties[vtKey],
                            null,
                            false
                        )
                }
            })(layerObj.style.vtKey)
        )
        .on('mouseout', function () {
            CursorInfo.hide()
        })

    L_.layers.layer[layerObj.name].vtId = layerObj.style.vtId
    L_.layers.layer[layerObj.name].vtKey = layerObj.style.vtKey

    // The click/hover chain above is DOM-delegated through Leaflet's own
    // per-tile interactivity, which a protobuf/tileset grid's <svg> (appended
    // straight to its pane) satisfies but a sliced grid's <svg> (nested one
    // level deeper, inside GridLayer's own tile-container wrapper) does not
    // reliably receive. Sliced layers are click/hover-tested directly here
    // instead, against a definitely-reliable map-level event, and go through
    // the same L_.selectFeature every other layer type uses — which is what
    // gives a click the same effect on the globe as on the map, and vice
    // versa (see selection.js's VectorGrid branch).
    if (sliced) {
        const map = Map_.map
        // Wrapped defensively: these are plain `map.on(...)` listeners, not
        // scoped to this grid by Leaflet, so a stale one left behind by an
        // earlier reload of this same layer (if its 'remove' was ever missed)
        // must not be able to throw and block whichever listener Leaflet
        // registered after it — including a newer, correct one.
        const onSlicedClick = (e) => {
            try {
                const feature = grid.featureAt(e.latlng, map.getZoom())
                if (!feature) return
                L_.selectFeature(layerObj.name, feature)
                // L_.selectFeature only restyles + syncs the globe; showing
                // the feature's own properties (incident name, acres, date,
                // …) in the description panel — and notifying tools such as
                // WildfireWhatIf, which reads `.feature.geometry` off this
                // exact notification to draw its own bbox around whatever
                // was clicked — is a separate, explicit step for every layer
                // type.
                //
                // `feature` is passed through whole and unmodified (not a
                // renamed/stripped copy): setActiveFeature makes its own
                // (redundant but harmless when the properties match) globe
                // highlight call with whatever object it's given, and the
                // globe matches a 2D-originated selection back to its own
                // copy by exact property equality — a feature carrying an
                // extra or renamed key never matches, silently failing that
                // second call. useKeyAsName points the description panel's
                // header at whichever real property holds the incident
                // name, so it's still labeled sensibly without touching the
                // feature that has to keep matching.
                L_.setActiveFeature({
                    feature,
                    properties: feature.properties,
                    useKeyAsName:
                        pickIncidentNameKey(layerObj, feature.properties) ??
                        undefined,
                    options: { layerName: layerObj.name },
                })
            } catch (err) {
                console.error(
                    `Sliced click handling failed for layer "${layerObj.name}":`,
                    err
                )
            }
        }
        const onSlicedHover = (e) => {
            try {
                const feature = grid.featureAt(e.latlng, map.getZoom())
                // No real DOM element under the cursor to carry its own
                // `cursor: pointer` (we bypass Leaflet's per-tile DOM
                // interactivity entirely for a sliced layer — see the click
                // handler above), so the map container's cursor is set by
                // hand to give the same hand-cursor affordance as any other
                // clickable layer.
                map.getContainer().style.cursor = feature ? 'pointer' : ''

                if (!feature) {
                    CursorInfo.hide()
                    return
                }

                const vtKey = layerObj.style.vtKey
                if (vtKey != null) {
                    CursorInfo.update(
                        `${vtKey}: ${feature.properties[vtKey]}`,
                        null,
                        false
                    )
                    return
                }

                // No vtKey configured (it's a vector-tile-specific field the
                // user has no reason to set on a sliced layer) — show the
                // same "Fire Incident: <name> / Acres: <n>" label the click
                // header and the globe's hover both use.
                const label = frontFacingLabel(layerObj, feature.properties)
                if (label != null) CursorInfo.update(label, null, false)
                else CursorInfo.hide()
            } catch (err) {
                console.error(
                    `Sliced hover handling failed for layer "${layerObj.name}":`,
                    err
                )
            }
        }
        // Bound to the grid's own add/remove (fired by Leaflet whenever this
        // layer is added to or taken off the map) rather than registered
        // once here, so toggling the layer off doesn't leave a listener
        // hit-testing a layer that's no longer showing.
        grid.on('add', () => {
            map.on('click', onSlicedClick)
            map.on('mousemove', onSlicedHover)
        })
        grid.on('remove', () => {
            map.off('click', onSlicedClick)
            map.off('mousemove', onSlicedHover)
        })
    }

    L_.setLayerOpacity(layerObj.name, L_.layers.opacity[layerObj.name])

    L_._layersLoaded[L_._layersOrdered.indexOf(layerObj.name)] = true
    L_.Map_.allLayersLoaded()
}

export default {
    make,
}

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
import { isSliced, sliceOptions } from './globe/layerConfig'
import { resolveFeatureStyle } from './lib/slicedStyle'
import {
    SOURCE_INDEX_KEY,
    sliceUrl,
    invalidateSlice,
} from './lib/GeoJSONSlicer'
import { frontFacingLabel } from './lib/sliceMetadata'
import {
    layerInteractionsDisabled,
    selectSlicedFeature,
    clearSlicedSelection,
} from './lib/slicedSelection'
import {
    timeResolvedSliceUrl,
    slicedGlobeLayer,
    setAppliedSliceUrl,
    beginSliceRequest,
    isLatestSliceRequest,
} from './lib/sliceTime'

// The single sublayer name our sliced grid gives generated tiles.
const SLICED_VT_LAYER = 'sliced'

// Hover bookkeeping shared by every sliced grid on the map. CursorInfo and
// the map container's cursor are app-wide, so a grid may only take down a
// tooltip or cursor it put up itself: hiding/resetting on every mousemove
// with nothing under the cursor killed tooltips other layers and tools had
// shown, wiped tools' crosshair cursors, and — with two sliced layers —
// had one grid fading out the tooltip the other had just shown.
const slicedHover = {
    tooltipOwner: null,
    tooltipText: null,
    cursorOwner: null,
    cursorBefore: '',
}

function showSlicedTooltip(owner, text) {
    CursorInfo.update(text, null, false)
    slicedHover.tooltipOwner = owner
    slicedHover.tooltipText = text
}

function hideSlicedTooltip(owner) {
    if (slicedHover.tooltipOwner !== owner) return
    // Still ours only if nothing has replaced its text since.
    if (CursorInfo.cursorInfoDiv?.text() === slicedHover.tooltipText)
        CursorInfo.hide()
    slicedHover.tooltipOwner = null
    slicedHover.tooltipText = null
}

function setSlicedCursor(owner, container, pointer) {
    if (pointer) {
        if (slicedHover.cursorOwner == null)
            slicedHover.cursorBefore =
                container.style.cursor === 'pointer'
                    ? ''
                    : container.style.cursor
        slicedHover.cursorOwner = owner
        container.style.cursor = 'pointer'
    } else if (slicedHover.cursorOwner === owner) {
        slicedHover.cursorOwner = null
        // Put back whatever was there before (a tool's crosshair, say),
        // unless something has set its own cursor since.
        if (container.style.cursor === 'pointer')
            container.style.cursor = slicedHover.cursorBefore
    }
}

/** A configured zoom as a number, or undefined (Leaflet's "no limit"). */
function zoomOption(zoom) {
    const parsed = parseInt(zoom, 10)
    return isNaN(parsed) ? undefined : parsed
}

async function make(layerObj, ctx = {}) {
    // Whatever happens building it, this layer has to end up counted as
    // loaded: app startup (Map_.allLayersLoaded → essenceFina, addVisible,
    // finalizeTools, L_.loaded) waits on every layer, and makeLayer's own
    // catch doesn't mark it — one throw here (bad GeoJSON, a missing
    // `style`, a slice failure) used to leave the whole app half-started.
    // The error itself still propagates, so makeLayer logs it and reports
    // the layer as not made.
    try {
        await makeGrid(layerObj, ctx)
    } finally {
        L_._layersLoaded[L_._layersOrdered.indexOf(layerObj.name)] = true
        L_.Map_.allLayersLoaded()
    }
}

async function makeGrid(layerObj, ctx) {
    const mctx = MapRenderer.context(ctx.mapContext)
    const L = mctx.raw
    const Map_ = L_.Map_
    // A layer needn't have been configured with any style at all.
    const layerStyle = layerObj.style || {}

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
                const style = resolveFeatureStyle(layerStyle, properties)
                return {
                    color: style.color,
                    weight: style.weight,
                    opacity: style.opacity,
                    fill: true,
                    fillColor: style.fillColor,
                    fillOpacity: style.fillOpacity,
                    radius: style.radius,
                    // Not interactive: a sliced layer's click/hover are
                    // hit-tested from map-level events (see below), and a
                    // path that took pointer events itself (mmgis.css gives
                    // any 'leaflet-interactive' tile path them) would only
                    // compete with that.
                    interactive: false,
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
    const vtLayerStyles = layerStyle.vtLayer || {}
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
        })(layerStyle.vtId),
    }

    // For extrusion-enabled layers (e.g., OSM buildings), use the simplified
    // variant with a moderate tolerance to reduce polygon vertex counts. This
    // significantly improves 2D rendering performance for dense tiles.
    if (layerObj.extrudeEnabled && layerObj.simplifyTolerance !== 0) {
        vectorTileOptions.simplifyTolerance = layerObj.simplifyTolerance ?? 4
    }

    // Slice mode fetches the document up front and tiles it with our own
    // GeoJSONSlicer (see LeafletSlicedVectorGrid), through the same sliceUrl
    // cache and options the globe uses — one fetch/parse/slice serves both
    // views; tileset mode requests tiles as the map needs them.
    let grid
    if (sliced) {
        const slice = sliceOptions(layerObj)
        const sourceUrl = timeResolvedSliceUrl(layerObj, ctx.resolvedUrl)
        // A deliberate refresh wants the document as it is now.
        if (ctx.isRefresh) invalidateSlice(sourceUrl)
        let slicer
        try {
            slicer = await sliceUrl(sourceUrl, slice)
        } catch (err) {
            console.error(
                `Failed to fetch/slice GeoJSON for sliced layer "${layerObj.name}":`,
                err
            )
            return
        }
        grid = L.vectorGrid.geojsonSliced(slicer, {
            ...vectorTileOptions,
            vectorTileLayerName: SLICED_VT_LAYER,
            // Leaflet's own cutoffs for showing the layer at all — the
            // layer's configured zooms, normalized (a null maxZoom would
            // read to GridLayer as "hide above zoom 0"). The slice's
            // full-detail zoom is separate: past it the grid overzooms
            // (maxNativeZoom, set from the slicer) rather than vanishing.
            minZoom: zoomOption(layerObj.minZoom),
            maxZoom: zoomOption(layerObj.maxZoom),
            maxNativeZoom: slice.maxZoom,
            // Click/hover are hit-tested from map-level events below; the
            // per-tile DOM chain must not also run (and swallow the click).
            interactive: false,
        })
    } else {
        const vectorGridFactory =
            vectorTileOptions.simplifyTolerance > 0
                ? L.simplifiedVectorGrid.protobuf
                : L.vectorGrid.protobuf
        grid = vectorGridFactory(layerUrl, vectorTileOptions)
    }

    // Registered in (and, off the main map, added to) whichever map this
    // make is for — the Animation tool builds layers into its own offscreen
    // map and registry, which must not replace the live map's grid.
    mctx.layerRegistry.layer[layerObj.name] = grid
    if (!mctx.default) grid.addTo(mctx.map)

    grid.vtId = layerStyle.vtId
    grid.vtKey = layerStyle.vtKey

    if (sliced) {
        if (mctx.default) {
            wireSlicedInteractions(layerObj, grid, mctx.map)
            syncSliceToTime(layerObj)
        }
    } else {
        wireTilesetInteractions(layerObj, grid, {
            L,
            Map_,
            clearHighlight,
            timedSelect,
        })
    }

    if (mctx.default)
        L_.setLayerOpacity(layerObj.name, L_.layers.opacity[layerObj.name])
    else grid.setOpacity(parseFloat(L_.layers.opacity[layerObj.name] ?? 1))
}

/**
 * The per-tile DOM click/hover chain of a tileset (protobuf) grid. A sliced
 * grid doesn't get this — see wireSlicedInteractions.
 */
function wireTilesetInteractions(layerObj, grid, deps) {
    const { L, Map_, clearHighlight, timedSelect } = deps
    grid
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
            })((layerObj.style || {}).vtKey)
        )
        .on('mouseout', function () {
            CursorInfo.hide()
        })
}

/**
 * Click/hover for a sliced grid, hit-tested against map-level events.
 *
 * A tileset grid's per-tile DOM chain (wireTilesetInteractions) relies on
 * Leaflet's per-tile interactivity, which a protobuf/tileset grid's <svg>
 * (appended straight to its pane) satisfies but a sliced grid's <svg>
 * (nested one level deeper, inside GridLayer's own tile-container wrapper)
 * does not reliably receive. Sliced layers are click/hover-tested directly
 * here instead, and go through the same L_.selectFeature every other layer
 * type uses — which is what gives a click the same effect on the globe as on
 * the map, and vice versa (see selection.js's VectorGrid branch).
 */
function wireSlicedInteractions(layerObj, grid, map) {
    // The grid draws nothing at a zoom outside its min/maxZoom (GridLayer
    // compares the rounded zoom, with an undefined bound meaning "none"), so
    // nothing can be clicked or hovered there either.
    const inZoomRange = () => {
        const zoom = Math.round(map.getZoom())
        const { minZoom, maxZoom } = grid.options
        return (
            !(maxZoom !== undefined && zoom > maxZoom) &&
            !(minZoom !== undefined && zoom < minZoom)
        )
    }
    const featureAt = (latlng) =>
        inZoomRange() ? grid.featureAt(latlng, map.getZoom()) : null

    // Wrapped defensively: these are plain `map.on(...)` listeners, not
    // scoped to this grid by Leaflet, so a stale one left behind by an
    // earlier reload of this same layer (if its 'remove' was ever missed)
    // must not be able to throw and block whichever listener Leaflet
    // registered after it — including a newer, correct one.
    const onSlicedClick = (e) => {
        try {
            // A tool that has taken over map clicks (Measure, …) gets them
            // instead — the same check every other layer's click makes.
            if (layerInteractionsDisabled()) return
            const feature = featureAt(e.latlng)
            if (!feature) return
            selectSlicedFeature(layerObj.name, feature)
        } catch (err) {
            console.error(
                `Sliced click handling failed for layer "${layerObj.name}":`,
                err
            )
        }
    }
    const endHover = () => {
        hideSlicedTooltip(grid)
        setSlicedCursor(grid, map.getContainer(), false)
    }
    const onSlicedHover = (e) => {
        try {
            const feature = featureAt(e.latlng)
            // No real DOM element under the cursor to carry its own
            // `cursor: pointer` (a sliced layer's paths aren't interactive
            // — see this function's header), so the map container's cursor
            // is set by hand to give the same hand-cursor affordance as any
            // other clickable layer — unless a click wouldn't select it.
            setSlicedCursor(
                grid,
                map.getContainer(),
                feature != null && !layerInteractionsDisabled()
            )
            if (!feature) {
                hideSlicedTooltip(grid)
                return
            }

            const properties = feature.properties || {}
            const vtKey = (layerObj.style || {}).vtKey
            // No vtKey configured (it's a vector-tile-specific field the
            // user has no reason to set on a sliced layer) — show the same
            // "Fire Incident: <name> / Acres: <n>" label the click header
            // and the globe's hover both use.
            const label =
                vtKey != null
                    ? `${vtKey}: ${properties[vtKey]}`
                    : frontFacingLabel(layerObj, properties)
            if (label != null) showSlicedTooltip(grid, label)
            else hideSlicedTooltip(grid)
        } catch (err) {
            console.error(
                `Sliced hover handling failed for layer "${layerObj.name}":`,
                err
            )
        }
    }
    // Bound to the grid's own add/remove (fired by Leaflet whenever this
    // layer is added to or taken off the map) rather than registered once
    // here, so toggling the layer off doesn't leave a listener hit-testing a
    // layer that's no longer showing — nor a tooltip or cursor it put up.
    grid.on('add', () => {
        map.on('click', onSlicedClick)
        map.on('mousemove', onSlicedHover)
        map.on('mouseout', endHover)
    })
    grid.on('remove', () => {
        map.off('click', onSlicedClick)
        map.off('mousemove', onSlicedHover)
        map.off('mouseout', endHover)
        endHover()
    })
}

async function syncSliceToTime(layerObj, options = {}) {
    const layerName = layerObj.name
    const url = timeResolvedSliceUrl(
        layerObj,
        options.template,
        options.timeFormat
    )
    const request = beginSliceRequest(layerName)
    if (options.force) invalidateSlice(url)

    let slicer
    try {
        slicer = await sliceUrl(url, sliceOptions(layerObj))
    } catch (err) {
        console.error(
            `Failed to fetch/slice GeoJSON for sliced layer "${layerObj.name}":`,
            err
        )
        return
    }
    if (!isLatestSliceRequest(layerName, request)) return

    const grid = L_.layers.layer[layerName]
    const globeLayer = slicedGlobeLayer(layerName)
    const gridChanges = grid?.setSlicer != null && grid._slicer !== slicer
    const globeChanges = globeLayer != null && globeLayer.slicer !== slicer

    if (
        (gridChanges || globeChanges) &&
        L_.activeFeature?.layerName === layerName
    )
        clearSlicedSelection()
    if (gridChanges) grid.setSlicer(slicer)
    if (globeChanges) globeLayer.setSlicer(slicer, url)

    const previousUrl = setAppliedSliceUrl(layerName, url)
    if (previousUrl != null && previousUrl !== url) invalidateSlice(previousUrl)
}

function timeChange(layerObj, ctx = {}) {
    if (!isSliced(layerObj)) return ctx.reload()
    if (ctx.evenIfControlled !== true && layerObj.controlled === true) return
    if (!L_.layers.on[layerObj.name] && !ctx.evenIfOff) return

    return syncSliceToTime(layerObj, {
        template: ctx.changedUrl ?? layerObj.url,
        timeFormat: ctx.timeFormat,
        force: ctx.forceRequery === true,
    })
}

function onToggle(layerObj, ctx = {}) {
    if (!ctx.visible || ctx.hadToMake || ctx.globeOnly) return
    if (!isSliced(layerObj) || layerObj.time?.enabled !== true) return
    syncSliceToTime(layerObj)
}

export default {
    make,
    timeChange,
    onToggle,
}

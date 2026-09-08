import F_ from '../../Formulae_/Formulae_'
import Description from '../../UserInterface_/components/Description/Description'
import ToolController_ from '../../ToolController_/ToolController_'
import LayerTypeRegistry from '../registry/LayerTypeRegistry'
import { sameFeature } from './identity'

import $ from 'jquery'

export function setActiveFeature(L_, layer) {
    if (layer && layer.feature && layer.options?.layerName)
        L_.activeFeature = {
            feature: layer.feature,
            layerName: layer.options.layerName,
            layer: layer,
        }
    else L_.activeFeature = null

    // Deselecting (clicking empty map space, or another layer's feature
    // elsewhere): a VectorGrid feature's highlight isn't reachable through
    // `resetLayerFills`/`highlight` below (both operate on Leaflet
    // FeatureGroup sub-layers a VectorGrid doesn't have), so nothing else
    // here would ever clear it — a click on a fire perimeter would stay red
    // forever otherwise. `selectVectorGridFeature` clears the previously
    // tracked one itself when selecting a *new* VectorGrid feature, so this
    // only needs to run for the "select nothing" case.
    if (layer == null) clearVectorGridHighlight(L_)

    L_.setLastActiveFeature(layer)
    L_.resetLayerFills()
    L_.highlight(layer)
    L_.Map_.activeLayer = layer

    if (L_.Map_.activeLayer) L_.Map_._justSetActiveLayer = true

    Description.updatePoint(L_.Map_.activeLayer)

    if (layer) {
        const props = layer.feature?.properties || layer.properties || {}

        // Highlight the feature in Globe
        if (
            L_.Globe_ &&
            L_.Globe_.highlight &&
            layer.feature &&
            layer.options?.layerName
        ) {
            L_.Globe_.highlight(layer.options.layerName, layer.feature)
        }

        L_.Viewer_.highlight(layer)
    }

    ToolController_.notifyActiveTool('setActiveFeature', L_.activeFeature)

    if (!L_.activeFeature) {
        L_.clearVectorLayerInfo()
    }
}

export function highlight(L_, layer, forceColor) {
    if (layer == null) return
    const color =
        forceColor ||
        (L_.configData.look && L_.configData.look.highlightcolor) ||
        'red'
    try {
        if (
            layer.feature?.properties?.annotation === true &&
            layer._container
        ) {
            // Annotation
            $(layer._container)
                .find('.mmgisAnnotation')
                .css('color', 'lime')
        } else if (layer.feature?.properties?.arrow === true) {
            // Arrow
            $(`.LayerArrow_${layer._idx}.mmgisArrowOutline`).css(
                'stroke',
                color
            )
        } else {
            // Leaflet's Canvas renderer (unlike SVG) redraws lazily off
            // `layer.options` on the next animation frame rather than
            // painting synchronously, so `.options` must actually hold the
            // highlight color for it to show up — reverting it right after
            // `setStyle` (as SVG could get away with, since its DOM update is
            // synchronous) would silently no-op the highlight under Canvas.
            layer.setStyle({
                color: color,
                stroke: color,
                weight: 4,
            })

            // For some odd reason sometimes the first style does not work
            // This makes sure it does
            setTimeout(() => {
                if (
                    layer.options.color != color &&
                    layer.options.stroke != color
                ) {
                    layer.setStyle({
                        color: color,
                        stroke: color,
                        weight: 4,
                    })
                }
            }, 100)
        }
    } catch (err) {
        if (layer._icon)
            layer._icon.style.filter = `drop-shadow(${color}  2px 0px 0px) drop-shadow(${color}  -2px 0px 0px) drop-shadow(${color}  0px 2px 0px) drop-shadow(${color} 0px -2px 0px)`
    }
    try {
        //layer.bringToFront()
    } catch (err) {}
}

export function getFirstCoordinate(L_, geometry) {
    // Extract the first coordinate from a geometry to use as label anchor
    if (!geometry || !geometry.coordinates) return null

    let coords = geometry.coordinates
    const type = geometry.type

    switch (type) {
        case 'Point':
            // [lng, lat]
            return L.latLng(coords[1], coords[0])
        case 'LineString':
            // [[lng, lat], ...]
            return L.latLng(coords[0][1], coords[0][0])
        case 'Polygon':
            // [[[lng, lat], ...], ...]
            return L.latLng(coords[0][0][1], coords[0][0][0])
        case 'MultiLineString':
            // [[[lng, lat], ...], ...]
            return L.latLng(coords[0][0][1], coords[0][0][0])
        case 'MultiPolygon':
            // [[[[lng, lat], ...], ...], ...]
            return L.latLng(coords[0][0][0][1], coords[0][0][0][0])
        default:
            return null
    }
}

/**
 * @param {object} layer - leaflet layer object
 */
export function setLastActiveFeature(L_, layer) {
    let layerName, lat, lon, key, value
    if (layer) {
        layerName = layer.hasOwnProperty('options')
            ? layer.options.layerName
            : null
        lat = layer.hasOwnProperty('_latlng') ? layer._latlng.lat : null
        lon = layer.hasOwnProperty('_latlng') ? layer._latlng.lng : null

        if (L_.layers.data[layerName]?.variables?.useKeyAsId) {
            key = L_.layers.data[layerName].variables.useKeyAsId

            value = F_.getIn(layer.feature.properties, key)
        }
    }

    if (layerName != null && key != null && value != null) {
        L_.lastActiveFeature = {
            layerName: layerName,
            lat: null,
            lon: null,
            key: key,
            value: value,
        }
    } else if (layerName != null && lat != null && lon != null) {
        L_.lastActiveFeature = {
            layerName: layerName,
            lat: lat,
            lon: lon,
            key: null,
            value: null,
        }
    }
}

// relation and field are optional
// relation is null, -1, or 1
// if relation is 1 it'll select the next feature, -1 the previous
// if field is null, relation is relative to initial geojson order
// otherwise sort by field first
export function selectFeature(L_, layerName, feature, relation, field) {
    // Helper function to round coordinates to match GEOJSON_PRECISION
    const roundCoordinates = (coords, precision) => {
        if (typeof coords[0] === 'number') {
            // Single coordinate pair [lng, lat]
            return coords.map((c) => parseFloat(c.toFixed(precision)))
        } else {
            // Nested array of coordinates
            return coords.map((c) => roundCoordinates(c, precision))
        }
    }

    const roundGeometry = (geometry) => {
        if (!geometry || !geometry.coordinates) return geometry
        const rounded = JSON.parse(JSON.stringify(geometry))
        rounded.coordinates = roundCoordinates(
            rounded.coordinates,
            L_.GEOJSON_PRECISION
        )
        return rounded
    }

    let f = JSON.parse(JSON.stringify(feature))
    layerName = L_.asLayerUUID(layerName)
    const layer = L_.layers.layer[layerName]

    // If relation is a feature, override feature
    if (typeof relation === 'object' && relation.type != null) {
        f = relation
        relation = 0
    }

    // A VectorGrid-backed layer (vectortile — tileset or sliced GeoJSON) has
    // no Leaflet FeatureGroup `_layers` dict of per-feature sub-layers to
    // search below; it restyles a feature by id instead (setFeatureStyle).
    // Detected by duck-typing rather than layer type, since both a tileset
    // and a sliced grid share this shape.
    if (layer && typeof layer.setFeatureStyle === 'function') {
        selectVectorGridFeature(L_, layerName, layer, f)
        return
    }

    if (layer) {
        const layers = layer._layers
        const layerKeys = Object.keys(layers)

        const featureWithout_ = JSON.parse(JSON.stringify(f))
        if (featureWithout_.properties?._ != null)
            delete featureWithout_.properties._
        if (featureWithout_.properties?._dataset != null)
            delete featureWithout_.properties._dataset
        if (featureWithout_.properties?._geodataset != null)
            delete featureWithout_.properties._geodataset
        if (featureWithout_.properties?.feature_id != null)
            delete featureWithout_.properties.feature_id
        // How a feature looks is not what it is: the globe is handed a copy with
        // a dynamic style resolved onto properties.style, which the 2D feature
        // it came from doesn't carry.
        if (featureWithout_.properties?.style != null)
            delete featureWithout_.properties.style

        for (let i = 0; i < layerKeys.length; i++) {
            const l = layerKeys[i]
            const layerFeature = layers[l].feature

            // Fast path: match by id when both features have one of the same
            // kind. Geodataset layers with _source have reduced properties
            // that won't match the full search result via JSON.stringify.
            // The search API stores the id in properties._.idx while the GET
            // endpoint stores it in properties.feature_id - two different
            // numberings, so a match across them would name another feature.
            if (sameFeature(layerFeature.properties, f.properties)) {
                if (layers[layerKeys[i + (relation || 0)]] != null) {
                    if (
                        L_.Globe_ &&
                        L_.Globe_.litho &&
                        L_.Globe_.litho._justSelectedFromMap !== undefined
                    ) {
                        L_.Globe_.litho._justSelectedFromMap = true
                        if (L_.Globe_.litho._justSelectedTimeout)
                            clearTimeout(
                                L_.Globe_.litho._justSelectedTimeout
                            )
                        L_.Globe_.litho._justSelectedTimeout = setTimeout(
                            () => {
                                L_.Globe_.litho._justSelectedFromMap = false
                            },
                            500
                        )
                    }
                    if (L_.Globe_ && L_.Globe_.highlight)
                        L_.Globe_.highlight(layerName, f)
                    layers[layerKeys[i + (relation || 0)]].fireEvent(
                        'click'
                    )
                }
                return
            }

            const lfeatureWithout_ = JSON.parse(
                JSON.stringify(layerFeature)
            )
            if (lfeatureWithout_.properties?._ != null)
                delete lfeatureWithout_.properties._
            if (lfeatureWithout_.properties?._dataset != null)
                delete lfeatureWithout_.properties._dataset
            if (lfeatureWithout_.properties?._geodataset != null)
                delete lfeatureWithout_.properties._geodataset
            if (lfeatureWithout_.properties?.feature_id != null)
                delete lfeatureWithout_.properties.feature_id
            if (lfeatureWithout_.properties?.style != null)
                delete lfeatureWithout_.properties.style

            // Check the cheap thing (properties) before the expensive thing
            // (geometry, which is O(vertices) per comparison) so layers with
            // many/complex shapes don't pay for a full geometry compare on
            // every feature that isn't even a properties match.
            const propertiesMatch = F_.isEqual(
                lfeatureWithout_.properties,
                featureWithout_.properties,
                true
            )

            // Round both geometries to GEOJSON_PRECISION before comparing
            // This accounts for precision differences between Cesium (which receives
            // precision-reduced GeoJSON) and Leaflet (which has full precision)
            const geometryMatch =
                propertiesMatch &&
                F_.isEqual(
                    roundGeometry(layerFeature.geometry),
                    roundGeometry(f.geometry),
                    true
                )

            if (geometryMatch && propertiesMatch) {
                if (layers[layerKeys[i + (relation || 0)]] != null) {
                    // Set flag to prevent Globe click handler from firing
                    if (
                        L_.Globe_ &&
                        L_.Globe_.litho &&
                        L_.Globe_.litho._justSelectedFromMap !== undefined
                    ) {
                        L_.Globe_.litho._justSelectedFromMap = true
                        // Clear flag after short delay
                        if (L_.Globe_.litho._justSelectedTimeout) {
                            clearTimeout(
                                L_.Globe_.litho._justSelectedTimeout
                            )
                        }
                        L_.Globe_.litho._justSelectedTimeout = setTimeout(
                            () => {
                                L_.Globe_.litho._justSelectedFromMap = false
                            },
                            500
                        )
                    }

                    // Highlight the feature in Globe
                    if (L_.Globe_ && L_.Globe_.highlight) {
                        L_.Globe_.highlight(layerName, f)
                    }
                    layers[layerKeys[i + (relation || 0)]].fireEvent(
                        'click'
                    )
                }
                return
            }
        }
    }
}

/**
 * Select a feature on a VectorGrid-backed layer (see `selectFeature`'s
 * dispatch above): restyle it red on whichever renderer this call came from
 * (map or globe), and sync the highlight to the other one — the same
 * two-way behavior `selectFeature`'s Leaflet-FeatureGroup path gives every
 * other layer type, just reached without a `_layers` dict to search.
 *
 * The map and globe resolve "which feature" independently (2D via
 * `L.VectorGrid`'s own getFeatureId/style.vtId convention, the globe via
 * GeoJSONSlicer.featureAt for a sliced layer) — this only needs an id both
 * sides already agree on to restyle the map's copy.
 */
// The one VectorGrid feature currently highlighted, if any — there is no
// per-layer place that already owns "the previous selection" the way a
// Leaflet FeatureGroup's own restyled sub-layer would, so this is it.
let _highlightedVectorGrid = null

function clearVectorGridHighlight(L_) {
    if (_highlightedVectorGrid == null) return
    const { layer, id } = _highlightedVectorGrid
    if (typeof layer.resetFeatureStyle === 'function')
        layer.resetFeatureStyle(id)
    layer.highlight = null
    _highlightedVectorGrid = null
    if (L_.Globe_ && L_.Globe_.clearHighlight) L_.Globe_.clearHighlight()
}

function selectVectorGridFeature(L_, layerName, layer, f) {
    const vtId = layer.vtId
    let id = vtId != null ? f.properties?.[vtId] : null

    // A sliced layer's `f` here is normally the untiled source feature —
    // what `featureAt` (map click) and a globe click both hand back — which
    // never carries the id tag only geojson-vt's tile-clipped copies get.
    // The id is just this feature's position in the same features array
    // those copies were tagged from (identity first, since a same-view
    // selection hands back the very object the slicer holds; property match
    // as a fallback for a feature that crossed from the other view).
    if (id == null && layer._slicer) {
        const features = layer._slicer.features
        let index = features.indexOf(f)
        if (index === -1)
            // sameFeature only agrees on an explicit id (feature_id/_.idx)
            // neither side has here — full property equality is the actual
            // fallback, for a feature crossing from the other view's own,
            // separately-fetched slicer instance.
            index = features.findIndex((candidate) =>
                F_.isEqual(candidate.properties, f.properties, true)
            )
        if (index !== -1) id = index
    }

    if (id == null) id = f.properties?.__mmgisSourceIndex
    if (id == null) return

    // A new selection replaces the old one — MMGIS only ever highlights one
    // feature at a time — so whatever was highlighted before (on this layer
    // or, since a tool can hop between VectorGrid layers, another one) is
    // reverted first, same as `resetLayerFills` does for a Leaflet
    // FeatureGroup layer before `highlight` restyles the new pick.
    if (
        _highlightedVectorGrid != null &&
        (_highlightedVectorGrid.layer !== layer || _highlightedVectorGrid.id !== id)
    ) {
        clearVectorGridHighlight(L_)
    }
    _highlightedVectorGrid = { layer, id }

    // setFeatureStyle *replaces* a feature's style rather than overlaying it
    // (createTile falls back to L.Path.prototype.options for anything not
    // named in the override, not to the feature's own configured style), so
    // an override naming only the stroke would still lose this layer's own
    // fill for as long as the feature stays highlighted — keep it explicit
    // instead of solid-red-filling the whole shape, which is what a highlight
    // reading `fill: true, fillColor: 'red', fillOpacity: 1` (all of it) does.
    const baseStyle = L_.layers.data[layerName]?.style || {}
    // An explicit `undefined` in this object is not "use the default" (same
    // footgun as GeoJSONSlicer's extent bug) — Leaflet's own L.extend copies
    // it over the default it was about to fall back to. Only named keys with
    // a real value should end up in the override.
    const highlightStyle = {
        weight: 3,
        color: 'red',
        opacity: 1,
        fill: baseStyle.fill !== false,
    }
    if (baseStyle.fillColor != null) highlightStyle.fillColor = baseStyle.fillColor
    if (baseStyle.fillOpacity != null)
        highlightStyle.fillOpacity = baseStyle.fillOpacity
    if (baseStyle.radius != null) highlightStyle.radius = baseStyle.radius

    layer.highlight = id
    layer.setFeatureStyle(id, highlightStyle)

    if (L_.Globe_ && L_.Globe_.highlight) {
        L_.Globe_.highlight(layerName, f)
    }
}

/**
 * @param {object} - activePoint { layerUUID: , lat: lon: }
 * @returns {bool} - true only if successful
 */
export function selectPoint(L_, activePoint) {
    if (activePoint == null) return false
    // Backward pre-uuid compatibility
    activePoint.layerUUID = L_.asLayerUUID(
        activePoint.layerUUID || activePoint.layerName
    )

    if (
        activePoint.layerUUID != null &&
        activePoint.lat != null &&
        activePoint.lon != null
    ) {
        if (L_.layers.layer.hasOwnProperty(activePoint.layerUUID)) {
            let g = L_.layers.layer[activePoint.layerUUID]._layers
            for (let l in g) {
                if (
                    g[l]?.feature?.geometry?.type &&
                    g[l].feature.geometry.type.toLowerCase() === 'point' &&
                    g[l]._latlng.lat == activePoint.lat &&
                    g[l]._latlng.lng == activePoint.lon
                ) {
                    g[l].fireEvent('click')
                    L_._selectPointViewHelper(activePoint, g[l])
                    return true
                }
            }
        }
    } else if (
        activePoint.layerUUID != null &&
        activePoint.key != null &&
        activePoint.value != null
    ) {
        if (L_.layers.layer.hasOwnProperty(activePoint.layerUUID)) {
            let g = L_.layers.layer[activePoint.layerUUID]._layers
            for (let l in g) {
                if (g[l] && g[l].feature && g[l].feature.properties) {
                    if (
                        F_.getIn(
                            g[l].feature.properties,
                            activePoint.key.split('.')
                        ) == activePoint.value
                    ) {
                        g[l].fireEvent('click')
                        L_._selectPointViewHelper(activePoint, g[l])
                        return true
                    }
                }
            }
        }
    } else if (
        activePoint.layerUUID != null &&
        activePoint.layerId != null
    ) {
        if (L_.layers.layer.hasOwnProperty(activePoint.layerUUID)) {
            let g = L_.layers.layer[activePoint.layerUUID]._layers
            const l = activePoint.layerId
            if (g[l] != null) {
                g[l].fireEvent('click')
                L_._selectPointViewHelper(activePoint, g[l])
                return true
            }
        }
    }
    return false
}

export function _selectPointViewHelper(L_, activePoint, layer) {
    if (activePoint.view === 'go') {
        let newView = []
        if (layer._latlng) {
            newView = [
                layer._latlng.lat,
                layer._latlng.lng,
                activePoint.zoom ||
                    L_.Map_.mapScaleZoom ||
                    L_.Map_.map.getZoom(),
            ]
        } else if (layer._latlngs) {
            let lat = 0,
                lng = 0
            let llflat = layer._latlngs.flat(Infinity)
            for (let ll of llflat) {
                lat += ll.lat
                lng += ll.lng
            }
            newView = [
                lat / llflat.length,
                lng / llflat.length,
                parseInt(
                    activePoint.zoom ||
                        L_.Map_.mapScaleZoom ||
                        L_.Map_.map.getZoom()
                ),
            ]
        }
        setTimeout(() => {
            L_.Map_.resetView(newView)
        }, 50)
        if (L_.hasGlobe) {
            L_.Globe_.litho.setCenter(newView)
        }
    }
    setTimeout(() => {
        L_.setActiveFeature(layer)
    }, 300)
}

// Returns all feature at a leaflet map click
// e = {latlng: {lat, lng}, containerPoint?: {x, y}}
export function getFeaturesAtPoint(L_, e, fullLayers) {
    let features = []
    let correspondingLayerNames = []
    if (e.latlng && e.latlng.lng != null && e.latlng.lat != null) {
        // To better intersect points on click we're going to buffer out a small bounding box
        const mapRect = document
            .getElementById('map')
            .getBoundingClientRect()

        const wOffset = e.containerPoint?.x || mapRect.width / 2
        const hOffset = e.containerPoint?.y || mapRect.height / 2

        let nwLatLong = L_.Map_.map.containerPointToLatLng([
            wOffset - 15,
            hOffset - 15,
        ])
        let seLatLong = L_.Map_.map.containerPointToLatLng([
            wOffset + 15,
            hOffset + 15,
        ])
        // If we didn't have a container click point, buffer out e.latlng
        if (e.containerPoint == null) {
            const lngDif = Math.abs(nwLatLong.lng - seLatLong.lng) / 2
            const latDif = Math.abs(nwLatLong.lat - seLatLong.lat) / 2
            nwLatLong = {
                lng: e.latlng.lng - lngDif,
                lat: e.latlng.lat - latDif,
            }
            seLatLong = {
                lng: e.latlng.lng + lngDif,
                lat: e.latlng.lat + latDif,
            }
        }

        // Find all the intersected points and polygons of the click
        Object.keys(L_.layers.layer).forEach((lName) => {
            if (
                (L_.layers.on[lName] &&
                    LayerTypeRegistry.hasFeaturePicking(
                        L_.layers.data[lName].type
                    ) &&
                    L_.layers.layer[lName]) ||
                (lName.indexOf('DrawTool_') === 0 &&
                    L_.layers.layer[lName]?.[0]?._map != null)
            ) {
                const nextFeatures = L.leafletPip
                    .pointInLayer(
                        [e.latlng.lng, e.latlng.lat],
                        L_.layers.layer[lName]
                    )
                    .concat(
                        F_.pointsInPoint(
                            [e.latlng.lng, e.latlng.lat],
                            L_.layers.layer[lName],
                            [
                                nwLatLong.lng,
                                seLatLong.lng,
                                nwLatLong.lat,
                                seLatLong.lat,
                            ]
                        )
                    )
                    .reverse()
                features = features.concat(nextFeatures)
                correspondingLayerNames = correspondingLayerNames.concat(
                    new Array(nextFeatures.length).fill().map(() => lName)
                )
            }
        })

        if (features[0] == null) features = []
        else {
            const swapFeatures = []
            features.forEach((f) => {
                if (
                    typeof f.type === 'string' &&
                    f.type.toLowerCase() === 'feature'
                )
                    swapFeatures.push(f)
                else if (
                    f.feature &&
                    typeof f.feature.type === 'string' &&
                    f.feature.type.toLowerCase() === 'feature'
                )
                    swapFeatures.push(fullLayers ? f : f.feature)
            })
            features = swapFeatures
        }
    }
    return features
}

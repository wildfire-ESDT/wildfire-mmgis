/**
 * slicedSelection — what clicking a sliced feature, or empty space, means.
 *
 * Shared by the 2D map (map.js) and the Cesium globe (globe/cesium.js) so a
 * click selects — and an empty click deselects — identically in both views:
 * the same highlight on both, the same Description panel, and the same
 * `setActiveFeature` notification tools (e.g. WildfireWhatIf) listen for.
 */
import L_ from '@basics/Layers_/Layers_'
import ToolController_ from '@basics/ToolController_/ToolController_'
import { pickIncidentNameKey } from './sliceMetadata'

/**
 * Whether the active tool (Measure, …) has taken over map clicks — the same
 * check Map_'s featureDefaultClick makes for every other layer type.
 */
export function layerInteractionsDisabled() {
    return ToolController_.activeTool?.disableLayerInteractions === true
}

/**
 * Select a sliced layer's source feature, as clicking it does.
 *
 * @param {string} layerName
 * @param {object} feature - the slicer's own source feature (what
 *        GeoJSONSlicer.featureAt returns on either view)
 */
export function selectSlicedFeature(layerName, feature) {
    // L_.selectFeature restyles the map's copy and syncs the globe. Only a
    // feature's properties identify it there (a VectorGrid has no per-feature
    // geometry to match), yet selectFeature deep-copies whatever it is
    // handed — for a many-vertex perimeter that copy is the slow part of a
    // click, so it's handed a geometry-less stand-in.
    L_.selectFeature(layerName, {
        type: 'Feature',
        properties: feature.properties,
        geometry: null,
    })
    // L_.selectFeature only restyles + syncs the globe; showing the
    // feature's own properties (incident name, acres, date, …) in the
    // description panel — and notifying tools such as WildfireWhatIf, which
    // reads `.feature.geometry` off this exact notification to draw its own
    // bbox around whatever was clicked — is a separate, explicit step for
    // every layer type.
    //
    // `feature` is passed through whole and unmodified (not a
    // renamed/stripped copy): setActiveFeature makes its own globe highlight
    // call with whatever object it's given, and the globe matches a
    // selection back to its own copy by identity or, failing that, exact
    // property equality — a feature carrying an extra or renamed key never
    // matches. useKeyAsName points the description panel's header at
    // whichever real property holds the incident name, so it's still
    // labeled sensibly without touching the feature that has to keep
    // matching.
    L_.setActiveFeature({
        feature,
        properties: feature.properties,
        useKeyAsName:
            pickIncidentNameKey(
                L_.layers.data[layerName],
                feature.properties
            ) ?? undefined,
        options: { layerName },
    })
}

/**
 * Deselect, as an empty click on the 2D map does (Map_'s clearOnMapClick):
 * clears the active feature — and with it the map's and the globe's sliced
 * highlight (see selection.js's clearVectorGridHighlight) — and tells
 * listeners there is no active feature any more.
 */
export function clearSlicedSelection() {
    L_.setActiveFeature(null)
    document.dispatchEvent(
        new CustomEvent('newActiveFeature', {
            detail: { activeFeature: null },
        })
    )
}

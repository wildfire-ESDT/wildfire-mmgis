import { create } from 'zustand'

export const BBOX_BUFFER_KM = 15 // HRRR region clears the perimeter by this much on every side
export const PAGE_SIZE = 10

const useWhatIfStore = create((set) => ({
    vars: {},
    veloUrl: 'veloserver', // relative → MMGIS's adjacent-server proxy; may be absolute
    // Perimeter / bbox
    drawing: false,
    perimeterRing: null, // closed [lon,lat] ring
    perimeterSource: null, // 'drawn' | 'uploaded' | 'selected' (map click) | 'run'
    perimeterName: null, // fire/incident name when known (map pick, upload, run)
    bboxBounds: null, // [[latMin,lonMin],[latMax,lonMax]] — perimeter extent + buffer
    // Wind — null until fetched; {speed_ms, direction_deg} base + editable target
    wind: null, // {base:{speed_ms,direction_deg}, target:{speed_ms,direction_deg}, hrrr_ref, points, rawRecords}
    hrrrRun: null, // {date_utc, cycle_utc, source} — latest cycle Veloserver had
    windStale: false, // perimeter moved after wind was fetched
    fetchingWinds: false,
    hrrrError: null,
    // Why the last action couldn't run, shown at the top of the panel
    actionError: null,
    // Fuel
    fuel: 'null',
    // Dozer lines — simple "fuel cleared, don't spread over this" barriers
    dozerLines: [], // [{id, coords: [lon,lat][]}]
    drawingDozerLine: false,
    // Simulation
    simType: 'fire_spread',
    runName: '',
    submitting: false,
    // Runs
    jobs: {},
    jobIds: [],
    filterText: '',
    page: 0,
    activeJobId: null,
    showActiveJson: false,

    // Keycloak auth (Authorization Code + PKCE; gates the tool UI)
    loggedIn: false,
    authUser: null, // preferred_username — display label only
    authUserId: null, // Keycloak `sub` (immutable UUID) — the key runs are scoped by
    authError: null,
    authBusy: false,
    kcUrl: 'http://localhost:8885',
    kcRealm: 'wildfire',
    kcClientId: 'wildfire-whatif',

    // Demo fires (demo.js): completed model forecasts from the model server,
    // and what-if runs of the model on them
    modelUrl: 'wildfire-model', // relative → MMGIS's adjacent-server proxy; may be absolute
    demos: null, // [{id, name, start_time, end_time, growth_iou_144h, ...}]
    demoModel: null, // {name, epoch, test_growth_iou_144h}
    demosLoading: false,
    demosError: null,
    activeDemo: null, // id of the open demo fire
    demoResults: {}, // id -> [model forecast, what-if runs...]
    demoIdx: 0, // which of the open fire's runs is shown
    demoStep: 12, // 0 = forecast start, k = +12k hours
    demoPlaying: false,
    showObserved: true, // the ground truth's edge on the map
    showBaseline: true, // the model forecast's edge under a what-if (what the what-if is compared with)
    truthSource: null, // which ground truth is shown: 'feds' | 'agency'; null = the fire's own default
    demoWind: null, // what-if six-day mean wind {speed_ms, direction_deg}; null = the real wind
    // The fire's model inputs drawn under the forecast (demo.js)
    inputCatalogs: {}, // demo id -> [{key, label, group, units, time, ramp | cats+colors, min, max}]
    visibleInputs: [], // the added input layers shown on the map (any number)
    addedInputKeys: [], // the added input layers, top of the list first (drawn on top)
    windEditOpen: false, // the Wind card's Modify is open (the map shows the authored wind)
    drawersClosed: {}, // the Fire analysis window's closed drawers: forecast | whatif | spot
    detailsOpen: false, // the fire's incident details shown under its name
    syncMapTime: false, // MMGIS's own time follows the forecast's step (off: the forecast leaves it alone)
    toolCollapsed: false, // the Fire analysis window folded to a slim bar
    sidePanels: { area: false, whatif: false }, // the panels slid out beside the window (both can be open)
    showForecast: true, // the model's forecast on the map (the Fire analysis window's eye)
    compareTruth: false, // the Forecast card shows its difference from the ground truth
    fireOpacity: 0.6, // the forecast fill (see-through like the map's fire perimeters; its edge stays solid)
    windArrows: false, // the wind as arrows over the map
    windFlow: false, // the wind as moving streaks (leaflet-velocity) over the map
    flowLoading: false,
    inputOpacities: {}, // input layer key -> its opacity (default 0.75)
    probe: null, // {lat, lon}: the spot clicked on the map, read in the Fire analysis window
    probeData: null, // {row, col, step, rows: [{group, label, value}]}
    probeLoading: false,
    probeError: null,
    inputLoading: null, // the layer being fetched
    inputRanges: {}, // layer cache key -> {min, max} of the loaded data
    demoBusy: false,
    demoError: null,

    set: (patch) => set(patch),
}))

export default useWhatIfStore

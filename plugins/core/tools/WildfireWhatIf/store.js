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
    bboxBounds: null, // [[latMin,lonMin],[latMax,lonMax]] — perimeter extent + buffer
    // Wind — null until fetched; {speed_ms, direction_deg} base + editable target
    wind: null, // {base:{speed_ms,direction_deg}, target:{speed_ms,direction_deg}, hrrr_ref, points, rawRecords}
    hrrrRun: null, // {date_utc, cycle_utc, source} — latest cycle Veloserver had
    windStale: false, // perimeter moved after wind was fetched
    fetchingWinds: false,
    hrrrError: null,
    // Simulation
    simType: 'fire_spread',
    runName: '',
    nameError: false,
    submitting: false,
    // Runs
    jobs: {},
    jobIds: [],
    filterText: '',
    page: 0,
    activeJobId: null,
    showActiveJson: false,

    // Keycloak auth (Direct Access Grant; gates the tool UI)
    loggedIn: false,
    authUser: null, // preferred_username — display label only
    authUserId: null, // Keycloak `sub` (immutable UUID) — the key runs are scoped by
    authError: null,
    authBusy: false,
    kcUrl: 'http://localhost:8885',
    kcRealm: 'wildfire',
    kcClientId: 'wildfire-whatif',

    set: (patch) => set(patch),
}))

export default useWhatIfStore

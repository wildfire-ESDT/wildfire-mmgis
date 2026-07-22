import { create } from 'zustand'

export const BBOX_BUFFER_KM = 15 // HRRR region clears the perimeter by this much on every side
export const FORECAST_HOURS = 13 // f00 … f12 (now → +12 h)
export const PAGE_SIZE = 10

export function nowPDTDate() {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Los_Angeles',
        }).format(new Date())
    } catch (e) {
        return new Date().toISOString().slice(0, 10)
    }
}

export function nowPDTHour() {
    try {
        return (
            Number(
                new Intl.DateTimeFormat('en-US', {
                    hour: 'numeric',
                    hour12: false,
                    timeZone: 'America/Los_Angeles',
                }).format(new Date())
            ) % 24
        )
    } catch (e) {
        return new Date().getHours()
    }
}

export function hourEdited(h) {
    return (
        h &&
        h.base &&
        h.target &&
        (h.target.speed_ms !== h.base.speed_ms ||
            h.target.direction_deg !== h.base.direction_deg)
    )
}

const useWhatIfStore = create((set) => ({
    vars: {},
    backendUrl: 'http://localhost:8000',
    // HRRR model run selection (PDT)
    hrrrDate: nowPDTDate(),
    hrrrHour: nowPDTHour(),
    // Perimeter / bbox
    drawing: false,
    perimeterRing: null, // closed [lon,lat] ring
    bboxBounds: null, // [[latMin,lonMin],[latMax,lonMax]] — perimeter extent + buffer
    // Wind — `hours` is null until a bundle is fetched; each entry is
    // {fxx, hrrr_ref, points, error, base:{speed_ms,direction_deg}|null, target:{…}}
    hours: null,
    hrrrRun: null, // {date_utc, cycle_utc, hour_pdt, source} from the bundle
    selectedFxx: 0,
    editScope: 'hour', // 'hour' edits the selected hour; 'all' offsets every hour together
    windStale: false, // perimeter moved after the bundle was fetched
    fetchingWinds: false,
    windProgress: null, // {done, total} while forecast hours stream in
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

    set: (patch) => set(patch),
}))

export default useWhatIfStore

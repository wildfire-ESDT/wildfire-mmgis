import { create } from 'zustand'

export const BBOX_BUFFER_KM = 15 // HRRR region clears the perimeter by this much on every side
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

const useWhatIfStore = create((set) => ({
    vars: {},
    veloUrl: 'veloserver', // relative → MMGIS's adjacent-server proxy; may be absolute
    // HRRR model run selection (PDT)
    hrrrDate: nowPDTDate(),
    hrrrHour: nowPDTHour(),
    // Perimeter / bbox
    drawing: false,
    perimeterRing: null, // closed [lon,lat] ring
    bboxBounds: null, // [[latMin,lonMin],[latMax,lonMax]] — perimeter extent + buffer
    // Wind — null until fetched; {speed_ms, direction_deg} base + editable target
    wind: null, // {base:{speed_ms,direction_deg}, target:{speed_ms,direction_deg}, hrrr_ref, points}
    hrrrRun: null, // {date_utc, cycle_utc, hour_pdt, source}
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

    loggedIn: false,

    set: (patch) => set(patch),
}))

export default useWhatIfStore

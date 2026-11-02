/**
 * Sensor Chart unit tests. Run with `npm run test:plugins:unit`.
 */
import { test, expect } from '@playwright/test'

import { colorFor } from '../logic/sensorColors.js'
import { formatReading, readingsAt } from '../logic/sensorReadings.js'
import { markerReading, sensorView, stepAfterTimeChange } from '../logic/sensorView.js'
import {
    buildSeries,
    chartTimeRange,
    initialViewRange,
    pickedPoint,
    placeHourTicks,
    rangeShowing,
} from '../logic/sensorSeries.js'
import { normalizeSensorConfigs } from '../logic/sensorConfig.js'

const HOUR = 3600000
const T = (iso) => Date.parse(iso)
const at = (hour) => T(`2026-11-01T${hour}:00:00Z`)
const GREY = 'rgb(128, 128, 128)'
const FORECAST_LAYER = 'PM2.5 Forecast'
const RUN = '2026-11-01T12:00:00Z'
const AQI = { key: 'aqi', label: 'AQI' }
const PM25 = { key: 'pm25', label: 'PM2.5', suffix: 'µg/m³', decimals: 1 }

// Five hours of readings with 10:00 missing, and three forecast runs.
const sensor = {
    site_name: 'Anaheim',
    observed: [
        { time: '2026-11-01T08:00:00Z', aqi: 30, pm25: 7.2 },
        { time: '2026-11-01T09:00:00Z', aqi: 35, pm25: 8.4 },
        { time: '2026-11-01T10:00:00Z', aqi: null, pm25: null },
        { time: '2026-11-01T11:00:00Z', aqi: 45, pm25: 10.8 },
        { time: '2026-11-01T12:00:00Z', aqi: 50, pm25: 12.0 },
    ],
    forecasts: {
        '2026-11-01T10:00:00Z': [{ time: '2026-11-01T11:00:00Z', aqi: 44, pm25: 10.5 }],
        '2026-11-01T11:00:00Z': [
            { time: '2026-11-01T12:00:00Z', aqi: 48, pm25: 11.5 },
            { time: '2026-11-01T13:00:00Z', aqi: 52, pm25: 12.6 },
        ],
        [RUN]: [
            { time: '2026-11-01T13:00:00Z', aqi: 55, pm25: 13.3 },
            { time: '2026-11-01T14:00:00Z', aqi: 60, pm25: 15.6 },
            { time: '2026-11-01T15:00:00Z', aqi: null, pm25: null },
            { time: '2026-11-01T16:00:00Z', aqi: 70, pm25: 20.1 },
        ],
    },
}

const stepTo = (hour, run = at('12')) => ({ layerName: FORECAST_LAYER, run, time: at(hour), timelineTime: at('12') })
const forecastOff = (overrides = {}) => sensorView(sensor, { timelineTime: at('12'), ...overrides })
const forecastOn = (overrides = {}) =>
    sensorView(sensor, { timelineTime: at('12'), activeForecastLayer: FORECAST_LAYER, ...overrides })

test.describe('sensor dot color', () => {
    test('shows the observed reading at the timeline hour when no forecast layer is on @unit', () => {
        const reading = markerReading(sensor, forecastOff(), 'aqi')
        expect(reading.aqi).toBe(50)
        expect(colorFor({ colorBy: 'aqi' }, reading.aqi)).toBe('rgb(255, 255, 0)')
    })

    test('ignores a forecast step while its layer is off @unit', () => {
        expect(markerReading(sensor, forecastOff({ step: stepTo('14') }), 'aqi').aqi).toBe(50)
    })

    test('turns grey when there is no reading for the timeline hour @unit', () => {
        const reading = markerReading(sensor, forecastOff({ timelineTime: at('10') }), 'aqi')
        expect(reading).toBeUndefined()
        expect(colorFor({ colorBy: 'aqi' }, reading?.aqi)).toBe(GREY)
    })

    test('shows the forecast for the stepped hour while a forecast layer is on @unit', () => {
        expect(markerReading(sensor, forecastOn({ step: stepTo('14') }), 'aqi')).toMatchObject({ aqi: 60, isForecast: true })
    })

    test('falls back to the observed reading when the forecast has no value for that hour @unit', () => {
        const reading = markerReading(sensor, forecastOn({ step: stepTo('15') }), 'aqi')
        expect(reading).toMatchObject({ aqi: 50 })
        expect(reading.isForecast).toBeUndefined()
    })

    test('colors by PM2.5 on the tile colormap when the config says so @unit', () => {
        const reading = markerReading(sensor, forecastOff(), 'pm25')
        expect(colorFor({ colorBy: 'pm25' }, reading.pm25)).toBe('rgb(195, 255, 34)')
    })
})

test.describe('sensor panel readings', () => {
    test('with the forecast layer on and no step, the forecast card shows the first hour of the run @unit', () => {
        const { observed, forecast, hoursAhead } = readingsAt(sensor, forecastOn(), 'aqi')
        expect(observed.aqi).toBe(50)
        expect(forecast.aqi).toBe(55)
        expect(hoursAhead).toBe(1)
    })

    test('a forecast step moves the forecast card to that hour @unit', () => {
        const { forecast, hoursAhead } = readingsAt(sensor, forecastOn({ step: stepTo('16') }), 'aqi')
        expect(forecast.aqi).toBe(70)
        expect(hoursAhead).toBe(4)
    })

    test('a step into an earlier run reads that run, not the timeline hour run @unit', () => {
        const view = forecastOn({ step: stepTo('13', at('11')) })
        expect(view.run).toBe('2026-11-01T11:00:00Z')
        const { forecast, hoursAhead } = readingsAt(sensor, view, 'aqi')
        expect(forecast.aqi).toBe(52)
        expect(hoursAhead).toBe(2)
    })

    test('when no run starts at the timeline hour the forecast is on but not available @unit', () => {
        const view = forecastOn({ timelineTime: at('09') })
        expect(view.forecastOn).toBe(true)
        expect(view.run).toBeUndefined()
        expect(readingsAt(sensor, view, 'aqi').forecast).toBeNull()
    })

    test('with no forecast layer on the panel is observed only @unit', () => {
        const view = forecastOff()
        expect(view.forecastOn).toBe(false)
        expect(readingsAt(sensor, view, 'aqi')).toMatchObject({ observed: { aqi: 50 }, forecast: null })
    })

    test('values show the unit decimals and suffix, or a dash when missing @unit', () => {
        expect(formatReading(12.04, PM25)).toBe('12.0 µg/m³')
        expect(formatReading(50, AQI)).toBe('50')
        expect(formatReading(null, PM25)).toBe('—')
    })
})

test.describe('forecast step across a timeline change', () => {
    test('a step ForecastTimeline took at the new hour is kept @unit', () => {
        const step = stepTo('14')
        expect(stepAfterTimeChange(step, at('12'))).toBe(step)
    })

    test('a step left over from the previous hour is dropped @unit', () => {
        expect(stepAfterTimeChange(stepTo('14'), at('13'))).toBeNull()
        expect(stepAfterTimeChange(null, at('13'))).toBeNull()
    })
})

test.describe('chart lines', () => {
    test('the forecast line starts at the last observed reading at the run @unit', () => {
        const { forecast } = buildSeries(sensor, 'aqi', RUN, at('12'))
        expect(forecast[0]).toEqual({ x: at('12'), y: 50, joinsObserved: true })
        expect(forecast.slice(1).map((point) => point.y)).toEqual([55, 60, null, 70])
    })

    test('the forecast joins the reading before the run when the run hour is missing @unit', () => {
        const { forecast } = buildSeries(sensor, 'aqi', '2026-11-01T10:00:00Z', at('12'))
        expect(forecast[0]).toEqual({ x: at('09'), y: 35, joinsObserved: true })
    })

    test('hours not reported yet are drawn grey up to the selected hour @unit', () => {
        const { observed, missing } = buildSeries(sensor, 'aqi', undefined, at('14'))
        expect(observed.slice(-2)).toEqual([
            { x: at('13'), y: null, notReportedYet: true },
            { x: at('14'), y: null, notReportedYet: true },
        ])
        const notReported = missing.filter((point) => point.notReportedYet)
        expect(notReported.map((point) => [point.x, point.y])).toEqual([
            [at('13'), 50],
            [at('14'), 50],
        ])
    })

    test('a gap in readings is bridged between its neighbours, then broken off @unit', () => {
        const { missing } = buildSeries(sensor, 'aqi', undefined, at('12'))
        expect(missing).toEqual([
            { x: at('09'), y: 35 },
            { x: at('10'), y: 40, missing: true, notReportedYet: undefined },
            { x: at('11'), y: 45 },
            { x: at('11'), y: null },
        ])
    })

    test('there is no forecast line without a run @unit', () => {
        expect(buildSeries(sensor, 'aqi', undefined, at('12')).forecast).toEqual([])
    })

    test('the PM2.5 unit plots pm25 values @unit', () => {
        expect(buildSeries(sensor, 'pm25', undefined, at('12')).observed.map((point) => point.y)).toEqual([
            7.2, 8.4, null, 10.8, 12.0,
        ])
    })
})

test.describe('chart view', () => {
    test('opens on the 36 hours ending a day after the run @unit', () => {
        expect(initialViewRange(at('12'), at('16'))).toEqual({ min: at('12') - 12 * HOUR, max: at('12') + 24 * HOUR })
    })

    test('opens on the latest data when no forecast is shown @unit', () => {
        expect(initialViewRange(Infinity, at('12'))).toEqual({ min: at('12') - 36 * HOUR, max: at('12') })
    })

    test('slides to a picked hour that is off screen, keeping its width @unit', () => {
        expect(rangeShowing(at('12'), { min: at('00'), max: at('06') }, at('00'), at('16'))).toEqual({
            min: at('09'),
            max: at('15'),
        })
    })

    test('stays put when the picked hour is already showing @unit', () => {
        expect(rangeShowing(at('04'), { min: at('00'), max: at('06') }, at('00'), at('16'))).toBeNull()
    })

    test('never slides past the end of the data @unit', () => {
        expect(rangeShowing(at('16'), { min: at('00'), max: at('06') }, at('00'), at('16'))).toEqual({
            min: at('10'),
            max: at('16'),
        })
    })

    test('spans the readings and the shown forecast, and a sensor with no readings yet still gets a range @unit', () => {
        expect(chartTimeRange(sensor, RUN, at('12'))).toEqual({ firstTime: at('08'), lastTime: at('16') })
        expect(chartTimeRange({ observed: [], forecasts: {} }, undefined, at('12'))).toEqual({
            firstTime: at('12'),
            lastTime: at('12'),
        })
    })
})

test.describe('clicking the chart', () => {
    const candidates = [
        { x: 100, y: 50, point: { x: at('11'), y: 45 }, label: 'Observed' },
        { x: 110, y: 48, point: { x: at('12'), y: null }, label: 'Observed' },
        { x: 120, y: 45, point: { x: at('12'), y: 50, joinsObserved: true }, label: 'Forecast' },
        { x: 130, y: 40, point: { x: at('13'), y: 55 }, label: 'Forecast' },
    ]

    test('picks the nearest reading within reach @unit', () => {
        expect(pickedPoint(candidates, { x: 104, y: 52 }, null)).toMatchObject({ time: at('11'), label: 'Observed' })
    })

    test('a click that ended a drag picks nothing @unit', () => {
        const click = { x: 104, y: 52, clientX: 20, clientY: 0 }
        expect(pickedPoint(candidates, click, { x: 0, y: 0 })).toBeNull()
        expect(pickedPoint(candidates, { ...click, clientX: 2 }, { x: 0, y: 0 })).toMatchObject({ time: at('11') })
    })

    test('never picks the join point or an empty hour @unit', () => {
        expect(pickedPoint(candidates, { x: 120, y: 45 }, null)).toMatchObject({ time: at('13'), label: 'Forecast' })
        expect(pickedPoint(candidates, { x: 110, y: 48 }, null)).toMatchObject({ time: at('11'), label: 'Observed' })
    })

    test('picks nothing when no reading is within reach @unit', () => {
        expect(pickedPoint(candidates, { x: 300, y: 300 }, null)).toBeNull()
    })
})

test.describe('chart time axis', () => {
    function inTimeZone(zone, run) {
        const previousZone = process.env.TZ
        process.env.TZ = zone
        try {
            return run()
        } finally {
            if (previousZone === undefined) delete process.env.TZ
            else process.env.TZ = previousZone
        }
    }

    function ticksFor(min, max) {
        const axis = { min, max, chart: { chartArea: { width: 600 } } }
        placeHourTicks(axis)
        return axis.ticks
    }

    test('labels land on the right hours across the fall DST change, midnights included @unit', () => {
        inTimeZone('America/Los_Angeles', () => {
            const ticks = ticksFor(T('2026-10-31T19:00:00Z'), T('2026-11-02T20:00:00Z'))
            const labeled = ticks.filter((tick) => tick.major)
            for (const tick of labeled) expect(new Date(tick.value).getHours() % 6).toBe(0)
            const labeledTimes = labeled.map((tick) => tick.value)
            expect(labeledTimes).toContain(T('2026-11-01T07:00:00Z'))
            expect(labeledTimes).toContain(T('2026-11-02T08:00:00Z'))
        })
    })

    test('ticks land on whole local hours in a half-hour time zone @unit', () => {
        inTimeZone('Asia/Kolkata', () => {
            const ticks = ticksFor(T('2026-11-01T00:00:00Z'), T('2026-11-01T12:00:00Z'))
            expect(ticks.length).toBeGreaterThan(0)
            for (const tick of ticks) expect(new Date(tick.value).getMinutes()).toBe(0)
        })
    })
})

test.describe('mission config', () => {
    test('a hand-edited config with nulls and wrong types still loads @unit', () => {
        expect(normalizeSensorConfigs(undefined)).toEqual([])
        const entries = normalizeSensorConfigs({
            sensorCharts: [
                null,
                'AirNow Sensors',
                {
                    sensorLayers: 'AirNow Sensors',
                    forecastLayers: [FORECAST_LAYER, null, 7],
                    modelName: 5,
                    units: [{ key: 'pm25', decimals: '1', suffix: 'µg/m³' }, { key: '' }, null, { key: 'aqi', decimals: 500 }],
                },
            ],
        })
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
            sensorLayers: ['AirNow Sensors'],
            forecastLayers: [FORECAST_LAYER],
            modelName: '',
            colorBy: 'aqi',
            units: [
                { key: 'pm25', label: 'pm25', suffix: 'µg/m³', decimals: 1 },
                { key: 'aqi', label: 'aqi', suffix: '', decimals: 20 },
            ],
        })
    })
})

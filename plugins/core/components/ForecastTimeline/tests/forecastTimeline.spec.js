/**
 * Forecast Timeline unit tests. Run with `npm run test:plugins:unit`.
 */
import { test, expect } from '@playwright/test'
import '../../../../../tests/helpers/browser-globals.js'

import {
    runQueryParameter,
    stacCollectionUrl,
    resolveUrlTokens,
    hasInitHour,
} from '../shared/common.js'
import { stepTime, periodBounds, forecastBase, initHourMismatch } from '../shared/timeMath.js'
import {
    getForecastType,
    defaultForecastTypeName,
    resolveForecastType,
    genericForecastTypeNames,
    registerForecastType,
} from '../forecastTypes/registry.js'
import '../forecastTypes/allTypes.js'
import { queryEnd } from '../forecastTypes/time.js'
import { itemsUrl, stepsWithItems, tileTimeWindow } from '../forecastTypes/stac.js'
import { probeUrl } from '../forecastTypes/urlTemplate.js'
import availabilityMethods from '../stepping/availability.js'
import { setFxx, countSteps, hrrrProduct, idxUrl } from '../forecastTypes/wildfire/veloserverMeteorology.js'

const fs = require('fs')
const path = require('path')

const HOUR = 3600000
const DAY = 24 * HOUR
const T = (iso) => Date.parse(iso)

const engine = {
    currentTime: '2025-07-21T12:00:00Z',
    startTime: null,
    duringTimelineChange: false,
    playing: false,
    applyTimeParams() {},
    reloadLayer() {},
    setTickLoading() {},
    markRunPresent() {},
    failCard() {},
    refreshCards() {},
    fetchOptions: (extra) => ({ ...extra }),
    debug() {},
}

// ── time math ──────────────────────────────────────────────

test('stepTime honours stepOffset and the unit @unit', () => {
    const base = T('2025-07-21T00:00:00Z')
    expect(stepTime({ stepUnit: 'hour', stepOffset: 1 }, 0, base)).toBe(base + HOUR)
    expect(stepTime({ stepUnit: 'day', stepOffset: 0 }, 3, base)).toBe(base + 3 * DAY)
    expect(stepTime({ stepUnit: 'month' }, 1, base)).toBe(T('2025-08-01T00:00:00Z'))
    expect(stepTime({ stepUnit: 'hour' }, 2, base)).toBe(base + 2 * HOUR)
})

test('periodBounds aligns to the UTC unit @unit', () => {
    const t = T('2025-07-21T13:45:10Z')
    expect(periodBounds('hour', t)).toEqual([T('2025-07-21T13:00:00Z'), T('2025-07-21T14:00:00Z')])
    expect(periodBounds('day', t)).toEqual([T('2025-07-21T00:00:00Z'), T('2025-07-22T00:00:00Z')])
    expect(periodBounds('month', t)).toEqual([T('2025-07-01T00:00:00Z'), T('2025-08-01T00:00:00Z')])
})

test('a daily card anchors to the latest run at or before the selected hour @unit', () => {
    const daily = { stepUnit: 'day', runHourUTC: 0 }
    expect(forecastBase(daily, T('2025-07-21T12:00:00Z'))).toBe(T('2025-07-21T00:00:00Z'))
    expect(forecastBase({ stepUnit: 'day', runHourUTC: 18 }, T('2025-07-21T12:00:00Z'))).toBe(T('2025-07-20T18:00:00Z'))
    expect(forecastBase({ stepUnit: 'hour' }, T('2025-07-21T12:00:00Z'))).toBe(T('2025-07-21T12:00:00Z'))
    expect(forecastBase({ stepUnit: 'month' }, T('2025-07-21T12:00:00Z'))).toBe(T('2025-07-01T00:00:00Z'))
})

test('an init-hour card pins to its hour and is gated elsewhere @unit', () => {
    const fc = { stepUnit: 'hour', runHourUTC: 6 }
    expect(hasInitHour(fc)).toBe(true)
    expect(forecastBase(fc, T('2025-07-21T12:00:00Z'))).toBe(T('2025-07-21T06:00:00Z'))
    expect(initHourMismatch(fc, T('2025-07-21T12:00:00Z'))).toBe(true)
    expect(initHourMismatch(fc, T('2025-07-21T06:00:00Z'))).toBe(false)
    expect(initHourMismatch({ stepUnit: 'hour' }, T('2025-07-21T12:00:00Z'))).toBe(false)
})

// ── shared helpers ─────────────────────────────────────────

test('runQueryParameter encodes the run as a STAC query @unit', () => {
    const q = decodeURIComponent(runQueryParameter(T('2025-07-21T12:00:00Z')))
    expect(JSON.parse(q)).toEqual({ 'forecast:reference_datetime': { eq: '2025-07-21T12:00:00Z' } })
})

test('stacCollectionUrl finds the items API for external and local collections @unit', () => {
    expect(stacCollectionUrl({ url: 'https://host/mmgis/titilerpgstac/collections/pwwb_co' }))
        .toBe('https://host/mmgis/stac/collections/pwwb_co')
    expect(stacCollectionUrl({ url: 'stac-collection:smoke' }))
        .toBe('http://localhost/stac/collections/smoke')
    expect(stacCollectionUrl({ url: 'https://elsewhere/collections/x' })).toBeNull()
    expect(stacCollectionUrl({ url: '' })).toBeNull()
})

test('resolveUrlTokens fills time tokens @unit', () => {
    expect(resolveUrlTokens('a/{time}/{starttime}-{endtime}', 'E', 'S')).toBe('a/E/S-E')
    expect(resolveUrlTokens('a/{starttime}', 'E')).toBe('a/E')
})

// ── registry ───────────────────────────────────────────────

test('generic and wildfire forecast types are registered @unit', () => {
    expect(genericForecastTypeNames()).toEqual(['time', 'stac', 'url-template'])
    for (const name of ['time', 'stac', 'url-template', 'veloserver-meteorology']) {
        expect(getForecastType(name)?.name).toBe(name)
    }
    expect(getForecastType('nope')).toBeNull()
})

test('a layer without a type defaults from its own fields, never its URL @unit', () => {
    expect(defaultForecastTypeName({ sourceType: 'stac-collection', time: { forecast: {} } })).toBe('stac')
    expect(defaultForecastTypeName({ time: { forecast: { urlTemplate: true } } })).toBe('url-template')
    expect(defaultForecastTypeName({ url: 'COG:http://veloserver/cog/temp_2m/{time}.tiff?fxx=0', time: { forecast: {} } })).toBe('time')
})

test('resolveForecastType reports an unknown name as null @unit', () => {
    const { name, forecastType } = resolveForecastType({ name: 'x', time: { forecast: { type: 'missing' } } })
    expect(name).toBe('missing')
    expect(forecastType).toBeNull()
})

test('registerForecastType needs a name and showStep @unit', () => {
    expect(() => registerForecastType({ name: 'bad' })).toThrow()
})

test('every forecast layer in the wildfire config resolves to a forecast type @unit', () => {
    const configPath = path.join(__dirname, '..', 'wildfire_v50_config.json')
    test.skip(!fs.existsSync(configPath), 'wildfire_v50_config.json is not in the plugin folder')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const seen = {}
    const walk = (layers) =>
        layers.forEach((l) => {
            if (l.time?.forecast?.enabled) {
                const { name, forecastType } = resolveForecastType(l)
                expect(forecastType, `${l.name} → ${name}`).not.toBeNull()
                seen[name] = (seen[name] || 0) + 1
            }
            walk(l.sublayers || [])
        })
    walk(config.layers)
    expect(seen.stac).toBeGreaterThan(0)
    expect(seen['url-template']).toBe(1)
    expect(seen['veloserver-meteorology']).toBeGreaterThan(0)
})

// ── time forecast type ───────────────────────────────────────────

test('a daily tick queries the issue day, one step earlier @unit', () => {
    const fc = { stepUnit: 'day', stepOffset: 0 }
    const step = T('2025-07-23T00:00:00Z')
    expect(queryEnd(fc, step, '2025-07-21T12:00:00Z', false).iso).toBe('2025-07-22T00:00:00.000Z')
    expect(queryEnd(fc, step, '2025-07-21T12:00:00Z', true).iso).toBe('2025-07-23T00:00:00.000Z')
})

test('a monthly tick queries its own month, future months at the boundary @unit', () => {
    const fc = { stepUnit: 'month' }
    const now = '2025-07-21T12:00:00Z'
    expect(queryEnd(fc, T('2025-07-01T00:00:00Z'), now)).toEqual({ iso: now, futureMonth: false })
    expect(queryEnd(fc, T('2025-09-01T00:00:00Z'), now)).toEqual({ iso: '2025-09-01T00:00:00Z', futureMonth: true })
})

test('time.showStep shifts the layer end then puts it back @unit', () => {
    const layer = { type: 'tile', time: { start: 'S', end: 'E' } }
    const seen = []
    const mapLayer = { refresh: (u, f) => seen.push(['refresh', u, f]) }
    getForecastType('time').showStep({
        layer, mapLayer, forecast: { stepUnit: 'hour', stepOffset: 1 }, isOn: true,
        stepTime: T('2025-07-21T13:00:00Z'),
        engine: { ...engine, applyTimeParams: (l) => seen.push(['apply', l.time.end]) },
    })
    expect(seen).toEqual([['apply', '2025-07-21T12:00:00.000Z'], ['refresh', null, true]])
    expect(layer.time).toEqual({ start: 'S', end: 'E' })
})

// ── stac forecast type ───────────────────────────────────────────

const stacLayer = {
    name: 'Smoke',
    type: 'tile',
    sourceType: 'stac-collection',
    url: 'https://host/mmgis/titilerpgstac/collections/smoke',
}
const run = T('2025-07-21T12:00:00Z')

test('a per-run STAC request spans the run and carries the run query @unit', () => {
    const fc = { stepUnit: 'hour', stepOffset: 1, perRun: true, steps: 24 }
    const url = itemsUrl(stacLayer, fc, run, 24)
    expect(url.startsWith('https://host/mmgis/stac/collections/smoke/items?limit=200&datetime=2025-07-21T13:00:00Z/2025-07-22T12:59:59Z')).toBe(true)
    expect(decodeURIComponent(url.split('&query=')[1])).toContain('2025-07-21T12:00:00Z')
    expect(itemsUrl(stacLayer, { stepUnit: 'hour', stepOffset: 1, steps: 24 }, run, 24)).not.toContain('query=')
})

test('a plain hourly STAC request asks the issue hours @unit', () => {
    const fc = { stepUnit: 'hour', stepOffset: 1, steps: 24 }
    expect(itemsUrl(stacLayer, fc, run, 24)).toContain('datetime=2025-07-21T12:00:00Z/2025-07-22T11:59:59Z')
})

test('stepsWithItems maps item times onto steps @unit', () => {
    const fc = { stepUnit: 'hour', stepOffset: 1, perRun: true }
    const features = [
        { properties: { datetime: '2025-07-21T13:00:00Z' } },
        { properties: { datetime: '2025-07-21T15:30:00Z' } },
        { properties: { datetime: 'garbage' } },
    ]
    expect([...stepsWithItems(features, fc, run, 24)]).toEqual([0, 2])
    expect(stepsWithItems([], fc, run, 24).size).toBe(0)
})

test('per-run tiles ask for the step instant and the selected run @unit', () => {
    const fc = { stepUnit: 'hour', stepOffset: 1, perRun: true }
    const stepMs = run + 3 * HOUR
    expect(tileTimeWindow({ layer: stacLayer, forecast: fc, run, step: 2, stepTime: stepMs, requestedEnd: '2025-07-21T12:00:00Z' }))
        .toEqual(['2025-07-21T15:00:00Z', '2025-07-21T15:00:01Z'])
    const url = getForecastType('stac').buildTileUrl({ forecast: fc, run, url: 'https://t/tiles/1/2/3?x=1' })
    expect(url).toContain('&query=')
    expect(getForecastType('stac').buildTileUrl({ forecast: {}, run, url: 'u' })).toBe('u')
})

test('an ordinary STAC tile pins to the requested hour; a gated card draws nothing @unit', () => {
    const fc = { stepUnit: 'hour', stepOffset: 1 }
    expect(tileTimeWindow({ layer: stacLayer, forecast: fc, run, step: 0, stepTime: run, requestedEnd: '2025-07-21T12:30:00Z' }))
        .toEqual(['2025-07-21T12:00:00Z', '2025-07-21T12:00:01Z'])
    expect(tileTimeWindow({ layer: stacLayer, forecast: fc, run, step: 0, stepTime: run, uninitialized: true, requestedEnd: '2025-07-21T12:30:00Z' }))
        .toEqual(['2025-07-21T12:30:00Z', '2025-07-21T12:30:00Z'])
    expect(tileTimeWindow({ layer: { type: 'vector' }, forecast: fc, run, step: 0, stepTime: run, requestedEnd: 'x' })).toBeNull()
})

// ── url-template forecast type ───────────────────────────────────

const wfpi = {
    name: 'WFPI',
    type: 'tile',
    tileformat: 'wms',
    url: 'https://geo/wfpi-__FSTEP__/ows?service=WMS&layers=wfpi-__FSTEP__&TIME={time}',
    time: { start: 'S', end: 'E' },
}

test('url-template substitutes the 1-based step into the URL and LAYERS @unit', () => {
    const layer = JSON.parse(JSON.stringify(wfpi))
    const fc = { stepUnit: 'day', urlTemplate: true }
    const params = []
    const mapLayer = { setParams: (p) => params.push(p), redraw() {}, _url: '' }
    getForecastType('url-template').showStep({ layer, mapLayer, forecast: fc, step: 2, isOn: true, engine })
    expect(layer.url).toContain('wfpi-3/ows')
    expect(mapLayer._url).toBe('https://geo/wfpi-3/ows')
    expect(params).toEqual([{ LAYERS: 'wfpi-3' }])
    expect(layer.time.end).toBe(engine.currentTime)
    getForecastType('url-template').prepareLayer({ layer, mapLayer, forecast: fc, step: 0, isOn: false, engine })
    expect(layer.url).toContain('wfpi-1/ows')
})

test('url-template probes step 1 with a 1x1 GetMap @unit', () => {
    const url = probeUrl(wfpi, {}, T('2025-07-21T00:00:00Z'))
    expect(url).toContain('wfpi-1/ows')
    expect(url).toContain('TIME=2025-07-21')
    expect(url).toContain('&width=1&height=1')
    expect(url).toContain('&bbox=-20037508,-20037508,20037508,20037508')
    expect(probeUrl(wfpi, { options: { probeBbox: '1,2,3,4' } }, 0)).toContain('&bbox=1,2,3,4')
    expect(probeUrl({ url: 'https://plain/wms' }, {}, 0)).toBeNull()
})

// ── wildfire forecast types ──────────────────────────────────────

test('setFxx sets or adds the forecast hour @unit', () => {
    expect(setFxx('http://v/cog/temp/{time}.tiff?fxx=0', 7)).toBe('http://v/cog/temp/{time}.tiff?fxx=7')
    expect(setFxx('http://v/x', 3)).toBe('http://v/x?fxx=3')
    expect(setFxx('http://v/x?a=1', 3)).toBe('http://v/x?a=1&fxx=3')
})

test('veloserver-meteorology steps follow the HRRR run schedule by default @unit', () => {
    expect(countSteps({ forecast: {}, run: T('2025-07-21T00:00:00Z') })).toBe(49)
    expect(countSteps({ forecast: {}, run: T('2025-07-21T01:00:00Z') })).toBe(19)
    expect(countSteps({ forecast: { options: { fxxMax: 5, fxxMaxExtended: 9, extendedRunHoursUTC: ['3'] } }, run: T('2025-07-21T03:00:00Z') })).toBe(10)
    expect(countSteps({ forecast: { options: { fxxMax: 5 } }, run: T('2025-07-21T04:00:00Z') })).toBe(6)
})

test('veloserver-meteorology knows its products and index files @unit', () => {
    expect(hrrrProduct({ type: 'tile', url: 'COG:http://veloserver:8104/cog/smoke_massden/{time}.tiff?fxx=0' })).toBe('smoke_massden')
    expect(hrrrProduct({ type: 'velocity', url: 'https://firepanel.ai/veloserver/hrrr/gribjson/{time}/' })).toBe('winds')
    expect(hrrrProduct({ type: 'velocity', url: 'https://firepanel.ai/veloserver/gfs/gribjson/{time}/' })).toBeNull()
    expect(hrrrProduct({ type: 'tile', url: 'x' }, { product: 'rh_2m' })).toBe('rh_2m')
    expect(idxUrl(T('2025-07-21T06:00:00Z'), 3)).toBe(
        'https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.20250721/conus/hrrr.t06z.wrfsfcf03.grib2.idx'
    )
})

test('veloserver-meteorology darkens the hours the index lacks @unit', async () => {
    const layer = { name: 'HRRR Smoke', type: 'tile', url: 'COG:http://veloserver:8104/cog/smoke_massden/{time}.tiff?fxx=0' }
    const published = new Set([0, 1, 3])
    window.fetch = async (url) => {
        const fxx = Number(/wrfsfcf(\d\d)\.grib2/.exec(url)[1])
        if (url.endsWith('.idx')) {
            return published.has(fxx)
                ? { ok: true, text: async () => ':MASSDEN:8 m above ground:\n' }
                : { ok: false }
        }
        return { ok: false }
    }
    try {
        const steps = await getForecastType('veloserver-meteorology').findAvailableSteps({
            name: layer.name, layer, options: {}, run: T('2025-07-21T07:00:00Z'), steps: 5, fresh: true, engine,
        })
        expect([...steps].sort()).toEqual([0, 1, 3])
    } finally {
        delete window.fetch
    }
})

// ── engine: availability flow ──────────────────────────────

function fakeEngine(forecastType, fc) {
    const states = []
    const self = {
        ...availabilityMethods,
        _presence: {},
        _freshProbe: new Set(),
        _probeLoadingTimers: {},
        state: { cards: { L: { stepIndex: 0, cardState: 'loading' } } },
        _forecastBase: () => run,
        _initHourMismatch: () => false,
        _effectiveSteps: () => 4,
        _forecastTypeFor: () => forecastType,
        _forecastTypeCall: (name, forecast, extra) => ({ name, forecast, run, engine, ...extra }),
        _detectForecastLayers: () => [{ name: 'L', config: fc }],
        _setCardState(name, s) {
            this.state.cards[name].cardState = s
            states.push(s)
        },
        _setTickLoading() {},
        _refreshAllCards() {},
        _reapplyAllSteps() {
            states.push('reapply')
        },
    }
    return { self, states }
}

test('an empty Set is an unpublished run; gaps darken ticks; null shows everything @unit', async () => {
    const fc = { stepUnit: 'hour' }
    let answer = new Set()
    const { self, states } = fakeEngine({ name: 'h', showStep() {}, findAvailableSteps: async () => answer }, fc)
    self._probeAllAnchors()
    await self._presence['L:' + run].promise
    expect(self.state.cards.L.cardState).toBe('unavailable')

    answer = new Set([0, 2])
    self._freshProbe.add('L')
    await self._resolvePresence('L', fc)
    expect(self.state.cards.L.cardState).toBe('available')
    expect(states.at(-1)).toBe('reapply')
    expect(self._missingStep('L', fc, 1)).toBe(true)
    expect(self._missingStep('L', fc, 2)).toBe(false)
    expect(self._presenceReady('L', fc)).toBe(true)

    answer = null
    self._freshProbe.add('L')
    await self._resolvePresence('L', fc)
    expect(self._missingStep('L', fc, 1)).toBe(false)
})

test('a forecast type that throws fails closed; loaded data beats the check @unit', async () => {
    const fc = { stepUnit: 'hour' }
    const { self } = fakeEngine({ name: 'h', showStep() {}, findAvailableSteps: async () => { throw new Error('net') } }, fc)
    await self._resolvePresence('L', fc)
    expect(self.state.cards.L.cardState).toBe('unavailable')
    self._markRunPresent('L', fc)
    expect(self.state.cards.L.cardState).toBe('available')
})

test('a forecast type without findAvailableSteps is always available @unit', async () => {
    const fc = { stepUnit: 'hour' }
    const { self } = fakeEngine({ name: 'h', showStep() {} }, fc)
    await self._resolvePresence('L', fc)
    expect(self.state.cards.L.cardState).toBe('available')
    expect(self._canRetryStep('L')).toBe(false)
})

test('retryStep updates one tick and brings the card back @unit', async () => {
    const fc = { stepUnit: 'hour' }
    const { self } = fakeEngine(
        { name: 'h', showStep() {}, findAvailableSteps: async () => new Set(), retryStep: async ({ step }) => step === 1 },
        fc
    )
    await self._resolvePresence('L', fc)
    expect(self.state.cards.L.cardState).toBe('unavailable')
    expect(await self._retryStep('L', fc, 1)).toBe(true)
    expect(self._missingStep('L', fc, 1)).toBe(false)
    expect(self._missingStep('L', fc, 0)).toBe(true)
    expect(self.state.cards.L.cardState).toBe('available')
})

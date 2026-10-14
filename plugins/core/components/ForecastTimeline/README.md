# ForecastTimeline

Adds a forecast card above the main timeline for each layer that is on and has a `time.forecast` block. The main timeline picks the model run. The card steps through that run's forecast for its one layer, and checks whether the run exists yet. When the selected time changes, every card snaps back to its first step.

Each layer says what **forecast type** it is, and the type decides how a tick is shown and how the card learns which steps exist. Three generic types ship with the plugin: `time` (the default: move the layer's time and refetch), `stac` (a titiler-pgstac collection) and `url-template` (`__FSTEP__` in the URL). A mission adds its own under `forecastTypes/<mission>/`; the wildfire mission's `veloserver-meteorology` lives in `forecastTypes/wildfire/`.

## How to use it

1. Enable the ForecastTimeline component on the mission.
2. On a time-enabled layer, fill the Forecast Timeline section of the Tile form: turn on the card, set the steps, and pick the forecast type if `time` isn't right. Or add the `time.forecast` block by hand, as below.
3. If no existing type fits your data, write one. See `forecastTypes/README.md` and "Writing a forecast type" below.

## Quick start

```json
"time": {
  "enabled": true,
  "forecast": {
    "enabled": true,
    "type": "time",
    "label": "My Forecast",
    "steps": 24,
    "stepUnit": "hour",
    "stepOffset": 1
  }
}
```

Turn the layer on. A card with 24 hourly ticks appears; each tick re-queries the layer at that hour.

## Choosing a forecast type

| Your data | Type |
|---|---|
| Any time-enabled layer; a tick should just move the layer's time | `time` |
| A titiler-pgstac collection with one item per forecast hour or day | `stac` |
| A WMS whose layer name or URL carries the step, e.g. `wfpi-forecast-1`, `-2`, `-3` | `url-template` |
| veloserver forecast-hour weather products (`?fxx=` in the URL): HRRR COGs, HRRR or GFS winds | `veloserver-meteorology` |
| Anything with its own rules | write one, see below |

A layer with no `type` gets `url-template` if `urlTemplate` is true, `stac` if its `sourceType` is `stac-collection`, otherwise `time`, and logs a note asking for an explicit one.

## Files

| File | What it is |
|---|---|
| `ForecastTimeline.js` | Entry point: init, cleanup, subscriptions |
| `ui/` | The card UI: `cards.js` (DOM, clicks, tooltips, layout), `playback.js` (experimental play button), the CSS |
| `stepping/` | Getting a step onto the map through the layer's forecast type. `applyStep.js` applies one, `availability.js` asks which steps exist and sets card state, `patches.js` wraps a few core methods so the step reaches tile requests |
| `forecastTypes/` | One module per kind of forecast layer. `registry.js`, `allTypes.js`, the generic `time.js`, `stac.js`, `urlTemplate.js`, and `wildfire/`. Has its own README |
| `shared/` | Pure helpers with no core imports: `timeMath.js` (run anchoring, step instants, labels), `common.js` (constants, small utilities) |
| `tests/` | Unit tests, `npm run test:plugins:unit` |

## The generic types

### `time`

A tick sets the layer's query end time and refreshes it. Daily ticks are labeled with the valid day but query the issue day (one step earlier), because a forecast for day T is issued on T minus one. Monthly ticks query their own month. Hourly ticks on a card with `runHourUTC` query their own hour.

```json
"forecast": { "enabled": true, "type": "time", "label": "Daily Outlook", "steps": 7, "stepUnit": "day", "stepOffset": 0, "runHourUTC": 0 }
```

### `stac`

Like `time`, plus one items request per run that says which periods have an item. Periods without one render dark. Tiles are pinned to the tick's instant so the mosaic holds exactly one item.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `perRun` | bool | false | The collection holds every run's forecast. Each item is stamped at its valid hour and tagged `forecast:reference_datetime` = the run. Tiles and checks ask for the selected run only. |

```json
"sourceType": "stac-collection",
"url": "https://host/mmgis/titilerpgstac/collections/smoke_pm25",
"time": { "enabled": true, "forecast": { "enabled": true, "type": "stac", "perRun": true, "label": "Smoke PM2.5", "steps": 24, "stepUnit": "hour", "stepOffset": 1 } }
```

### `url-template`

The URL carries `__FSTEP__`, replaced with the 1-based step number in both the path and the `LAYERS` parameter. Availability is a 1x1 GetMap of step 1 judged by content type, since GeoServer answers a missing TIME with HTTP 200 and an XML body. That GetMap fills `{time}` with the run's date (`YYYY-MM-DD`).

| Option | Type | Default | Meaning |
|---|---|---|---|
| `probeBbox` | string | the world, EPSG:3857 | bbox for the availability GetMap when the URL has none |

```json
"tileformat": "wms",
"url": "https://geo/firedanger_wfpi-forecast-__FSTEP___conus_day_data/ows?service=WMS&request=GetMap&layers=wfpi-forecast-__FSTEP___conus_day_data&TIME={time}",
"time": { "enabled": true, "forecast": { "enabled": true, "type": "url-template", "label": "WFPI", "steps": 7, "stepUnit": "day", "stepOffset": 0, "runHourUTC": 0 } }
```

## The wildfire type: `forecastTypes/wildfire/veloserverMeteorology.js`

Knows veloserver and NOAA. A layer only uses it if its config names it.

### `veloserver-meteorology`

`?fxx=N` in the layer URL is the forecast hour. COG tiles (`COG:http://veloserver/cog/<product>/{time}.tiff?fxx=0`) rewrite fxx inside titiler's `url=` and refresh; velocity layers fetch the hour's gribjson and `setData` in place. Step count follows the HRRR run schedule, not `steps`.

For HRRR products, availability comes from NOAA's HRRR bucket: each hour's `.idx` sidecar says whether the hour is published and carries the layer's field, so hours that are not render dark with a retry button. Hours are fetched once per run and shared by every HRRR card. For anything else on veloserver (the GFS winds layer) it is one check of forecast hour 0.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `fxxMax` | number | 18 | last forecast hour of a regular run |
| `fxxMaxExtended` | number | 48 | last forecast hour of an extended run |
| `extendedRunHoursUTC` | number[] | [0, 6, 12, 18] | UTC init hours that run extended |
| `perHourAvailability` | bool | true | off goes back to the single hour 0 check |
| `product` | string | from the URL | veloserver product name when the URL doesn't carry it |

```json
"url": "COG:http://veloserver:8104/cog/smoke_massden/{time}.tiff?fxx=0",
"time": { "enabled": true, "forecast": { "enabled": true, "type": "veloserver-meteorology", "label": "HRRR Smoke", "steps": 19, "stepUnit": "hour", "stepOffset": 0 } }
```

## Writing a forecast type

A forecast type is a plain object. Only `name` and `showStep` are required. Every method receives one object with these fields:

| Field | What it is |
|---|---|
| `name` | the layer's name |
| `layer` | `L_.layers.data[name]`, the layer config |
| `mapLayer` | `L_.layers.layer[name]`, the live Leaflet layer, if built |
| `forecast` | `layer.time.forecast` |
| `options` | `forecast.options`, an object for your own settings |
| `run` | the run's instant, ms |
| `step` | the step, 0-based |
| `stepTime` | that step's instant, ms |
| `steps` | steps in this run |
| `isOn` | whether the layer is on |
| `uninitialized` | the card is gated off its init hour (`runHourUTC`) |
| `fresh` | ignore remembered misses (a toggle or retry asked) |
| `engine` | callbacks, below |

| Method | Required | Returns | Meaning |
|---|---|---|---|
| `showStep(call)` | yes | | Put this step of this run on the map |
| `countSteps(call)` | no | number | Steps in this run. Default `forecast.steps` |
| `findAvailableSteps(call)` | no | Promise of Set or null | Which steps have data. Empty Set: run not generated. Set with gaps: those ticks dark. null: no verdict, show everything |
| `retryStep(call)` | no | Promise of bool | Re-check one step. Its presence gives dark ticks a retry button |
| `buildTileUrl(call)` | no | string | Rewrite one tile request (`call.url`) |
| `timeWindow(call)` | no | [startIso, endIso] or null | The window a tile layer should request right now (`call.requestedEnd` is what core asked for) |
| `prepareLayer(call)` | no | | Called once when the card appears, even if the layer is off |
| `prefetchStep(call)` | no | Promise | Warm one step. Its presence gives the card a play button when playback is on |

`engine` offers `currentTime`, `startTime`, `applyTimeParams(layer)`, `reloadLayer(layer, { forceRequery })`, `setTickLoading(step, on, ms)`, `markRunPresent()`, `failCard()`, `refreshCards()`, `fetchOptions(extra)`, `debug(...)`, and the flags `duringTimelineChange` and `playing`.

The plugin re-asks `findAvailableSteps` about once a minute while a card is showing, so a run that is still publishing fills in. Data that actually loaded (`engine.markRunPresent()`) beats a failed check.

Start from the type closest to your data and change what differs. A complete type for a service that publishes `/status.json` listing the hours it has:

```js
import timeForecastType from '../time'

const statusJsonForecastType = {
    ...timeForecastType,
    name: 'status-json',

    findAvailableSteps({ options, run, steps, engine }) {
        const url = `${options.statusUrl}?run=${new Date(run).toISOString()}`
        return fetch(url, engine.fetchOptions())
            .then((r) => (r.ok ? r.json() : null))
            .then((status) => {
                if (!status) return null
                const present = new Set()
                for (let step = 0; step < steps; step++) {
                    if (status.hours.includes(step)) present.add(step)
                }
                return present
            })
    },
}

export default statusJsonForecastType
```

Register it one of two ways:

- Put the file in `forecastTypes/<yourmission>/` and add it to `forecastTypes/allTypes.js`.
- From any component of your own: `import { registerForecastType } from '.../ForecastTimeline/forecastTypes/registry'` and call it at module load. Every component module is imported before any initializes, so the registry is complete before the first card.

Then point a layer at it: `"type": "status-json", "options": { "statusUrl": "https://host/status.json" }`.

## Settings reference: `time.forecast`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | bool | | Turns the card on |
| `type` | string | `time` | Which forecast type this layer is; see Choosing |
| `label` | string | layer name | Card title |
| `description` | string | | Info icon text. No description, no icon |
| `steps` | number | 1 | Tick count. Types with `countSteps` ignore it |
| `stepUnit` | `hour`, `day`, `month` | `hour` | |
| `stepOffset` | number | 0 | 0: first tick is the run time. 1: one unit after |
| `runHourUTC` | number | 0 | Daily: the UTC hour the model runs. Hourly: the one UTC hour a day it initializes; other hours show "run not yet generated" |
| `showWindow` | bool | false | Daily ticks label valid windows (5 PM – 5 PM) instead of dates |
| `perRun` | bool | false | `stac` only, see above |
| `options` | object | {} | Passed to the forecast type |

## Troubleshooting

- **No card.** The layer must be on, `time.enabled` and `time.forecast.enabled` must both be true, and the ForecastTimeline component must be enabled on the mission.
- **"Forecast type not found".** `time.forecast.type` names something not registered. Check the spelling against `forecastTypes/allTypes.js`, or that your registering component is in the build (`npm run plugins -- activate`).
- **Every tick dark.** `findAvailableSteps` returned an empty Set. Set `window.FTL_DEBUG = true` and watch the console for the request it made; the tick retry button, if the type has `retryStep`, re-asks one step.
- **Tiles blank after a tick.** The layer's query moved to a time with no data. For `stac`, check the items endpoint for that instant; for `time`, remember daily ticks query the issue day.

## Events

Each applied step dispatches `forecasttimeline:step` on `document`:

```js
document.addEventListener('forecasttimeline:step', (event) => {
    const { layerName, time, run, stepUnit } = event.detail // times in ms
})
```

`time` is the step's valid time and `run` is the run it belongs to. The SensorChart component follows it to recolor its sensors and move its forecast marker.

Debugging: `window.ForecastTimeline` is the live object and `window.FTL_DEBUG = true` traces the availability chain.

# ForecastTimeline

Adds a forecast stepper row inside the TimeUI expanded area for each layer that is toggled on and opts in with a `time.forecast` config block. Layers without that block never get a row, even if they serve forecast data. The code and CSS call each row a card (`.ftl-card`, `state.cards`), so this doc does too.

Each card shows the model run it is anchored to and a strip of clickable time steps. Clicking a step loads that forecast step for that one layer, while the main timeline keeps owning the selected time. When the selected time changes, every card snaps back to its first step and re-anchors to the new run.

Cards also check whether their model run actually exists. A run that is not published yet renders a dark card with a "run not yet generated" message, and re-checks about once a minute until it appears.

## Modules

| File | Does |
|---|---|
| `ForecastTimeline.js` | Plugin entry point. `init(vars)`, `cleanup()`, subscriptions, `window.ForecastTimeline` |
| `common.js` | Constants, layer kind predicates, shared utils |
| `time.js` | Run anchoring, step math, all labels |
| `availability.js` | Probes, probe caches, card state verdicts |
| `hrrrIndex.js` | Prototype. Per forecast hour availability for HRRR, read from NOAA's GRIB index files |
| `steps.js` | Applies a step to the live layer, per kind |
| `cards.js` | Card DOM, handlers, tooltip, TimeUI height layout |
| `patches.js` | Patch registry, wraps four core methods |
| `playback.js` | Experimental playback and prefetch |

## Layer config

A layer opts in with a `time.forecast` block.

```json
"time": {
  "forecast": {
    "enabled": true,
    "label": "Example Forecast",
    "steps": 7,
    "stepUnit": "day",
    "stepOffset": 0,
    "runHourUTC": 0,
    "urlTemplate": true,
    "description": "This model is generated once a day and forecasts 7 days out."
  }
}
```

| Field | Type | Req | Meaning |
|---|---|---|---|
| `enabled` | bool | yes | Turns the card on |
| `label` | string | yes | Card title |
| `steps` | number | yes | Step count. fxx layers ignore it and use the run schedule |
| `stepUnit` | string | yes | `hour`, `day` or `month` |
| `stepOffset` | number | yes | `0` first step is the init time, `1` first step is init plus one unit |
| `runHourUTC` | number | no | Daily: UTC hour the model runs, default `0`. Hourly: declares the one UTC hour the model initializes; every other selected hour shows the standard "run not yet generated" card for that hour and leaves the layer alone. Omit for the default, every hour is a run |
| `showWindow` | bool | no | Daily cards label per-step valid windows ("5 PM – 5 PM") instead of plain UTC dates |
| `urlTemplate` | bool | no | URL carries `__FSTEP__`, replaced with the 1 based step |
| `description` | string | no | Info icon text. No description, no icon |
| `stepLabel` | string | no | Overrides the step chip label |
| `stepSize` | number | no | Chip label size, default `1` |
| `fxxMax` | number | no | fxx layers. Last forecast hour of a regular run, default `18` |
| `fxxMaxExtended` | number | no | fxx layers. Last forecast hour of an extended run, default `48` |
| `extendedRunHoursUTC` | number[] | no | fxx layers. UTC init hours that run extended, default `[0, 6, 12, 18]` |

## Layer kinds

The kind is detected from the layer itself, nothing extra to configure.

| Kind | Detected by | Step | Probe |
|---|---|---|---|
| COG fxx rasters (e.g. HRRR) | `tile`, URL starts `COG:`, has `?fxx=` | rewrite `fxx`, refresh tiles | HRRR: GRIB index per hour, else titiler `/cog/info` |
| Velocity fxx winds (e.g. HRRR) | `velocity`, has `?fxx=` | fetch gribjson, `setData` | HRRR: GRIB index per hour, else HEAD the gribjson |
| WMS template | `urlTemplate` plus `__FSTEP__` | substitute step, redraw | 1x1 GetMap of step 1 |
| STAC collection | `sourceType` is `stac-collection` | shift query end time | items endpoint |
| Anything else | fallback | time window reload | assumed present |

Nothing in the plugin reads `window.ForecastTimeline`. It exists for observation and tests.

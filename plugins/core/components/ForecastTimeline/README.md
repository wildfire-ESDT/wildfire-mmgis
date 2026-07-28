# ForecastTimeline

Adds a forecast card for every active forecast layer inside the TimeUI expanded area. Each card shows the model run it is anchored to and a row of clickable time steps. Clicking a step loads that forecast step for that one layer, while the main timeline keeps owning the selected time. When the selected time changes, every card snaps back to its first step and re-anchors to the new run.

Cards also check whether their model run actually exists. A run that is not published yet renders a dark card with a "run not yet generated" message, and re-checks about once a minute until it appears.

## Modules

| File | Does |
|---|---|
| `ForecastTimeline.js` | Plugin entry point. `init(vars)`, `cleanup()`, subscriptions, `window.ForecastTimeline` |
| `common.js` | Constants, layer kind predicates, shared utils |
| `time.js` | Run anchoring, step math, all labels |
| `availability.js` | Probes, probe caches, card state verdicts |
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
    "label": "WFPI Forecast",
    "steps": 7,
    "stepUnit": "day",
    "stepOffset": 0,
    "runHourUTC": 0,
    "urlTemplate": true,
    "description": "WFPI is generated once a day and forecasts 7 days out."
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
| `runHourUTC` | number | no | Daily only. UTC hour the model runs, default `0` |
| `urlTemplate` | bool | no | URL carries `__FSTEP__`, replaced with the 1 based step (WFPI) |
| `description` | string | no | Info icon text. No description, no icon |
| `stepLabel` | string | no | Overrides the step chip label |
| `stepSize` | number | no | Chip label size, default `1` |

## Layer kinds

The kind is detected from the layer itself, nothing extra to configure.

| Kind | Detected by | Step | Probe |
|---|---|---|---|
| COG fxx (HRRR rasters) | `tile`, URL starts `COG:`, has `?fxx=` | rewrite `fxx`, refresh tiles | titiler `/cog/info` |
| Velocity fxx (HRRR winds) | `velocity`, has `?fxx=` | fetch gribjson, `setData` | HEAD the gribjson |
| WMS template (WFPI) | `urlTemplate` plus `__FSTEP__` | substitute step, redraw | 1x1 GetMap of day 1 |
| STAC (FDEO, PWWB) | `sourceType` is `stac-collection` | shift query end time | items endpoint |
| Anything else | fallback | time window reload | assumed present |

## Debugging

```js
window.FTL_DEBUG = true                    // trace the availability chain
window.ForecastTimeline.state.cards        // stepIndex, collapsed, cardState
window.ForecastTimeline._edgeCache         // run presence cache
window.ForecastTimeline._stacPresence      // STAC per step presence
```

Nothing in the plugin reads `window.ForecastTimeline`. It exists for observation and tests.

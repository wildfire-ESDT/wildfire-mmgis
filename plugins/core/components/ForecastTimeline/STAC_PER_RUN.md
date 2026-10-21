# Setting up a daily STAC forecast in the Forecast Timeline

This guide shows how to put a daily forecast product (example: a 6-day forecast, so 6 items per run) on the Forecast Timeline using a STAC collection, and how the collection has to be structured.

Code referenced: `forecastTypes/stac.js`, `forecastTypes/time.js`, `shared/common.js`, `shared/timeMath.js`.

## 1. How the Forecast Timeline works

- A **run** is one execution of the model. A daily product has one run per day, e.g. "the run of Oct 19".
- A run produces a **forecast**: one output per future period. A 6-day forecast has 6 outputs, called **steps**.
- The Forecast Timeline draws a card for the layer with one **tick** per step. The main timeline chooses which run you are looking at. Clicking a tick shows that step's data for that run.

Two things have to happen for every tick, and how they happen depends on how the data is stored:

1. **Loading the data.** When a tick is clicked, the layer has to load the right data for that step.
2. **Knowing which steps exist.** The card greys out ticks with no data (for example, a run that is still being published). Something has to tell it which steps have data.

## 2. Forecast types

A **forecast type** is a small module that answers those two questions for one kind of data source. The timeline handles everything common (the card, choosing the run, stepping) and calls the layer's forecast type for the source-specific part.

The code lives in `forecastTypes/`:

| Type | Used when |
|---|---|
| `time` | A normal time-enabled layer. A tick just changes the layer's time and reloads it. This is the default. |
| `stac` | The layer is a titiler-pgstac STAC collection. This is what this guide is about. |
| `url-template` | The step number is part of the layer's URL (e.g. a WMS). |
| `veloserver-meteorology` | Wildfire mission weather products. |

A layer picks its type with `time.forecast.type`. The type is looked up in `forecastTypes/registry.js`; types are registered in `forecastTypes/allTypes.js`. If a layer sets no type, `stac` is chosen for `sourceType: "stac-collection"` and `time` otherwise, but set it explicitly.

A type is a plain object with these methods (only `showStep` is required):

| Method | What it does |
|---|---|
| `showStep` | Loads the data for the clicked step. |
| `findAvailableSteps` | Returns which steps have data. Steps without data render dark. |
| `buildTileUrl` | Changes each tile request. `stac` uses this to add the run filter. |
| `timeWindow` | Sets the time window a tile request asks for. |

`stac.js` implements all four. The full interface is in `README.md` and `forecastTypes/README.md`.

## 3. `stac`: normal mode vs `perRun`

The `stac` type has two modes. Choose based on what the collection holds.

| | Normal (default) | `perRun: true` |
|---|---|---|
| The collection holds | One forecast (the current run). | **Every run's forecast**, accumulating over time. |
| Each item's `datetime` is | The issue period. The tick for valid day D looks for an item one day earlier (see `queryEnd` in `time.js`). | **The valid time** of the step, i.e. the day the forecast is for. |
| Finding the right item | By time only. | By time **and** run, using `forecast:reference_datetime`. |

Use `perRun` whenever the collection keeps more than one run. Without it, different runs would have items for the same valid day and the layer could not tell which to draw.

Your case (a daily product keeping every run, 6 items per run) is `perRun`.

## 4. Layer config

```json
"sourceType": "stac-collection",
"url": "https://host/mmgis/titilerpgstac/collections/my-daily-forecast",
"time": {
  "enabled": true,
  "forecast": {
    "enabled": true,
    "type": "stac",
    "perRun": true,
    "label": "My Daily Forecast",
    "steps": 6,
    "stepUnit": "day",
    "stepOffset": 0,
    "runHourUTC": 0
  }
}
```

| Setting | Meaning |
|---|---|
| `perRun` | The collection holds every run (section 3). |
| `stepUnit: "day"` | One tick per day. |
| `steps` | Number of ticks. It must equal the number of items each run has. |
| `stepOffset` | Which day the first tick is on (below). |
| `runHourUTC` | The UTC hour the model runs. Keep it at 0 (section 7). |

### `stepOffset`

Tick i is at `run + (i + stepOffset) days`.

- `stepOffset: 0`: tick 0 is the run's own day, so the forecast includes the run day. 6 steps cover day 0 to day 5.
- `stepOffset: 1`: tick 0 is the next day, so the forecast starts after the run day. 6 steps cover day 1 to day 6.
- Today plus 6 more days: `stepOffset: 0` with `steps: 7`.

Choose whichever matches what your product's first file represents.

### Which run is shown

For a day product, the run is the latest UTC `runHourUTC` at or before the selected time. With `runHourUTC: 0` the run changes at **00:00 UTC**, not local midnight. All 24 hours of a UTC day show the same run and the same ticks. (In US Pacific time, the change happens at 5 PM the evening before.)

## 5. STAC collection layout

Use one collection for the product. It holds all runs, and each run adds one item per step.

Collection:

```json
{
  "type": "Collection",
  "stac_version": "1.0.0",
  "id": "my-daily-forecast",
  "description": "Daily product, 6-day forecast, new run each day",
  "license": "proprietary",
  "extent": {
    "spatial": { "bbox": [[-180, -90, 180, 90]] },
    "temporal": { "interval": [["2026-10-01T00:00:00Z", null]] }
  }
}
```

Each item needs two timestamps:

- `datetime`: the **valid time**, the day this item forecasts.
- `forecast:reference_datetime`: the **run time**, when the run that produced the item started.

Items for the run of 2026-10-19 (`stepOffset: 0`):

| item id | `datetime` (valid day) | `forecast:reference_datetime` (run) |
|---|---|---|
| `run20261019-d0` | 2026-10-19T00:00:00Z | 2026-10-19T00:00:00Z |
| `run20261019-d1` | 2026-10-20T00:00:00Z | 2026-10-19T00:00:00Z |
| `run20261019-d2` | 2026-10-21T00:00:00Z | 2026-10-19T00:00:00Z |
| `run20261019-d3` | 2026-10-22T00:00:00Z | 2026-10-19T00:00:00Z |
| `run20261019-d4` | 2026-10-23T00:00:00Z | 2026-10-19T00:00:00Z |
| `run20261019-d5` | 2026-10-24T00:00:00Z | 2026-10-19T00:00:00Z |

The next day's run (2026-10-20) adds six more items, `run20261020-d0` to `-d5`, with `datetime` 10-20 to 10-25 and `forecast:reference_datetime` 2026-10-20T00:00:00Z. Now 10-20 through 10-24 each exist twice, once from each run. That is expected.

One item in full:

```json
{
  "type": "Feature",
  "stac_version": "1.0.0",
  "id": "run20261019-d2",
  "collection": "my-daily-forecast",
  "geometry": { "type": "Polygon", "coordinates": [[[-180,-90],[180,-90],[180,90],[-180,90],[-180,-90]]] },
  "bbox": [-180, -90, 180, 90],
  "properties": {
    "datetime": "2026-10-21T00:00:00Z",
    "forecast:reference_datetime": "2026-10-19T00:00:00Z",
    "forecast:horizon": "P2D"
  },
  "assets": {
    "data": {
      "href": "s3://bucket/my-daily-forecast/20261019/day2.tif",
      "type": "image/tiff; application=geotiff; profile=cloud-optimized",
      "roles": ["data"]
    }
  }
}
```

### Why `forecast:reference_datetime` exists

- It marks **the start of the run**: the time the forecast that produced the item was issued. Every item from one run has the same value.
- `datetime` alone is ambiguous in a collection with many runs. The valid day 2026-10-21 is predicted by the 10-19 run (its day 2), the 10-20 run (its day 1), and so on.
- The pair (`forecast:reference_datetime`, `datetime`) is **unique**: one run predicts a given valid day exactly once.
- The timeline uses that pairing. It takes the selected run, filters the collection to that run's reference time, and then each tick's valid day matches exactly one item.
- The filter is sent as `query={"forecast:reference_datetime":{"eq":"2026-10-19T00:00:00Z"}}` on both the items request and every tile request (`runQueryParameter` in `shared/common.js`).

## 6. Rules the data must follow

1. **`forecast:reference_datetime` format is exact:** UTC, whole seconds, trailing `Z`, e.g. `2026-10-19T00:00:00Z`. The filter compares strings, so `2026-10-19T00:00:00.000Z` or `+00:00` will not match.
2. **`datetime` is the valid day at exactly 00:00:00Z.** Tile requests ask for `[step instant, step instant + 1s]`, so an item stamped at noon is missed.
3. **No duplicates in a run:** two items of the same run must not share a `datetime`.
4. **Missing items are fine:** a run with only 4 of 6 items shows the other 2 ticks dark.
5. **The collection is reachable at the titiler-pgstac URL in the layer's `url`.** The items endpoint is derived from it.
6. **Index `properties->>'forecast:reference_datetime'` in pgstac** once many runs accumulate. No schema change is needed to query it.

## 7. Run times other than midnight UTC

Day products are set up for midnight UTC runs by default (`runHourUTC: 0`).

The reason: when checking which steps have data, `stepsWithItems` floors each item's `datetime` to UTC midnight but looks it up by `run + n days`. `tileTimeWindow` also windows on the run-plus-n-days instant. With a run hour of 05:00Z those instants are 05:00Z, so they no longer line up with items stamped at midnight, and every tick renders dark.

If the model runs at another hour (say 05:00 UTC), there are two options:

- **Keep `runHourUTC: 0`, no code change.** Set `forecast:reference_datetime` to that UTC day's midnight even though the model finishes later. The run still switches at 00:00Z, but its items are not published until about 05:00Z, so the newest run's ticks are dark until then.
- **Change `forecastTypes/stac.js`**, then use `runHourUTC: 5` with `forecast:reference_datetime` at `T05:00:00Z` and items still stamped at midnight. The change is to floor the step instant to the UTC day in `stepsWithItems` and in the `perRun` branch of `tileTimeWindow`. The run then switches at 05:00Z, when the data exists. This edits shared code, so check with whoever owns it.

## 8. Checking it works

Open the items endpoint for one run and confirm it returns exactly `steps` items:

`<stac url>/items?datetime=<first valid day>/<last valid day>&query=<url-encoded filter>`

Set `window.FTL_DEBUG = true` in the browser console to log the items request the card makes.

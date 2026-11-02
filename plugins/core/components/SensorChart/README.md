# SensorChart

A core MMGIS component plugin that shows an air-quality chart when the user clicks AirNow sensor markers on the map. It plots each sensor's **observed** AQI (blue) against the **forecast** AQI (yellow) from the CSULA predictive air quality model. It also colors the markers by AQI for the current time.

Declared in [plugin.json](plugin.json) as `core-sensorchart`. It is configured per mission through `variables.sensorCharts`, an array with one entry per kind of sensor (read by [sensorConfig.js](sensorConfig.js)):

| Field | Meaning |
|---|---|
| `sensorLayers` | Vector layers whose features are the sensors. A layer in no entry is still charted with defaults and no forecast. |
| `forecastLayers` | Layers that forecast these sensors. The forecast line, card and legend entry show only while one of them is on. Empty means observed-only. |
| `modelName`, `modelLogo` | Credit shown beside the forecast. The logo is a URL. |
| `colorBy` | Reading field that colors markers and cards, using that field's color scale (default `aqi`; `pm25` uses the PM2.5 tile colormap so dots match the tiles). Add scales to `COLOR_SCALES` in [sensorReadings.js](sensorReadings.js). |
| `units` | Reading fields the chart can plot: `key`, `label`, optional `suffix` and `decimals`. The first is the default and more than one adds a toggle. |

Example for the wildfire mission: `{"sensorLayers": ["AirNow"], "forecastLayers": ["PM2.5 Forecast"], "modelName": "CSULA Predictive air quality model", "units": [{"key": "aqi", "label": "AQI"}, {"key": "pm25", "label": "PM2.5", "suffix": "µg/m³", "decimals": 1}]}`.

## What counts as a sensor

A Leaflet layer is treated as a sensor if its GeoJSON feature has a truthy `properties.observed`. The properties it relies on are:

| Property | Shape | Use |
|---|---|---|
| `aqs_code` | string | Unique sensor ID (React keys, removing a sensor) |
| `site_name`, `agency` | string | Panel and card titles |
| `observed` | `[{ time, aqi, pm25 }]` | Hourly observed readings |
| `forecasts` | `{ [runISOTime]: [{ time, aqi, pm25 }] }` | Forecast runs, keyed by the run's start time |
| `color` | string | Written back by the plugin (marker fill) |

## File map

| File | Role |
|---|---|
| [SensorChart.jsx](SensorChart.jsx) | Plugin entry point. Hooks into the map, tracks markers, holds selection and time state, and renders the panel. |
| [SensorChartPanel.jsx](SensorChartPanel.jsx) | The floating panel UI. It has a detailed single-sensor layout and a stacked multi-sensor layout. |
| [SensorTimeSeries.jsx](SensorTimeSeries.jsx) | One Chart.js line chart for one sensor (zoom, pan, click-to-pick, tooltips). |
| [SensorReading.jsx](SensorReading.jsx) | A labeled reading tile (color dot, value, source) used in the single-sensor view. |
| [UnitToggle.jsx](UnitToggle.jsx) | The AQI / PM2.5 switch. |
| [sensorReadings.js](sensorReadings.js) | Pure helpers: time rounding, reading lookup, and the AQI color scale. |
| [SensorChart.module.css](SensorChart.module.css) | Styles for all of the above. |

## How it works

### 1. Entry point and state (`SensorChart.jsx`)

`init()` runs once and:

- Creates a React root in a new `div` appended to `document.body`.
- Wraps two `L_` methods. `L_.resetLayerFills` re-applies sensor colors and the selection style afterward. `L_.highlight` is skipped for sensor markers, so MMGIS's own highlight doesn't override the selection style.
- Registers every existing and newly added sensor marker (`trackSensorMarker`) and attaches a click handler. Removed layers are dropped from the selection.
- Clears the selection when the user clicks the map background (the click that selected a marker is recognized by comparing `originalEvent`).
- Subscribes to time changes and layer toggles (see below).

Module-level state:

- `selectedMarkers`: the clicked markers, in click order.
- `timelineTime`: the main MMGIS timeline's time, rounded down to the hour.
- `forecastStep`: set when the forecast timeline card steps to a specific hour, `null` otherwise.

### 2. Selection

Clicking a sensor toggles it in `selectedMarkers`. The panel is re-rendered on every change. Every sensor marker gets a dark ring (`SENSOR_STROKE`) so it stays visible where its AQI fill matches the surface layer underneath. Selected markers get a thicker dark ring (`SELECTED_STROKE`) and a slightly larger radius, and are brought to the front. Their base radius is remembered in `baseRadii` so it can be restored. The ring is never read back from the layer's own style, because `L_.resetLayerFills` resets markers to that style and it would overwrite the dark ring. `styleSelectedSensors` reapplies the rings after every reset.

### 3. Time and the two "clocks"

The plugin tracks two times for each sensor (`viewOf`):

- **Observed time** is the main timeline's hour.
- **Forecast time** is the hour picked on the forecast timeline card, or the first hour of the active forecast run if none is picked.

Forecasts only apply while one of the entry's `forecastLayers` is on (`L_.layers.on`); a `forecasttimeline:step` from any other layer is ignored. With it off, `viewOf` returns no run and `forecastOn: false`, so the panel shows only observed readings and the chart only the observed line.

The active forecast **run** is the entry in `sensor.forecasts` whose start time equals the forecast step's run, or the timeline time if no step is set.

Events that change time:

- `L_.subscribeTimeChange` updates `timelineTime`, clears `forecastStep`, and recolors the markers.
- The `forecasttimeline:step` document event (hourly steps only) sets `forecastStep` and recolors the markers.
- Turning off the forecast layer clears `forecastStep`, which hides the forecast line, card, and legend entry.

### 4. Marker coloring

`colorSensor` picks the forecast reading for the forecast time if one exists. If not, it uses the observed reading for the observed time. The AQI then maps through `aqiColor`, which interpolates between the standard AQI stops (green, yellow, orange, red, purple, maroon). Grey means no reading.

### 5. The panel (`SensorChartPanel.jsx`)

`renderPanel()` builds one `{ sensor, view }` entry per selected marker and renders a single `SensorChartPanel`.

- **No selection:** renders nothing.
- **One sensor:** a detailed view with a header, observed and forecast reading tiles, and one chart.
- **Two or more sensors:** a shared header ("N AirNow Sensors"), one legend, and one stacked card per sensor. Each card has compact readings, a remove button, and its own chart.

The unit toggle (AQI or PM2.5) is state in the panel, so it applies to every chart at once.

The panel is positioned so it stops above the timeline and coordinates readout. `measureSpaceAboveTimeline` sets the CSS variable `--sensor-chart-bottom-space`, and a `ResizeObserver` on `#timeUI` keeps it current.

### 6. The chart (`SensorTimeSeries.jsx`)

Built with Chart.js (`react-chartjs-2`) and `chartjs-plugin-zoom`.

- **Datasets:** observed (blue), forecast (yellow), and a dashed grey line that bridges gaps where the sensor was unavailable or hasn't reported yet.
- **Join point:** the forecast line starts at the last observed point at or before the run's start, so the two lines connect.
- **Initial view:** a 36-hour window ending 24 hours after the run start, or at the latest data if there is no run.
- **Interaction:**
  - Ctrl + wheel or pinch zooms.
  - Wheel or drag pans.
  - Zoom is limited to the sensor's data range, with a minimum span of 6 hours.
  - The user's zoom and pan range is kept in `viewRef` and survives time changes. If the selected hour leaves the view, the range slides to include it.
- **Click to pick:** a click that isn't a drag selects the nearest observed or forecast point within 24 px. Clicking an observed (blue) point calls `onPickObservedTime`, which moves the main timeline (`TimeControl.setTime`). Clicking a forecast (yellow) point calls `onPickForecastTime`, which dispatches a `forecasttimeline:show-time` event for the forecast card to handle.
- **Markers drawn on the canvas:** a solid line at the run start, a dashed line at the selected time, and dots for the selected observed and forecast values.
- **Axis ticks:** hour ticks are chosen to fit the current zoom, and midnight ticks are labeled with the date.

## Integration points

| Direction | Mechanism |
|---|---|
| Reads | `Map_.map` layers, `TimeControl.currentTime` / `endTime`, `L_` time and layer-toggle subscriptions |
| Listens | `forecasttimeline:step` (document event) |
| Dispatches | `forecasttimeline:show-time` (document event, with `time` and `layerName`) |
| Calls | `TimeControl.setTime(...)` to move the main timeline |
| Monkey-patches | `L_.resetLayerFills`, `L_.highlight` |
| Writes | `--sensor-chart-bottom-space` on `document.documentElement` |

## Things to know

- State in `SensorChart.jsx` lives in module-level variables, not React state. React only renders the panel, driven by `renderPanel()`.
- There is no teardown: `init()` doesn't unsubscribe its listeners or restore the patched `L_` methods.
- `SensorTimeSeries` reads the unit and click handlers through refs so changing them doesn't rebuild the chart options and reset the user's zoom.
- The CSULA logo is [csula-logo.png](csula-logo.png).

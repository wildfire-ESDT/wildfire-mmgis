# forecastTypes

A **forecast type** is the code for one kind of forecast layer: how to show a step of it, and how to tell which steps exist. A layer says which one it is in `time.forecast.type`. The rest of the plugin never knows which type it is talking to.

```
forecastTypes/
  registry.js      registers types and picks the one a layer uses
  allTypes.js      every type this plugin ships besides time; register yours here
  time.js          the default: move the layer's time to the step and refetch
  stac.js          a titiler-pgstac collection, one item per forecast period
  urlTemplate.js   __FSTEP__ in the URL, one WMS layer per step
  wildfire/        the wildfire mission's: veloserverMeteorology.js
```

`time`, `stac` and `url-template` are generic: any mission can use them as they are, and they are the ones the Configure form lists. A mission's own types go in a folder named after the mission and are typed into the form by name.

## Which type a layer gets

1. The one named in `time.forecast.type`.
2. If none is named, one picked from the layer's own settings: `url-template` when `time.forecast.urlTemplate` is on, `stac` when the layer's source type is a STAC collection, otherwise `time`. The console notes the choice once per layer so you can set it explicitly in Configure.
3. If the named type isn't registered, the console logs an error naming the layer and type, and the card shows **"Forecast type not found"** instead of steps.

## Adding a mission's forecast type

1. Make a folder named after your mission, e.g. `forecastTypes/mymission/`.
2. Copy the closest existing type into it. Change `name` and only the methods your data needs; just `name` and `showStep` are required. The interface is in the parent README. To keep the default stepping and change only the availability check, spread it:
   ```js
   import timeForecastType from '../time'
   const myForecastType = { ...timeForecastType, name: 'mine', findAvailableSteps }
   export default myForecastType
   ```
3. Import it in `allTypes.js` and add it to the mission list there.
4. Set `time.forecast.type` on the layer to your type's `name`. Any settings it needs go in `time.forecast.options`.

You can also register a type from any other component with `registerForecastType` from `./registry`, without touching this plugin.

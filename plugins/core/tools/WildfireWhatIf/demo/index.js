// Demo fires: completed six-day forecasts of the wildfire spread model, served by
// the model server (adjacent-servers/wildfire-model), and new what-if runs of the
// same model on them (changed wind, drawn dozer lines).
//
// A forecast arrives as grids on the fire's 0.003° lat/lon window: `arrival` is the
// 12-hour step (1..12) each cell first burns in (255 = burning at the forecast
// start, 0 = never), `observed` the same for the ground truth.
//
//   session.js   shared: the store, STEPS, hidden, the run on screen, the redraw hook
//   api.js       model server requests
//   actions.js   what the UI calls: open/close, step/play, runs, what-ifs, switches
//   render.js    drawing on the map, framing the fire
//   grids.js     decoding the grids, edge smoothing, the fire's extent
//   colors.js    the burn ramp and the input layers' color scales
//   layers.js    the input layers' catalog and data
//   flow.js      the Wind vectors layer (animated by windflow.js)
//   probe.js     the spot readout
//   wind.js      the what-if wind being authored
//   time.js      satellite-pass times and the optional MMGIS clock sync
//   hooks.js     hiding and redrawing when the tool closes and opens
import './hooks'

export { STEPS, activeResult } from './session'
export * from './actions'
export { stepCss, rampCss, START_CSS, OBSERVED_CSS, RAMP_CSS } from './colors'
export { fireBounds } from './grids'
export { passTime, fmtPass, setSyncMapTime } from './time'
export { layerCacheKey, inputOpacity } from './layers'
export { drawDemo, focusFire } from './render'
export { readProbe, clearProbe, noteMapFeatureClick } from './probe'
export { observedWind, windEdited } from './wind'

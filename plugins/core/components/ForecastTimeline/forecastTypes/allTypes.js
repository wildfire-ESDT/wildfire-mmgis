/**
 * Every forecast type this plugin ships, besides the default `time`. A layer
 * picks one by name in time.forecast.type. To add a mission's type, import it
 * and register it in the mission block below.
 */

import { registerForecastType } from './registry'

// Generic. Ship with the plugin; the Configure form lists these.
import stacForecastType from './stac'
import urlTemplateForecastType from './urlTemplate'

// Mission types. One folder per mission.
import veloserverMeteorologyForecastType from './wildfire/veloserverMeteorology'

;[stacForecastType, urlTemplateForecastType].forEach((forecastType) =>
    registerForecastType(forecastType, { generic: true })
)
registerForecastType(veloserverMeteorologyForecastType)

export { stacForecastType, urlTemplateForecastType, veloserverMeteorologyForecastType }

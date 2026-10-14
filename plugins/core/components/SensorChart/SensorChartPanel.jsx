import React, { useState } from 'react'
import UnitToggle from './UnitToggle'
import SensorReading from './SensorReading'
import SensorTimeSeries, { formatTime, OBSERVED_COLOR, FORECAST_COLOR } from './SensorTimeSeries'
import { readingAt, aqiColor } from './sensorReadings'
import styles from './SensorChart.module.css'
import csulaLogo from './csula-logo.png'

const UNITS = { aqi: 'AQI', pm25: 'PM2.5' }
const ONE_HOUR = 3600000

export default function SensorChartPanel({ sensor, view, onClose }) {
    const [unit, setUnit] = useState('aqi')
    if (!sensor) return null
    const observed = sensor.observed.find((reading) => Date.parse(reading.time) === view.observedTime && reading.aqi != null)
    const selected = readingAt(sensor, view.time, view.run)
    const forecast = selected?.isForecast ? selected : null
    const hoursAhead = forecast && Math.round((Date.parse(forecast.time) - Date.parse(view.run)) / ONE_HOUR)
    const formatValue = (reading) => {
        const value = reading?.[unit]
        if (value == null) return `${UNITS[unit]} —`
        return `${UNITS[unit]} ${unit === 'pm25' ? value.toFixed(1) : value}`
    }

    return (
        <div className={styles.panel}>
            <div className={styles.header}>
                <div className={styles.title}>
                    <div className={styles.siteName}>AirNow Sensor - {sensor.site_name}</div>
                    <div className={styles.subtitle}>Managed by {sensor.agency}</div>
                </div>
                <UnitToggle units={UNITS} selectedUnit={unit} onSelect={setUnit} />
                <i className={`mdi mdi-close ${styles.close}`} onClick={onClose} />
            </div>
            <div className={styles.readings}>
                <SensorReading
                    label={`Observed · ${formatTime(view.observedTime)}`}
                    value={formatValue(observed)}
                    color={aqiColor(observed?.aqi)}
                    accent={OBSERVED_COLOR}
                    source={observed ? 'AirNow sensor reading' : 'No reading yet'}
                />
                {!view.run && (
                    <SensorReading
                        label={`Forecast · ${formatTime(view.time)}`}
                        value={formatValue(null)}
                        color={aqiColor(null)}
                        accent={FORECAST_COLOR}
                        source="Not available yet"
                    />
                )}
                {forecast && (
                    <SensorReading
                        label={`Forecast · ${formatTime(Date.parse(forecast.time))} · ${hoursAhead}h ahead`}
                        value={formatValue(forecast)}
                        color={aqiColor(forecast.aqi)}
                        accent={FORECAST_COLOR}
                        source={
                            <>
                                <img className={styles.modelLogo} src={csulaLogo} alt="Cal State LA" />
                                CSULA Predictive air quality model 
                            </>
                        }
                    />
                )}
            </div>
            <div className={styles.body}>
                <SensorTimeSeries
                    key={sensor.aqs_code}
                    sensor={sensor}
                    unit={unit}
                    run={view.run}
                    selectedTime={view.time}
                    observedTime={view.observedTime}
                />
            </div>
        </div>
    )
}

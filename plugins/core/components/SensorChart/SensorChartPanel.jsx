import React, { useState } from 'react'
import UnitToggle from './UnitToggle'
import SensorReading from './SensorReading'
import SensorTimeSeries, { formatTime, OBSERVED_COLOR, FORECAST_COLOR } from './SensorTimeSeries'
import { readingsAt, aqiColor } from './sensorReadings'
import styles from './SensorChart.module.css'
import csulaLogo from './csula-logo.png'

const UNITS = { aqi: 'AQI', pm25: 'PM2.5' }

export default function SensorChartPanel({ entries, onRemoveSensor, onClose }) {
    const [unit, setUnit] = useState('aqi')
    if (!entries.length) return null
    const formatValue = (reading) => {
        const value = reading?.[unit]
        if (value == null) return `${UNITS[unit]} —`
        return unit === 'pm25' ? `${UNITS[unit]} ${value.toFixed(1)} µg/m³` : `${UNITS[unit]} ${value}`
    }

    if (entries.length === 1) {
        const { sensor, view } = entries[0]
        const { observed, forecast, hoursAhead } = readingsAt(sensor, view)
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
                            label={`Forecast · ${formatTime(view.forecastTime)}`}
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
                        selectedTime={view.forecastTime}
                        observedTime={view.observedTime}
                    />
                </div>
            </div>
        )
    }

    return (
        <div className={styles.panel} style={{ '--sensor-count': entries.length }}>
            <div className={styles.header}>
                <div className={styles.title}>
                    <div className={styles.siteName}>{entries.length} AirNow Sensors</div>
                    <div className={styles.subtitle}>{formatTime(entries[0].view.time)}</div>
                </div>
                <UnitToggle units={UNITS} selectedUnit={unit} onSelect={setUnit} />
                <i className={`mdi mdi-close ${styles.close}`} onClick={onClose} />
            </div>
            <div className={styles.legend}>
                <span className={styles.legendItem}>
                    <span className={styles.legendLine} style={{ background: OBSERVED_COLOR }} />
                    Observed · AirNow
                </span>
                <span className={styles.legendItem}>
                    <span className={styles.legendLine} style={{ background: FORECAST_COLOR }} />
                    Forecast ·
                    <img className={styles.modelLogo} src={csulaLogo} alt="Cal State LA" />
                    CSULA Predictive air quality model
                </span>
                <span className={styles.legendItem}>
                    <span className={styles.legendDashed} />
                    Sensor unavailable
                </span>
            </div>
            <div className={styles.sensorCards}>
                {entries.map(({ sensor, view }) => {
                    const { observed, forecast, hoursAhead } = readingsAt(sensor, view)
                    return (
                        <div key={sensor.aqs_code} className={styles.sensorCard}>
                            <div className={styles.sensorCardHeader}>
                                <div className={styles.sensorCardName} title={`Managed by ${sensor.agency}`}>
                                    {sensor.site_name}
                                    <span className={styles.sensorCardAgency}>{sensor.agency}</span>
                                </div>
                                <div className={styles.compactReading} style={{ borderColor: OBSERVED_COLOR }}>
                                    <span className={styles.colorDot} style={{ background: aqiColor(observed?.aqi) }} />
                                    {formatValue(observed)}
                                </div>
                                <div className={styles.compactReading} style={{ borderColor: FORECAST_COLOR }}>
                                    <span className={styles.colorDot} style={{ background: aqiColor(forecast?.aqi) }} />
                                    {formatValue(forecast)}
                                    {forecast && <span className={styles.hoursAhead}>{hoursAhead}h</span>}
                                </div>
                                <i
                                    className={`mdi mdi-close ${styles.close}`}
                                    onClick={() => onRemoveSensor(sensor.aqs_code)}
                                    title="Remove"
                                />
                            </div>
                            <div className={styles.sensorCardChart}>
                                <SensorTimeSeries
                                    sensor={sensor}
                                    unit={unit}
                                    run={view.run}
                                    selectedTime={view.forecastTime}
                                    observedTime={view.observedTime}
                                />
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

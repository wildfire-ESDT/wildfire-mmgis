import React, { useState } from 'react'
import UnitToggle from './UnitToggle'
import SensorReading from './SensorReading'
import SensorTimeSeries, { formatTime, OBSERVED_COLOR, FORECAST_COLOR } from './SensorTimeSeries'
import { readingsAt, colorFor } from './sensorReadings'
import styles from './SensorChart.module.css'

export default function SensorChartPanel({ entries, onRemoveSensor, onClose, onPickObservedTime, onPickForecastTime }) {
    const [selectedUnit, setUnit] = useState(null)
    if (!entries.length) return null
    // Sensors from different configs share one panel; the first sets its units and model.
    const { config } = entries[0]
    const unit = config.units.find((candidate) => candidate.key === selectedUnit) ?? config.units[0]
    const unitLabels = Object.fromEntries(config.units.map((candidate) => [candidate.key, candidate.label]))
    const forecastOn = entries.some(({ view }) => view.forecastOn)
    const formatValue = (reading) => {
        const value = reading?.[unit.key]
        if (value == null) return `${unit.label} —`
        const shown = unit.decimals != null ? Number(value).toFixed(unit.decimals) : value
        return `${unit.label} ${shown}${unit.suffix ? ` ${unit.suffix}` : ''}`
    }
    const modelSource = config.modelName && (
        <>
            {config.modelLogo && <img className={styles.modelLogo} src={config.modelLogo} alt="" />}
            {config.modelName}
        </>
    )

    if (entries.length === 1) {
        const { sensor, view } = entries[0]
        const { observed, forecast, hoursAhead } = readingsAt(sensor, view, config.colorBy)
        return (
            <div className={styles.panel}>
                <div className={styles.header}>
                    <div className={styles.title}>
                        <div className={styles.siteName}>AirNow Sensor - {sensor.site_name}</div>
                        <div className={styles.subtitle}>Managed by {sensor.agency}</div>
                    </div>
                        <UnitToggle units={unitLabels} selectedUnit={unit.key} onSelect={setUnit} />
                    <i className={`mdi mdi-close ${styles.close}`} onClick={onClose} />
                </div>
                <div className={styles.readings}>
                    <SensorReading
                        label={`Observed · ${formatTime(view.observedTime)}`}
                        value={formatValue(observed)}
                        color={colorFor(config, observed?.[config.colorBy])}
                        accent={OBSERVED_COLOR}
                        source={observed ? 'AirNow sensor reading' : 'No reading yet'}
                    />
                    {view.forecastOn && !view.run && (
                        <SensorReading
                            label={`Forecast · ${formatTime(view.forecastTime)}`}
                            value={formatValue(null)}
                            color={colorFor(config, null)}
                            accent={FORECAST_COLOR}
                            source="Not available yet"
                        />
                    )}
                    {forecast && (
                        <SensorReading
                            label={`Forecast · ${formatTime(Date.parse(forecast.time))} · ${hoursAhead}h ahead`}
                            value={formatValue(forecast)}
                            color={colorFor(config, forecast[config.colorBy])}
                            accent={FORECAST_COLOR}
                            source={modelSource || 'Forecast'}
                        />
                    )}
                </div>
                <div className={styles.body}>
                    <SensorTimeSeries
                        key={sensor.aqs_code}
                        sensor={sensor}
                        unit={unit}
                        forecastLayerName={view.forecastLayerName}
                        run={view.run}
                        selectedTime={view.forecastTime}
                        observedTime={view.observedTime}
                        onPickObservedTime={onPickObservedTime}
                        onPickForecastTime={onPickForecastTime}
                    />
                </div>
            </div>
        )
    }

    return (
        <div className={styles.panel}>
            <div className={styles.header}>
                <div className={styles.title}>
                    <div className={styles.siteName}>{entries.length} AirNow Sensors</div>
                    <div className={styles.subtitle}>{formatTime(entries[0].view.time)}</div>
                </div>
                <UnitToggle units={unitLabels} selectedUnit={unit.key} onSelect={setUnit} />
                <i className={`mdi mdi-close ${styles.close}`} onClick={onClose} />
            </div>
            <div className={styles.legend}>
                <span className={styles.legendItem}>
                    <span className={styles.legendLine} style={{ background: OBSERVED_COLOR }} />
                    Observed · AirNow
                </span>
                {forecastOn && (
                    <span className={styles.legendItem}>
                        <span className={styles.legendLine} style={{ background: FORECAST_COLOR }} />
                        Forecast ·
                        {modelSource}
                    </span>
                )}
                <span className={styles.legendItem}>
                    <span className={styles.legendDashed} />
                    Sensor unavailable
                </span>
            </div>
            <div className={styles.sensorCards}>
                {entries.map(({ sensor, config: sensorConfig, view }) => {
                    const { observed, forecast, hoursAhead } = readingsAt(sensor, view, sensorConfig.colorBy)
                    return (
                        <div key={sensor.aqs_code} className={styles.sensorCard}>
                            <div className={styles.sensorCardHeader}>
                                <div className={styles.sensorCardName} title={`Managed by ${sensor.agency}`}>
                                    {sensor.site_name}
                                    <span className={styles.sensorCardAgency}>{sensor.agency}</span>
                                </div>
                                <div className={styles.compactReading} style={{ borderColor: OBSERVED_COLOR }}>
                                    <span className={styles.colorDot} style={{ background: colorFor(sensorConfig, observed?.[sensorConfig.colorBy]) }} />
                                    {formatValue(observed)}
                                </div>
                                {view.forecastOn && (
                                    <div className={styles.compactReading} style={{ borderColor: FORECAST_COLOR }}>
                                        <span className={styles.colorDot} style={{ background: colorFor(sensorConfig, forecast?.[sensorConfig.colorBy]) }} />
                                        {formatValue(forecast)}
                                        {forecast && <span className={styles.hoursAhead}>{hoursAhead}h</span>}
                                    </div>
                                )}
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
                                    forecastLayerName={view.forecastLayerName}
                                    run={view.run}
                                    selectedTime={view.forecastTime}
                                    observedTime={view.observedTime}
                                    onPickObservedTime={onPickObservedTime}
                                    onPickForecastTime={onPickForecastTime}
                                />
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

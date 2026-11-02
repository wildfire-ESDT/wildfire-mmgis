import React from 'react'
import styles from './SensorChart.module.css'

export default function UnitToggle({ units, selectedUnit, onSelect }) {
    return (
        <div className={styles.unitToggle}>
            {Object.entries(units).map(([unit, label]) => (
                <button
                    key={unit}
                    type="button"
                    className={unit === selectedUnit ? styles.selectedUnit : styles.unit}
                    aria-pressed={unit === selectedUnit}
                    onClick={() => onSelect(unit)}
                >
                    {label}
                </button>
            ))}
        </div>
    )
}

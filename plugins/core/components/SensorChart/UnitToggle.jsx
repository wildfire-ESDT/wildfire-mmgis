import React from 'react'
import styles from './SensorChart.module.css'

export default function UnitToggle({ units, selectedUnit, onSelect }) {
    return (
        <div className={styles.unitToggle}>
            {Object.entries(units).map(([unit, label]) => (
                <div key={unit} className={unit === selectedUnit ? styles.selectedUnit : styles.unit} onClick={() => onSelect(unit)}>
                    {label}
                </div>
            ))}
        </div>
    )
}

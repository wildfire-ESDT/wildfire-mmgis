import React from 'react'
import styles from './SensorChart.module.css'

export default function SensorReading({ label, value, color, accent, source }) {
    return (
        <div className={styles.reading} style={{ borderColor: accent }}>
            <div className={styles.label}>{label}</div>
            <div className={styles.readingValue}>
                <span className={styles.colorDot} style={{ background: color }} />
                {value}
            </div>
            <div className={styles.subtitle}>{source}</div>
        </div>
    )
}

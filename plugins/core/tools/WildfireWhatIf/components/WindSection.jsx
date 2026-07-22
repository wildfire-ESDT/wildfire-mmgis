import React from 'react'
import useWhatIfStore, { hourEdited } from '../store'
import { fetchWinds, selectHour, setWind, resetHours } from '../actions'
import { dirLabel, msToMph } from '../utils'
import { Button, Slider } from '@design/components'
import SchemaForm from './SchemaForm'

// Clickable forecast-hour strip. The ALL cell switches slider edits to apply
// to every hour together (as an offset); numbered cells edit one hour. Top
// row is the offset (+n), bottom row the local PDT hour. A yellow underline
// marks hours whose winds were edited.
function HourStrip() {
    const hours = useWhatIfStore((s) => s.hours)
    const hrrrRun = useWhatIfStore((s) => s.hrrrRun)
    const selectedFxx = useWhatIfStore((s) => s.selectedFxx)
    const editScope = useWhatIfStore((s) => s.editScope)

    if (!hours) {
        return (
            <div className="ww-hour-strip-empty">
                Fetch the 12-hr HRRR winds above to view and edit each forecast
                hour.
            </div>
        )
    }

    const baseHour = hrrrRun ? hrrrRun.hour_pdt : 0
    return (
        <div className="ww-hour-strip">
            <button
                type="button"
                className={`ww-hour-chip ww-hour-chip-all${editScope === 'all' ? ' all-active' : ''}`}
                title="Edit all 13 hours together — slider changes shift every hour by the same amount"
                onClick={() =>
                    useWhatIfStore.setState({
                        editScope: editScope === 'all' ? 'hour' : 'all',
                    })
                }
            >
                ALL
            </button>
            {hours.map((h) => {
                const localHour = (baseHour + h.fxx) % 24
                const disabled = !h.base
                const classes = ['ww-hour-chip']
                if (h.fxx === selectedFxx) classes.push('selected')
                if (hourEdited(h)) classes.push('edited')
                if (h.loading) classes.push('loading')
                return (
                    <button
                        key={h.fxx}
                        type="button"
                        className={classes.join(' ')}
                        disabled={disabled}
                        title={`f${String(h.fxx).padStart(2, '0')} · ${String(localHour).padStart(2, '0')}:00 PDT${disabled ? ' · unavailable' : ''}`}
                        onClick={() => selectHour(h.fxx)}
                    >
                        <span className="ww-hour-chip-fxx">+{h.fxx}</span>
                        <span className="ww-hour-chip-time">
                            {String(localHour).padStart(2, '0')}
                        </span>
                    </button>
                )
            })}
        </div>
    )
}

export default function WindSection() {
    const fetchingWinds = useWhatIfStore((s) => s.fetchingWinds)
    const windProgress = useWhatIfStore((s) => s.windProgress)
    const hrrrError = useWhatIfStore((s) => s.hrrrError)
    const hrrrRun = useWhatIfStore((s) => s.hrrrRun)
    const windStale = useWhatIfStore((s) => s.windStale)
    const hours = useWhatIfStore((s) => s.hours)
    const selectedFxx = useWhatIfStore((s) => s.selectedFxx)
    const editScope = useWhatIfStore((s) => s.editScope)

    const sel = hours && hours[selectedFxx]
    const wind = sel && sel.target

    let sourceText = ''
    if (wind) {
        const editingAll = editScope === 'all'
        if (editingAll) sourceText = 'Editing all 13 hours together'
        else if (hourEdited(sel))
            sourceText = `f+${sel.fxx} · edited (HRRR base ${sel.base.speed_ms} m/s @ ${sel.base.direction_deg}°)`
        else sourceText = `f+${sel.fxx} · HRRR`
    }

    return (
        <>
            <SchemaForm sections={['HRRR Model Run']} />
            <Button
                className="ww-full"
                disabled={fetchingWinds}
                onClick={() => fetchWinds()}
            >
                {fetchingWinds ? 'Fetching…' : 'Fetch 12-hr HRRR Winds'}
            </Button>
            {windProgress && (
                <div
                    className="ww-progress"
                    title="Hours become editable as they load"
                >
                    <div
                        className="ww-progress-bar"
                        style={{
                            width: `${(windProgress.done / windProgress.total) * 100}%`,
                        }}
                    />
                    <span className="ww-progress-label">
                        {windProgress.done}/{windProgress.total} hours loaded —
                        edit as they arrive
                    </span>
                </div>
            )}
            {hrrrError && (
                <div className="ww-status ww-status-err">
                    HRRR fetch failed: {hrrrError}
                </div>
            )}
            {hrrrRun && !fetchingWinds && (
                <div className="ww-status ww-status-bbox">
                    {hrrrRun.source || 'HRRR'} · f00–f12 loaded
                    {windStale
                        ? ' — perimeter changed, refetch to update the grid'
                        : ''}
                </div>
            )}

            <div className="ww-section-label">Wind · Now → +12 h</div>
            <HourStrip />

            {wind && (
                <>
                    <div className="ww-wind-header">
                        <div className="ww-arrow-wrap">
                            <svg
                                viewBox="0 0 24 24"
                                width="26"
                                height="26"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                style={{
                                    transform: `rotate(${wind.direction_deg}deg)`,
                                }}
                            >
                                <line x1="12" y1="20" x2="12" y2="4" />
                                <polyline points="7,9 12,4 17,9" />
                            </svg>
                        </div>
                        <span className="ww-wind-source">{sourceText}</span>
                    </div>

                    <div className="ww-slider-row">
                        <span className="ww-slider-label">Speed</span>
                        <Slider
                            min={0}
                            max={30}
                            step={0.1}
                            value={Number(wind.speed_ms)}
                            onValueChange={(v) =>
                                setWind(
                                    'speed_ms',
                                    Array.isArray(v) ? v[0] : v
                                )
                            }
                        />
                        <span className="ww-slider-val">
                            {Number(wind.speed_ms).toFixed(1)} m/s ·{' '}
                            {msToMph(wind.speed_ms)} mph
                        </span>
                    </div>
                    <div className="ww-slider-row">
                        <span className="ww-slider-label">From</span>
                        <Slider
                            min={0}
                            max={359}
                            step={1}
                            value={Number(wind.direction_deg)}
                            onValueChange={(v) =>
                                setWind(
                                    'direction_deg',
                                    Array.isArray(v) ? v[0] : v
                                )
                            }
                        />
                        <span className="ww-slider-val">
                            {Math.round(wind.direction_deg)}°{' '}
                            {dirLabel(wind.direction_deg)}
                        </span>
                    </div>

                    <div className="ww-hour-tools">
                        <span className="ww-hour-tools-hint">
                            {editScope === 'all'
                                ? 'Slider changes shift every hour together'
                                : `Editing forecast hour +${selectedFxx}`}
                        </span>
                        <Button
                            size="sm"
                            onClick={() => resetHours(false)}
                        >
                            Reset hour
                        </Button>
                        <Button size="sm" onClick={() => resetHours(true)}>
                            Reset all
                        </Button>
                    </div>

                    <div className="ww-wind-legend">
                        <span>0</span>
                        <div className="ww-wind-legend-bar" />
                        <span>15+ m/s</span>
                    </div>
                </>
            )}
        </>
    )
}

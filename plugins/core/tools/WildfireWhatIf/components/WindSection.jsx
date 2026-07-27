import React from 'react'
import useWhatIfStore from '../store'
import { fetchWinds, setWind, resetWind } from '../actions'
import { dirLabel, msToMph } from '../utils'
import { Button, Slider } from '@design/components'

// "Winds from 2:00 PM PDT (21:00 UTC) · current hour" — browser-local first,
// UTC second, and an explicit flag when the latest published cycle is behind
// the wall clock.
function cycleStatus(hrrrRun) {
    const d = new Date(hrrrRun.valid_iso)
    if (isNaN(d.getTime())) return (hrrrRun.source || 'HRRR') + ' loaded'
    const time = d.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
    })
    const day =
        d.toDateString() === new Date().toDateString()
            ? ''
            : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' '
    const utc = `${String(d.getUTCHours()).padStart(2, '0')}:00 UTC`
    const hoursBehind =
        Math.floor(Date.now() / 3600e3) - Math.floor(d.getTime() / 3600e3)
    const freshness =
        hoursBehind <= 0
            ? 'current hour'
            : `latest available, ${hoursBehind} h behind current hour`
    return `Winds from ${day}${time} (${utc}) · ${freshness}`
}

export default function WindSection() {
    const fetchingWinds = useWhatIfStore((s) => s.fetchingWinds)
    const hrrrError = useWhatIfStore((s) => s.hrrrError)
    const hrrrRun = useWhatIfStore((s) => s.hrrrRun)
    const windStale = useWhatIfStore((s) => s.windStale)
    const wind = useWhatIfStore((s) => s.wind)

    const target = wind && wind.target
    const edited =
        wind &&
        wind.base &&
        target &&
        (target.speed_ms !== wind.base.speed_ms ||
            target.direction_deg !== wind.base.direction_deg)

    return (
        <>
            {fetchingWinds && (
                <div className="ww-status ww-status-bbox">
                    <span className="ww-spinner" /> Fetching latest observed
                    winds…
                </div>
            )}
            {hrrrError && !fetchingWinds && (
                <div className="ww-status ww-status-err">
                    Wind fetch failed: {hrrrError}
                </div>
            )}
            {hrrrRun && !fetchingWinds && (
                <div className="ww-status ww-status-bbox">
                    {cycleStatus(hrrrRun)}
                    {windStale ? ' (perimeter changed, refetching)' : ''}
                </div>
            )}
            {wind && !fetchingWinds && (
                <div className="ww-hour-tools">
                    <Button size="sm" onClick={() => fetchWinds()}>
                        Refetch Latest Wind
                    </Button>
                </div>
            )}

            <div className="ww-section-label">Wind</div>

            {!wind && !fetchingWinds && (
                <div className="ww-hour-strip-empty">
                    Set a fire perimeter and the latest observed winds will
                    load automatically.
                </div>
            )}

            {target && (
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
                                    transform: `rotate(${target.direction_deg}deg)`,
                                }}
                            >
                                <line x1="12" y1="20" x2="12" y2="4" />
                                <polyline points="7,9 12,4 17,9" />
                            </svg>
                        </div>
                        <span className="ww-wind-source">
                            {edited
                                ? `edited (observed: ${wind.base.speed_ms} m/s @ ${wind.base.direction_deg}°)`
                                : 'HRRR observed'}
                        </span>
                    </div>

                    <div className="ww-slider-row">
                        <span className="ww-slider-label">Speed</span>
                        <Slider
                            min={0}
                            max={30}
                            step={0.1}
                            value={Number(target.speed_ms)}
                            onValueChange={(v) =>
                                setWind('speed_ms', Array.isArray(v) ? v[0] : v)
                            }
                        />
                        <span className="ww-slider-val">
                            {Number(target.speed_ms).toFixed(1)} m/s ·{' '}
                            {msToMph(target.speed_ms)} mph
                        </span>
                    </div>
                    <div className="ww-slider-row">
                        <span className="ww-slider-label">From</span>
                        <Slider
                            min={0}
                            max={359}
                            step={1}
                            value={Number(target.direction_deg)}
                            onValueChange={(v) =>
                                setWind(
                                    'direction_deg',
                                    Array.isArray(v) ? v[0] : v
                                )
                            }
                        />
                        <span className="ww-slider-val">
                            {Math.round(target.direction_deg)}°{' '}
                            {dirLabel(target.direction_deg)}
                        </span>
                    </div>

                    {edited && (
                        <div className="ww-hour-tools">
                            <Button size="sm" onClick={() => resetWind()}>
                                Reset to Observed
                            </Button>
                        </div>
                    )}

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

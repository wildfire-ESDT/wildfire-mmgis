import React from 'react'
import useWhatIfStore from '../store'
import { fetchWinds, setWind, resetWind } from '../actions'
import { dirLabel, msToMph } from '../utils'
import { Button, Slider } from '@design/components'
import SchemaForm from './SchemaForm'

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
            <SchemaForm sections={['HRRR Model Run']} />
            <Button
                className="ww-full"
                disabled={fetchingWinds}
                onClick={() => fetchWinds()}
            >
                {fetchingWinds ? 'Fetching…' : 'Fetch HRRR Wind'}
            </Button>
            {hrrrError && (
                <div className="ww-status ww-status-err">
                    HRRR fetch failed: {hrrrError}
                </div>
            )}
            {hrrrRun && !fetchingWinds && (
                <div className="ww-status ww-status-bbox">
                    {hrrrRun.source || 'HRRR'} · f00 loaded
                    {windStale ? ' — perimeter changed, refetch to update' : ''}
                </div>
            )}

            <div className="ww-section-label">Wind</div>

            {!wind && (
                <div className="ww-hour-strip-empty">
                    Fetch winds to edit speed and direction.
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
                                ? `edited (base ${wind.base.speed_ms} m/s @ ${wind.base.direction_deg}°)`
                                : 'HRRR f00'}
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
                                Reset to HRRR
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

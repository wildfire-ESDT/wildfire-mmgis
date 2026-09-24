import React, { useState } from 'react'
import useWhatIfStore from '../store'
import { fetchWinds, setWind, resetWind } from '../actions'
import { dirLabel, msToMph, fmtWind } from '../utils'
import { Button, IconButton, Slider } from '@design/components'
import SectionLabel from './SectionLabel'

// "HRRR 9:00 AM PDT", plus how old it is when it isn't the current hour.
function cycleStatus(hrrrRun) {
    const d = new Date(hrrrRun.valid_iso)
    if (isNaN(d.getTime())) return 'HRRR'
    const time = d.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
    })
    const day =
        d.toDateString() === new Date().toDateString()
            ? ''
            : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' '
    const label = `HRRR ${day}${time}`
    if (hrrrRun.source === 'restored') return label
    const hoursOld =
        Math.floor(Date.now() / 3600e3) - Math.floor(d.getTime() / 3600e3)
    return hoursOld > 0 ? `${label} · ${hoursOld} h old` : label
}

function WindArrow({ deg }) {
    // Points where the wind blows TO (direction_deg is where it comes FROM)
    return (
        <div className="ww-arrow-wrap">
            <svg
                viewBox="0 0 24 24"
                width="26"
                height="26"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                style={{ transform: `rotate(${(deg + 180) % 360}deg)` }}
            >
                <line x1="12" y1="20" x2="12" y2="4" />
                <polyline points="7,9 12,4 17,9" />
            </svg>
        </div>
    )
}

export default function WindSection() {
    const fetchingWinds = useWhatIfStore((s) => s.fetchingWinds)
    const hrrrError = useWhatIfStore((s) => s.hrrrError)
    const hrrrRun = useWhatIfStore((s) => s.hrrrRun)
    const windStale = useWhatIfStore((s) => s.windStale)
    const wind = useWhatIfStore((s) => s.wind)
    const [editOpen, setEditOpen] = useState(false)

    const target = wind && wind.target
    const edited =
        wind &&
        wind.base &&
        target &&
        (target.speed_ms !== wind.base.speed_ms ||
            target.direction_deg !== wind.base.direction_deg)

    return (
        <>
            <SectionLabel>Wind</SectionLabel>

            {fetchingWinds && (
                <div className="ww-status ww-status-info">
                    <span className="ww-spinner" /> Loading the latest
                    observed winds…
                </div>
            )}

            {hrrrError && !fetchingWinds && (
                <div className="ww-status ww-status-err">
                    Couldn't load winds: {hrrrError}{' '}
                    <button
                        type="button"
                        className="ww-link-btn"
                        onClick={() => fetchWinds()}
                    >
                        Retry
                    </button>
                </div>
            )}

            {target && !fetchingWinds && (
                <div className="ww-card">
                    <div className="ww-wind-summary">
                        <WindArrow deg={target.direction_deg} />
                        <div className="ww-wind-text">
                            <div className="ww-card-title">{fmtWind(target)}</div>
                            <div className="ww-card-line">
                                {edited
                                    ? `Adjusted · observed ${fmtWind(wind.base)}`
                                    : hrrrRun
                                    ? cycleStatus(hrrrRun)
                                    : 'Observed'}
                                {windStale ? ' · updating' : ''}
                            </div>
                        </div>
                        <div className="ww-corner-actions">
                            <IconButton
                                size="sm"
                                title="Refetch the latest winds"
                                onClick={() => fetchWinds()}
                            >
                                <i className="mdi mdi-refresh mdi-16px" />
                            </IconButton>
                            <Button
                                size="sm"
                                className={editOpen ? 'ww-btn-active' : ''}
                                title="Change the wind speed and direction"
                                onClick={() => setEditOpen((o) => !o)}
                            >
                                {editOpen ? 'Done' : 'Modify'}
                            </Button>
                        </div>
                    </div>
                    {editOpen && (
                        <>
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
                            <div className="ww-wind-legend">
                                <span>0</span>
                                <div className="ww-wind-legend-bar" />
                                <span>15+ m/s</span>
                            </div>
                            {edited && (
                                <div className="ww-edit-footer">
                                    <Button size="sm" onClick={() => resetWind()}>
                                        <i className="mdi mdi-restore mdi-14px ww-btn-icon" />
                                        Reset to observed
                                    </Button>
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}
        </>
    )
}

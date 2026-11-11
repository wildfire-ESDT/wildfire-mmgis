// The fire's name and county, and its incident details (WFIGS record and this
// forecast) in a dropdown.
import React from 'react'
import useWhatIfStore from '../../store'
import { setDetailsOpen, passTime, fmtPass, truthOf } from '../../demo'
import { fmtAc, localWhen } from './format'

export default function FireHeader({ info, id, res }) {
    const open = useWhatIfStore((s) => s.detailsOpen)
    const chosen = truthOf(res, useWhatIfStore((s) => s.truthSource))
    const inc = (info && info.incident) || {}
    const lon = info && info.bounds ? (info.bounds[0][1] + info.bounds[1][1]) / 2 : 0
    const knownCause = inc.cause && !/^(undetermined|unknown)$/i.test(String(inc.cause).trim())
    const discovered = localWhen(inc.ignition, lon)
    // the day of the fire the forecast starts on (1 = the day it was discovered)
    const startPass = res ? passTime(res.start_time, res.grid) : null
    const ign = inc.ignition ? new Date(String(inc.ignition).replace(' ', 'T') + 'Z') : null
    const fireDay = startPass && ign && !isNaN(ign.getTime()) ? Math.floor((startPass - ign) / 86400e3) + 1 : null
    const where = [inc.county ? `${inc.county} County` : null, inc.state].filter(Boolean).join(', ')
    const name = info ? String(info.name).split(',')[0] : id
    return (
        <div className={`ww-an-title${open ? ' open' : ''}`}>
            <button
                type="button"
                className="ww-an-fire-row"
                aria-expanded={open}
                title={open ? 'Hide the incident details' : 'Show the incident details'}
                onClick={() => setDetailsOpen(!open)}
            >
                <span className="ww-an-badge">
                    <i className="mdi mdi-fire" />
                </span>
                <span className="ww-an-fire-text">
                    <span className="ww-an-fire">{name} Fire</span>
                    <span className="ww-an-where">{where}</span>
                </span>
                <i className={`mdi ${open ? 'mdi-chevron-up' : 'mdi-chevron-down'} ww-an-details-chevron`} />
            </button>
            {open && (
                <div className="ww-an-details">
                    <div className="ww-meta-head">Incident · WFIGS</div>
                    <dl className="ww-meta">
                        {inc.incident_number && (
                            <>
                                <dt>Incident</dt>
                                <dd className="mono">{inc.incident_number}</dd>
                            </>
                        )}
                        <dt>Type</dt>
                        <dd>
                            {inc.type || 'Wildfire'}
                            {knownCause ? ` · ${String(inc.cause).toLowerCase()} cause` : ''}
                        </dd>
                        <dt>Location</dt>
                        <dd>
                            {where}
                            {inc.lat != null && (
                                <span className="ww-meta-sub">
                                    {Math.abs(inc.lat).toFixed(2)}° {inc.lat >= 0 ? 'N' : 'S'}, {Math.abs(inc.lon).toFixed(2)}°{' '}
                                    {inc.lon >= 0 ? 'E' : 'W'}
                                </span>
                            )}
                        </dd>
                        {discovered && (
                            <>
                                <dt>Discovered</dt>
                                <dd>{discovered}</dd>
                            </>
                        )}
                        {inc.reported_acres != null && (
                            <>
                                <dt>Final size</dt>
                                <dd>{fmtAc(inc.reported_acres)}</dd>
                            </>
                        )}
                    </dl>
                    {res && (
                        <>
                            <div className="ww-meta-head">This forecast</div>
                            <dl className="ww-meta">
                                <dt>Window</dt>
                                <dd>
                                    {fmtPass(res.start_time, res.grid).split(',')[0]} to{' '}
                                    {fmtPass(res.steps[res.steps.length - 1].time, res.grid, { year: true }).split(', about')[0]}
                                    <span className="ww-meta-sub">six days in 12-hour steps</span>
                                </dd>
                                <dt>Starts</dt>
                                <dd>
                                    {fmtPass(res.start_time, res.grid).split(', ')[1]}
                                    {fireDay ? <span className="ww-meta-sub">day {fireDay} of the fire</span> : null}
                                </dd>
                                <dt>Fire at start</dt>
                                <dd>
                                    {fmtAc(res.start_acres)}
                                    <span className="ww-meta-sub">{info ? info.start_perimeter : ''}</span>
                                </dd>
                                <dt>Ground truth</dt>
                                <dd className="ww-an-truth-src">{chosen ? chosen.label : info ? info.observed : ''}</dd>
                            </dl>
                        </>
                    )}
                </div>
            )}
        </div>
    )
}

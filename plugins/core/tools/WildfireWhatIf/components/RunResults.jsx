import React, { useState } from 'react'
import useWhatIfStore from '../store'
import {
    newScenario,
    renameRun,
    downloadSpreadGeoJSON,
    downloadSpreadPNG,
} from '../actions'
import {
    runStats,
    fmtAcres,
    fmtPct,
    runSubtitle,
    fmtWind,
    fmtHrrr,
    simTypeLabel,
} from '../utils'
import { Button } from '@design/components'

function Stat({ label, value, sub }) {
    return (
        <div className="ww-stat">
            <div className="ww-stat-label">{label}</div>
            <div className="ww-stat-value">{value}</div>
            {sub && <div className="ww-stat-sub">{sub}</div>}
        </div>
    )
}

function RunStats({ job, isSmoke }) {
    const st = runStats(job)
    if (isSmoke)
        return (
            <div className="ww-stats">
                <Stat label="Fire area" value={fmtAcres(st.start)} />
                <Stat label="Smoke extent" value={fmtAcres(st.end)} />
            </div>
        )
    return (
        <div className="ww-stats">
            <Stat label="Starting" value={fmtAcres(st.start)} />
            <Stat label="Forecast" value={fmtAcres(st.end)} />
            <Stat
                label="Growth"
                value={st.growth == null ? '—' : `+${fmtAcres(st.growth)}`}
                sub={fmtPct(st.growthPct)}
            />
        </div>
    )
}

// Run name as the card title; click it (or the pencil) to rename in place.
// Enter or leaving the field saves, Esc cancels.
function RunTitle({ id, name }) {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(name || '')
    const save = () => {
        const next = draft.trim()
        if (next && next !== name) renameRun(id, next)
        else setDraft(name || '')
        setEditing(false)
    }
    if (editing)
        return (
            <input
                className="ww-title-input"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={save}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') save()
                    if (e.key === 'Escape') {
                        setDraft(name || '')
                        setEditing(false)
                    }
                }}
            />
        )
    return (
        <button
            type="button"
            className="ww-title"
            title="Rename this run"
            onClick={() => {
                setDraft(name || '')
                setEditing(true)
            }}
        >
            <span className="ww-title-text">{name || id}</span>
            <i className="mdi mdi-pencil mdi-14px" />
        </button>
    )
}

// Flat key/value view of a run's primitive payload fields, for the Details
// disclosure.
function paramEntries(p) {
    return Object.entries(p).filter(
        ([, v]) =>
            typeof v === 'string' ||
            typeof v === 'number' ||
            typeof v === 'boolean'
    )
}

// Results view for the selected run: replaces the Setup sections while a run
// is open. The map shows only this run's perimeter, spread and dozer lines.
export default function RunResults({ id }) {
    const job = useWhatIfStore((s) => s.jobs[id])
    const showActiveJson = useWhatIfStore((s) => s.showActiveJson)
    const p = job.payload || {}
    const isSmoke = p.sim_type === 'smoke_dispersion'
    const nDozer = Array.isArray(p.dozer_lines) ? p.dozer_lines.length : 0
    const subtitle = runSubtitle(job)
    const inputs = [
        ['Wind', fmtWind(p.wind_mods)],
        ['Weather', fmtHrrr(p.hrrr_run)],
        ['Dozer lines', nDozer ? String(nDozer) : 'None'],
    ].filter(([, v]) => v)

    return (
        <div className="ww-results">
            <div className="ww-results-top">
                <RunTitle key={job.name} id={id} name={job.name} />
                <span className={`ww-sim-badge ${isSmoke ? 'smoke' : 'fire'}`}>
                    {simTypeLabel(p.sim_type)}
                </span>
            </div>
            {subtitle && <div className="ww-results-sub">{subtitle}</div>}

            <RunStats job={job} isSmoke={isSmoke} />

            <div className="ww-kv">
                {inputs.map(([k, v]) => (
                    <React.Fragment key={k}>
                        <span className="ww-kv-key">{k}</span>
                        <span className="ww-kv-val">{v}</span>
                    </React.Fragment>
                ))}
            </div>

            <div className="ww-results-actions">
                <Button
                    variant="primary"
                    className="ww-grow"
                    onClick={() => newScenario()}
                >
                    <i className="mdi mdi-fire mdi-14px ww-btn-icon" />
                    Select New Perimeter
                </Button>
            </div>

            <div className="ww-section-label">Download</div>
            <div className="ww-exp-downloads">
                <Button size="sm" onClick={() => downloadSpreadPNG(job)}>
                    <i className="mdi mdi-image mdi-14px ww-btn-icon" />
                    Map image (PNG)
                </Button>
                <Button size="sm" onClick={() => downloadSpreadGeoJSON(job)}>
                    <i className="mdi mdi-download mdi-14px ww-btn-icon" />
                    GeoJSON
                </Button>
            </div>

            <details className="ww-details">
                <summary>Details</summary>
                <div className="ww-params-grid">
                    <span className="ww-param-key">run id</span>
                    <span className="ww-param-val" title={id}>
                        {id}
                    </span>
                    {paramEntries(p).map(([k, v]) => (
                        <React.Fragment key={k}>
                            <span className="ww-param-key">{k}</span>
                            <span className="ww-param-val" title={String(v)}>
                                {String(v)}
                            </span>
                        </React.Fragment>
                    ))}
                </div>
                <button
                    type="button"
                    className="ww-link-btn"
                    onClick={() =>
                        useWhatIfStore.setState({ showActiveJson: !showActiveJson })
                    }
                >
                    {showActiveJson ? 'Hide' : 'Show'} raw JSON
                </button>
                {showActiveJson && (
                    <pre className="ww-exp-json">
                        {JSON.stringify(job.result || job.payload, null, 2)}
                    </pre>
                )}
            </details>
        </div>
    )
}

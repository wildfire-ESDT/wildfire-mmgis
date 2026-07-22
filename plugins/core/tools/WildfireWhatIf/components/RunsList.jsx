import React, { useState } from 'react'
import useWhatIfStore, { PAGE_SIZE } from '../store'
import { selectRun, renameRun } from '../actions'
import { dirLabel } from '../utils'
import { Button } from '@design/components'

function normalizeStatus(s) {
    if (!s) return 'unknown'
    const l = String(s).toLowerCase()
    if (['completed', 'complete', 'succeeded', 'success'].includes(l)) return 'completed'
    if (['failed', 'error'].includes(l)) return 'failed'
    if (['running', 'processing'].includes(l)) return 'running'
    if (['queued', 'pending'].includes(l)) return 'queued'
    return l
}

// Flat key/value summary of a run's payload — primitives only, the same idea
// as Workflows' params grid. Structured values get their own rows above.
function paramEntries(p) {
    return Object.entries(p).filter(
        ([, v]) =>
            typeof v === 'string' ||
            typeof v === 'number' ||
            typeof v === 'boolean'
    )
}

function ActiveRunDetails({ id, job }) {
    const showActiveJson = useWhatIfStore((s) => s.showActiveJson)
    const [nameDraft, setNameDraft] = useState(job.name || '')
    const p = job.payload || {}
    const profile = Array.isArray(p.wind_profile) ? p.wind_profile : null
    const params = paramEntries(p)
    const save = () => renameRun(id, nameDraft.trim())
    return (
        <div className="ww-job-expanded" onClick={(e) => e.stopPropagation()}>
            <div className="ww-exp-uuid" title="Run id">
                {id}
            </div>
            <div className="ww-exp-label">Name</div>
            <div className="ww-exp-name-row">
                <input
                    type="text"
                    placeholder="e.g. Palisades – SE wind shift"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') save()
                    }}
                />
                <Button size="sm" onClick={save}>
                    Save
                </Button>
            </div>
            {p.wind_mods && (
                <div className="ww-exp-row">
                    Wind: {p.wind_mods.speed_ms} m/s from{' '}
                    {Math.round(p.wind_mods.direction_deg)}°{' '}
                    {dirLabel(p.wind_mods.direction_deg)}
                </div>
            )}
            {profile && (
                <div className="ww-exp-row">
                    12-hr profile: {profile.length} hours,{' '}
                    {profile.filter((h) => h.edited).length} edited
                </div>
            )}
            {params.length > 0 && (
                <div className="ww-params-grid">
                    {params.map(([k, v]) => (
                        <React.Fragment key={k}>
                            <span className="ww-param-key">{k}</span>
                            <span className="ww-param-val" title={String(v)}>
                                {String(v)}
                            </span>
                        </React.Fragment>
                    ))}
                </div>
            )}
            <div className="ww-exp-row ww-exp-dim">
                Scenario restored to map · click the row again to deselect
            </div>
            <Button
                size="sm"
                onClick={() =>
                    useWhatIfStore.setState({ showActiveJson: !showActiveJson })
                }
            >
                {showActiveJson ? 'Hide' : 'Show'} payload JSON
            </Button>
            {showActiveJson && (
                <pre className="ww-exp-json">
                    {JSON.stringify(job.result || job.payload, null, 2)}
                </pre>
            )}
        </div>
    )
}

export default function RunsList() {
    const jobs = useWhatIfStore((s) => s.jobs)
    const jobIds = useWhatIfStore((s) => s.jobIds)
    const filterText = useWhatIfStore((s) => s.filterText)
    const page = useWhatIfStore((s) => s.page)
    const activeJobId = useWhatIfStore((s) => s.activeJobId)

    const f = filterText.trim().toLowerCase()
    const visibleIds = f
        ? jobIds.filter((id) => {
              if (id.toLowerCase().includes(f)) return true
              const name = (jobs[id] && jobs[id].name) || ''
              return name.toLowerCase().includes(f)
          })
        : jobIds

    const total = visibleIds.length
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    const safePage = Math.min(page, totalPages - 1)
    const pageIds = visibleIds.slice(
        safePage * PAGE_SIZE,
        safePage * PAGE_SIZE + PAGE_SIZE
    )

    return (
        <div className="ww-jobs">
            <div className="ww-jobs-header">
                <div className="ww-section-label">Runs</div>
                <span className="ww-jobs-hint">
                    Click a run to view it on the map
                </span>
            </div>
            {jobIds.length > 0 && (
                <input
                    type="text"
                    className="ww-jobs-filter"
                    placeholder="Filter by name or id…"
                    value={filterText}
                    onChange={(e) =>
                        useWhatIfStore.setState({
                            filterText: e.target.value,
                            page: 0,
                        })
                    }
                />
            )}
            <div className="ww-jobs-list">
                {total === 0 && (
                    <div className="ww-empty">
                        {f ? 'No runs match the filter.' : 'No runs yet.'}
                    </div>
                )}
                {pageIds.map((id) => {
                    const job = jobs[id] || { status: 'unknown', name: id }
                    const isActive = activeJobId === id
                    const simType =
                        (job.payload && job.payload.sim_type) || 'fire_spread'
                    return (
                        <div
                            key={id}
                            className={`ww-job${isActive ? ' active' : ''}`}
                        >
                            <div
                                className="ww-job-header"
                                title={id}
                                onClick={() => selectRun(id)}
                            >
                                <span
                                    className={`ww-job-dot ${normalizeStatus(job.status)}`}
                                />
                                <span className="ww-job-name">
                                    {job.name || id}
                                </span>
                                <span
                                    className={`ww-sim-badge ${simType === 'smoke_dispersion' ? 'smoke' : 'fire'}`}
                                >
                                    {simType === 'smoke_dispersion'
                                        ? 'Smoke'
                                        : 'Fire'}
                                </span>
                                <span className="ww-job-time">
                                    {new Date(job.startedAt).toLocaleString()}
                                </span>
                            </div>
                            {isActive && (
                                <ActiveRunDetails key={id} id={id} job={job} />
                            )}
                        </div>
                    )
                })}
            </div>
            {totalPages > 1 && (
                <div className="ww-pagination">
                    <Button
                        size="sm"
                        disabled={safePage === 0}
                        onClick={() =>
                            useWhatIfStore.setState({ page: safePage - 1 })
                        }
                    >
                        Prev
                    </Button>
                    <span className="ww-page-label">
                        Page {safePage + 1} of {totalPages} · {total} runs
                    </span>
                    <Button
                        size="sm"
                        disabled={safePage >= totalPages - 1}
                        onClick={() =>
                            useWhatIfStore.setState({ page: safePage + 1 })
                        }
                    >
                        Next
                    </Button>
                </div>
            )}
        </div>
    )
}

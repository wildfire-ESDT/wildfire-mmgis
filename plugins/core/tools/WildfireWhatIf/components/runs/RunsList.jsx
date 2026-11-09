import React, { useEffect } from 'react'
import useWhatIfStore, { PAGE_SIZE } from '../../store'
import { selectRun, deleteRun } from '../../actions'
import { loadDemos, openDemo } from '../../demo'
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

function fmtDay(iso, withYear) {
    const d = new Date(String(iso).replace(' ', 'T') + (/[zZ+]/.test(String(iso).slice(10)) ? '' : 'Z'))
    if (isNaN(d.getTime())) return ''
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' })
}

function fmtAc(a) {
    return a == null ? '—' : `${Math.round(a).toLocaleString()} ac`
}

// The model's six-day forecasts of test fires (from the model server), listed
// as runs; opening one shows it in the Fire analysis window beside the fire.
function ModelRuns({ filter }) {
    const demos = useWhatIfStore((s) => s.demos)
    const loading = useWhatIfStore((s) => s.demosLoading)
    const error = useWhatIfStore((s) => s.demosError)
    useEffect(() => {
        if (demos === null && !loading && !error) loadDemos()
    }, [])
    if (error)
        return (
            <div className="ww-status ww-status-err">
                {error}{' '}
                <button type="button" className="ww-link-btn" onClick={() => loadDemos()}>
                    Retry
                </button>
            </div>
        )
    if (loading)
        return (
            <div className="ww-status ww-status-info">
                <span className="ww-spinner" /> Loading the model's forecasts…
            </div>
        )
    const shown = (demos || []).filter((d) => !filter || String(d.name).toLowerCase().includes(filter))
    return shown.map((d) => (
        <div key={d.id} className="ww-job">
            <div className="ww-job-header" title={`Open the ${d.name} forecast`} onClick={() => openDemo(d.id)}>
                <span className="ww-job-dot completed" />
                <span className="ww-job-name">{d.name}</span>
                <span className="ww-sim-badge sixday">Six-day</span>
                <span className="ww-job-time">
                    {fmtDay(d.start_time)} to {fmtDay(d.end_time, true)}
                </span>
            </div>
            {d.start_acres != null && (
                <div className="ww-job-sub">
                    {fmtAc(d.start_acres)} at the start · {fmtAc(d.forecast_acres_144h)} forecast · {fmtAc(d.truth_acres_144h)}{' '}
                    ground truth ({d.observed})
                </div>
            )}
        </div>
    ))
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
                <ModelRuns filter={f} />
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
                                <span
                                    className="ww-job-delete"
                                    title="Delete run"
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        if (window.confirm(`Delete "${job.name || id}"?`)) deleteRun(id)
                                    }}
                                >
                                    ✕
                                </span>
                            </div>
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

import React from 'react'
import useWhatIfStore, { PAGE_SIZE } from '../store'
import { selectRun, deleteRun } from '../actions'
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

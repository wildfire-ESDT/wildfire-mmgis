import React from 'react'
import { selectDemoRun, removeDemoRun } from '../../demo'

// This fire's runs: the model's forecast and each what-if. Picking one shows it, and loads its
// wind and dozer lines into What-if to change and run again
export default function ForecastRuns({ runs, idx }) {
    return (
        <div className="ww-runs">
            <div className="ww-runs-head">Runs</div>
            {runs.map((r, i) => (
                <div
                    key={i}
                    role="button"
                    tabIndex={0}
                    className={`ww-job${i === idx ? ' active' : ''}`}
                    title={i === 0 ? 'Show the model forecast' : 'Show this what-if (its wind and lines load into What-if)'}
                    onClick={() => selectDemoRun(i)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && selectDemoRun(i)}
                >
                    <div className="ww-job-header">
                        <span className="ww-job-dot completed" />
                        <span className="ww-job-name">{i === 0 ? 'Model forecast' : r.name.replace(/^What-if: /, '')}</span>
                        <span className={`ww-sim-badge ${i === 0 ? 'sixday' : 'whatif'}`}>{i === 0 ? 'Six-day' : 'What-if'}</span>
                        {i > 0 && (
                            <span
                                className="ww-job-delete"
                                title="Remove this run"
                                onClick={(e) => {
                                    e.stopPropagation()
                                    removeDemoRun(i)
                                }}
                            >
                                ✕
                            </span>
                        )}
                    </div>
                </div>
            ))}
        </div>
    )
}

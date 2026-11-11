// The main part of the window: which run is shown, its time and timeline, the
// forecast's and the ground truth's acres, the two panel buttons and the runs.
import React from 'react'
import useWhatIfStore from '../../store'
import { setSyncMapTime, setSidePanel, fmtPass, truthOf, baselineOf } from '../../demo'
import Timeline from './Timeline'
import ForecastRuns from './ForecastRuns'
import { fmtAc } from './format'

// The clock toggle: whether MMGIS's own time follows the forecast (off by default)
function SyncTimeToggle() {
    const on = useWhatIfStore((s) => s.syncMapTime)
    return (
        <button
            type="button"
            className={`ww-sync-time${on ? ' on' : ''}`}
            aria-pressed={on}
            title={on ? "The map's time follows the forecast. Click to stop" : "Make the map's time follow the forecast"}
            onClick={() => setSyncMapTime(!on)}
        >
            <i className={`mdi ${on ? 'mdi-clock-check-outline' : 'mdi-clock-outline'}`} />
        </button>
    )
}

// A button that slides its panel out beside the window (both can be open: Area conditions above What-if)
function PanelButton({ kind, icon, label, note }) {
    const open = useWhatIfStore((s) => !!s.sidePanels[kind])
    return (
        <button
            type="button"
            className={`ww-an-panel-button${open ? ' open' : ''}`}
            aria-pressed={open}
            title={open ? `Close ${label}` : `Open ${label} beside this window`}
            onClick={() => setSidePanel(kind, !open)}
        >
            <i className={`mdi ${icon}`} />
            <span className="ww-an-panel-text">
                <span className="ww-an-panel-label">{label}</span>
                <span className="ww-an-panel-note">{note}</span>
            </span>
        </button>
    )
}

export default function ForecastSection({ res, runs, idx, step, playing }) {
    const st = step > 0 ? res.steps[step - 1] : null
    const when = step === 0 ? res.start_time : st.time
    const start = res.start_acres
    const forecast = st ? st.forecast_acres : start
    const chosen = truthOf(res, useWhatIfStore((s) => s.truthSource)) // the ground truth picked in Area conditions
    const truth = !st ? start : chosen ? chosen.acres[step - 1] : st.observed_acres
    const showForecast = useWhatIfStore((s) => s.showForecast)
    const showObserved = useWhatIfStore((s) => s.showObserved)
    const windFlow = useWhatIfStore((s) => s.windFlow)
    const visibleInputs = useWhatIfStore((s) => s.visibleInputs)
    const compare = useWhatIfStore((s) => s.compareTruth)
    const whatif = res.kind === 'whatif' // a what-if's acres are not set against the ground truth's (it never happened)
    // ... but with the model forecast it was made from: its acres at the same step
    const base = useWhatIfStore((s) => baselineOf(s))
    const baseAc = !base ? null : step > 0 && base.steps[step - 1] ? base.steps[step - 1].forecast_acres : base.start_acres
    const moved = baseAc == null ? 0 : forecast - baseAc
    const shown = [showForecast, showObserved, windFlow].filter(Boolean).length + visibleInputs.length
    const grow = (g) => (g > 0.5 ? `+${Math.round(g).toLocaleString()} ac` : null)
    return (
        <>
            <div className="ww-hero">
                <div className="ww-hero-label">
                    <span>{res.kind === 'whatif' ? 'What-if forecast' : 'Model forecast'}</span>
                    {res.kind === 'whatif' && <span className="ww-hero-label-run">{res.name.replace(/^What-if: /, '')}</span>}
                </div>
                <div className="ww-hero-time">
                    <span className="ww-hero-lead">{step === 0 ? 'Start' : `+${step * 12} h`}</span>
                    <span className="ww-hero-when">{fmtPass(when, res.grid)}</span>
                    <SyncTimeToggle />
                </div>
                <Timeline res={res} step={step} playing={playing} />
                <div className={`ww-trio ww-duo${whatif && baseAc == null ? ' ww-solo' : ''}`}>
                    <div className="ww-trio-cell fire">
                        <span className="ww-trio-label">
                            <i className="mdi mdi-fire" /> {whatif ? 'What-if' : 'Forecast'}
                        </span>
                        <strong>{fmtAc(forecast)}</strong>
                        <span className="ww-trio-sub">
                            {grow(forecast - start) || 'no growth yet'}
                            {baseAc != null && step > 0 && Math.abs(moved) >= 0.5 && (
                                <span className={`ww-an-vs ${moved > 0 ? 'over' : 'under'}`} title="Against the model forecast at this step">
                                    {moved > 0 ? '▲' : '▼'}
                                    {Math.abs(Math.round(moved)).toLocaleString()} ac
                                </span>
                            )}
                            {compare && !whatif && step > 0 && truth > 0 && (
                                <span className={`ww-an-vs ${forecast >= truth ? 'over' : 'under'}`}>
                                    {forecast >= truth ? '▲' : '▼'}
                                    {Math.abs(Math.round((forecast / truth - 1) * 100))}%
                                </span>
                            )}
                        </span>
                    </div>
                    {baseAc != null && (
                        <div className="ww-trio-cell">
                            <span className="ww-trio-label">
                                <i className="mdi mdi-fire" /> Model forecast
                            </span>
                            <strong>{fmtAc(baseAc)}</strong>
                            <span className="ww-trio-sub">{grow(baseAc - start) || 'no growth yet'}</span>
                        </div>
                    )}
                    {!whatif && (
                        <div className="ww-trio-cell truth">
                            <span className="ww-trio-label">
                                <i className="mdi mdi-satellite-variant" /> Ground truth
                            </span>
                            <strong>{fmtAc(truth)}</strong>
                            <span className="ww-trio-sub">{grow(truth - start) || 'no growth yet'}</span>
                        </div>
                    )}
                </div>
            </div>
            <div className="ww-an-panel-buttons">
                <PanelButton kind="area" icon="mdi-layers-outline" label="Area conditions" note={`${shown} shown`} />
                <PanelButton kind="whatif" icon="mdi-magnify" label="What-if" note="wind, dozer lines" />
            </div>
            <ForecastRuns runs={runs} idx={idx} />
        </>
    )
}

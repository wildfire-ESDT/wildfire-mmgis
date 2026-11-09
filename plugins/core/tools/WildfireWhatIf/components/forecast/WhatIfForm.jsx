import React from 'react'
import useWhatIfStore from '../../store'
import { setDemoWind, resetDemoWind, windEdited, runDemoWhatIf, setWindEditOpen } from '../../demo'
import { dirLabel, msToMph, fmtWind } from '../../utils'
import { Button, Slider } from '@design/components'
import SectionLabel from '../common/SectionLabel'
import DozerLinesSection from '../scenario/DozerLinesSection'
import { WindArrow } from '../scenario/WindSection'

// The what-if wind, as the setup view's Wind card: the six-day mean of the
// real wind, and Modify to set the mean the what-if should have (the real
// hourly winds are scaled and turned to it, so their changes over the six days stay).
function DemoWindCard() {
    const runs = useWhatIfStore((s) => s.demoResults[s.activeDemo] || [])
    const target = useWhatIfStore((s) => s.demoWind)
    const editOpen = useWhatIfStore((s) => s.windEditOpen)
    const base = runs[0] && runs[0].wind_observed
    if (!base) return null
    const w = target || base
    const edited = windEdited()
    const maxSpeed = Math.max(3 * base.speed_ms, 0.1) // the server takes up to three times the real wind
    return (
        <>
            <SectionLabel>Wind</SectionLabel>
            <div className="ww-card">
                <div className="ww-wind-summary">
                    <WindArrow deg={w.direction_deg} />
                    <div className="ww-wind-text">
                        <div className="ww-card-title">{fmtWind(w)}</div>
                        {edited && <div className="ww-card-line">Adjusted · real {fmtWind(base)}</div>}
                    </div>
                    <div className="ww-corner-actions">
                        <Button
                            size="sm"
                            className={editOpen ? 'ww-btn-active' : ''}
                            title="Change the wind speed and direction"
                            onClick={() => setWindEditOpen(!editOpen)}
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
                                max={Math.floor(maxSpeed * 10) / 10}
                                step={0.1}
                                value={Number(w.speed_ms)}
                                onValueChange={(v) => setDemoWind('speed_ms', Array.isArray(v) ? v[0] : v)}
                            />
                            <span className="ww-slider-val">
                                {Number(w.speed_ms).toFixed(1)} m/s · {msToMph(w.speed_ms)} mph
                            </span>
                        </div>
                        <div className="ww-slider-row">
                            <span className="ww-slider-label">From</span>
                            <Slider
                                min={0}
                                max={359}
                                step={1}
                                value={Number(w.direction_deg)}
                                onValueChange={(v) => setDemoWind('direction_deg', Array.isArray(v) ? v[0] : v)}
                            />
                            <span className="ww-slider-val">
                                {Math.round(w.direction_deg)}° {dirLabel(w.direction_deg)}
                            </span>
                        </div>
                        <div className="ww-submit-hint">
                            The real hourly winds are scaled and turned to this mean.
                        </div>
                        {edited && (
                            <div className="ww-edit-footer">
                                <Button size="sm" onClick={() => resetDemoWind()}>
                                    <i className="mdi mdi-restore mdi-14px ww-btn-icon" />
                                    Reset to observed
                                </Button>
                            </div>
                        )}
                    </>
                )}
            </div>
            <div className="ww-submit-hint ww-an-arrows-hint">While Modify is open, yellow arrows on the map show this wind at the shown hour.</div>
        </>
    )
}

// The What-if panel: the wind and the dozer lines a new run of the model gets
// (picking a run in the main window loads its settings here). It sits inside an element with
// the tool panel's id so it wears the panel's own card, slider and list styles.
export default function WhatIfForm() {
    const busy = useWhatIfStore((s) => s.demoBusy)
    return (
        <div id="wildfireTool" className="ww-an-panel">
            <DemoWindCard />
            <DozerLinesSection always />
            <Button
                variant="primary"
                className="ww-full ww-submit"
                disabled={busy}
                title="Runs the model again with this wind and these lines. Lines reach the model's physics step: each hour a line holds or is crossed by flame length, embers and crew limits."
                onClick={() => runDemoWhatIf()}
            >
                {busy ? 'Running the model…' : 'Generate Forecast'}
            </Button>
        </div>
    )
}

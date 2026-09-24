import React from 'react'
import useWhatIfStore from '../store'
import { submit } from '../actions'
import ToolController_ from '@basics/ToolController_/ToolController_'
import { Button, IconButton } from '@design/components'
import PerimeterSection from './PerimeterSection'
import WindSection from './WindSection'
import FuelSection from './FuelSection'
import DozerLinesSection from './DozerLinesSection'
import SchemaForm from './SchemaForm'
import RunsList from './RunsList'
import RunResults from './RunResults'
import LoginGate from './LoginGate'
import SectionLabel from './SectionLabel'
import { logout } from '../auth'

export default function WhatIfPanel() {
    const submitting = useWhatIfStore((s) => s.submitting)
    const authUser = useWhatIfStore((s) => s.authUser)
    const hasPerimeter = useWhatIfStore((s) => !!s.perimeterRing)
    const hasWind = useWhatIfStore((s) => !!(s.wind && s.wind.target))
    const fetchingWinds = useWhatIfStore((s) => s.fetchingWinds)
    // Setup edits the draft scenario; opening a run swaps in its results
    const viewingId = useWhatIfStore((s) =>
        s.activeJobId && s.jobs[s.activeJobId] ? s.activeJobId : null
    )

    return (
        <LoginGate>
            <div id="wildfireTool" className="mmgisScrollbar">
                <div className="mmgisToolHeader">
                    <div>
                        <div>
                            <div className="mmgisToolTitle">
                                Wildfire Scenario Forecast Tool
                            </div>
                        </div>
                        <div>
                            <IconButton
                                size="sm"
                                onClick={() =>
                                    ToolController_.closeActiveTool()
                                }
                                title="Close Tool"
                            >
                                <i className="mdi mdi-close mdi-18px" />
                            </IconButton>
                        </div>
                    </div>
                </div>

                <div className="ww-signed-in">
                    <span className="ww-account">
                        <i className="mdi mdi-account-circle mdi-18px" />
                        <span>
                            Signed in as <strong>{authUser || 'user'}</strong>
                        </span>
                    </span>
                    <button
                        type="button"
                        className="ww-logout-btn"
                        onClick={() => logout()}
                    >
                        Log Out
                    </button>
                </div>

                {viewingId ? (
                    <RunResults key={viewingId} id={viewingId} />
                ) : (
                    <>
                        <PerimeterSection />
                        {/* Everything else waits for a perimeter: until
                            then the panel only explains how to start one. */}
                        {hasPerimeter && (
                            <>
                                <WindSection />
                                {/* <FuelSection /> */}
                                <DozerLinesSection />
                                <SectionLabel>Scenario</SectionLabel>
                                <SchemaForm
                                    compact
                                    sections={[
                                        'Simulation Type',
                                        'Scenario Name',
                                    ]}
                                />
                                <Button
                                    variant="primary"
                                    className="ww-full ww-submit"
                                    disabled={submitting || !hasWind}
                                    onClick={() => submit()}
                                >
                                    {submitting
                                        ? 'Generating…'
                                        : 'Generate Forecast'}
                                </Button>
                                {!hasWind && fetchingWinds && (
                                    <div className="ww-submit-hint">
                                        Loading winds…
                                    </div>
                                )}
                            </>
                        )}
                    </>
                )}

                <RunsList />
            </div>
        </LoginGate>
    )
}

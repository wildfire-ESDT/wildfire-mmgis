import React from 'react'
import useWhatIfStore from '../store'
import { dismissActionError, submit } from '../actions'
import ToolController_ from '@basics/ToolController_/ToolController_'
import { Button, IconButton } from '@design/components'
import PerimeterSection from './scenario/PerimeterSection'
import WindSection from './scenario/WindSection'
import FuelSection from './scenario/FuelSection'
import DozerLinesSection from './scenario/DozerLinesSection'
import SchemaForm from './common/SchemaForm'
import RunsList from './runs/RunsList'
import RunResults from './runs/RunResults'
import LoginGate from './common/LoginGate'
import FireAnalysisWindow from './forecast/FireAnalysisWindow'
import SectionLabel from './common/SectionLabel'
import { logout } from '../auth'

export default function WhatIfPanel() {
    const submitting = useWhatIfStore((s) => s.submitting)
    const authUser = useWhatIfStore((s) => s.authUser)
    const hasPerimeter = useWhatIfStore((s) => !!s.perimeterRing)
    const hasWind = useWhatIfStore((s) => !!(s.wind && s.wind.target))
    const fetchingWinds = useWhatIfStore((s) => s.fetchingWinds)
    const actionError = useWhatIfStore((s) => s.actionError)
    // Setup edits the draft scenario; opening a run swaps in its results
    const activeDemo = useWhatIfStore((s) => s.activeDemo)
    const viewingId = useWhatIfStore((s) =>
        s.activeJobId && s.jobs[s.activeJobId] ? s.activeJobId : null
    )

    // A demo fire is open: the Fire analysis window beside it is the whole tool
    // until "Back to tool"; the panel steps out of the way
    if (activeDemo)
        return (
            <LoginGate>
                <FireAnalysisWindow key={activeDemo} />
            </LoginGate>
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

                {actionError && (
                    <div className="ww-status ww-status-err">
                        {actionError}{' '}
                        <button
                            type="button"
                            className="ww-link-btn"
                            onClick={() => dismissActionError()}
                        >
                            Dismiss
                        </button>
                    </div>
                )}

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

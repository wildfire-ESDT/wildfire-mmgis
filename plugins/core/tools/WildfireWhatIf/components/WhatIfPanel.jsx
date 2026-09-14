import React from 'react'
import useWhatIfStore from '../store'
import { submit } from '../actions'
import ToolController_ from '@basics/ToolController_/ToolController_'
import { Button, IconButton } from '@design/components'
import PerimeterSection from './PerimeterSection'
import WindSection from './WindSection'
import SchemaForm from './SchemaForm'
import RunsList from './RunsList'
import LoginGate from './LoginGate'
import { logout } from '../auth'

export default function WhatIfPanel() {
    const submitting = useWhatIfStore((s) => s.submitting)
    const authUser = useWhatIfStore((s) => s.authUser)

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
                            onClick={() => ToolController_.closeActiveTool()}
                            title="Close Tool"
                        >
                            <i className="mdi mdi-close mdi-18px" />
                        </IconButton>
                    </div>
                </div>
            </div>

            <div className="ww-signed-in">
                <span>Signed in as {authUser || 'user'}</span>
                <button
                    type="button"
                    className="ww-logout-btn"
                    onClick={() => logout()}
                >
                    Log Out
                </button>
            </div>

            <PerimeterSection />
            <WindSection />
            <SchemaForm sections={['Simulation Type', 'Scenario Name']} />
            <Button
                variant="primary"
                className="ww-full ww-submit"
                disabled={submitting}
                onClick={() => submit()}
            >
                {submitting ? 'Submitting…' : 'Generate Forecast'}
            </Button>

            <RunsList />
        </div>
        </LoginGate>
    )
}

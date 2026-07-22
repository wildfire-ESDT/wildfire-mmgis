import React from 'react'
import useWhatIfStore from '../store'
import { submit } from '../actions'
import ToolController_ from '@basics/ToolController_/ToolController_'
import { Button, IconButton } from '@design/components'
import PerimeterSection from './PerimeterSection'
import WindSection from './WindSection'
import SchemaForm from './SchemaForm'
import RunsList from './RunsList'

export default function WhatIfPanel() {
    const submitting = useWhatIfStore((s) => s.submitting)

    return (
        <div id="wildfireTool" className="mmgisScrollbar">
            <div className="mmgisToolHeader">
                <div>
                    <div>
                        <div className="mmgisToolTitle">
                            Wildfire Scenario Forecast
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
    )
}

// While a demo fire is open this window is the whole tool, fixed at the map's top
// right: the fire (FireHeader), the shown run and its timeline (ForecastSection),
// and the side column with Area conditions and What-if (SideColumn).
import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import useWhatIfStore from '../../store'
import { closeDemo, focusFire, setToolCollapsed } from '../../demo'
import useDocked from './useDocked'
import FireHeader from './FireHeader'
import ForecastSection from './ForecastSection'
import SideColumn from './SideColumn'

export default function FireAnalysisWindow() {
    const info = useWhatIfStore((s) => (s.demos || []).find((d) => d.id === s.activeDemo))
    const id = useWhatIfStore((s) => s.activeDemo)
    const runs = useWhatIfStore((s) => s.demoResults[s.activeDemo] || [])
    const idx = useWhatIfStore((s) => s.demoIdx)
    const step = useWhatIfStore((s) => s.demoStep)
    const playing = useWhatIfStore((s) => s.demoPlaying)
    const busy = useWhatIfStore((s) => s.demoBusy)
    const error = useWhatIfStore((s) => s.demoError)
    const ref = useRef(null)
    const pos = useDocked(ref, true)
    const sidePanels = useWhatIfStore((s) => s.sidePanels)
    const collapsed = useWhatIfStore((s) => s.toolCollapsed)
    useWhatIfStore((s) => s.demoStep) // the collapsed bar shows the step

    const res = runs.length ? runs[Math.min(idx, runs.length - 1)] : null

    // a new what-if run: back to the top, where the run picker shows it
    useEffect(() => {
        if (ref.current) ref.current.scrollTop = 0
    }, [runs.length])

    return createPortal(
        <div
            ref={ref}
            className={`ww-fire-layers${!collapsed && (sidePanels.area || sidePanels.whatif) ? ' has-side' : ''}${collapsed ? ' collapsed' : ''}`}
            style={pos ? { left: pos.left, top: pos.top, right: 'auto', maxHeight: pos.maxHeight } : { visibility: 'hidden' }}
        >
            <div className="ww-an-header ww-an-header-main">
                <button type="button" className="ww-an-back ww-an-back-icon" title="Back to the runs" onClick={() => closeDemo()}>
                    <i className="mdi mdi-arrow-left" />
                </button>
                <span className="ww-an-heading">
                    {collapsed
                        ? `${info ? String(info.name).split(',')[0] : ''} Fire · ${
                              res ? (useWhatIfStore.getState().demoStep === 0 ? 'Start' : `+${useWhatIfStore.getState().demoStep * 12} h`) : ''
                          }`
                        : 'Wildfire Scenario Forecast Tool'}
                </span>
                <button type="button" className="ww-an-back ww-an-back-icon" title="Center the map on the fire, beside this tool" onClick={() => focusFire()}>
                    <i className="mdi mdi-crosshairs-gps" />
                </button>
                <button
                    type="button"
                    className="ww-an-back ww-an-back-icon"
                    title={collapsed ? 'Show the tool' : 'Hide the tool to see the map'}
                    onClick={() => setToolCollapsed(!collapsed)}
                >
                    <i className={`mdi ${collapsed ? 'mdi-window-maximize' : 'mdi-window-minimize'}`} />
                </button>
            </div>
            {!collapsed && <FireHeader info={info} id={id} res={res} />}

            {error && <div className="ww-key-section ww-an-error">{error}</div>}
            {!res && busy && (
                <div className="ww-key-section">
                    <span className="ww-spinner" /> Loading the forecast…
                </div>
            )}

            {res && !collapsed && (
                <>
                    <ForecastSection res={res} runs={runs} idx={idx} step={step} playing={playing} />
                </>
            )}
            {res && !collapsed && (sidePanels.area || sidePanels.whatif) && (
                <SideColumn
                    anchor={pos && ref.current ? { left: pos.left, top: pos.top, width: ref.current.offsetWidth, maxHeight: pos.maxHeight, sideFits: pos.sideFits } : null}
                    res={res}
                    step={step}
                />
            )}
        </div>,
        document.body
    )
}

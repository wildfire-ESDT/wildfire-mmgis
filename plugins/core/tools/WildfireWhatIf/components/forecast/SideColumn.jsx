// The side column: Area conditions and/or What-if (stacked), docked to the Fire
// analysis window's side.
import React from 'react'
import { createPortal } from 'react-dom'
import useWhatIfStore from '../../store'
import { setSidePanel } from '../../demo'
import AreaConditions, { SpotSection } from './AreaConditions'
import WhatIfForm from './WhatIfForm'

const SIDE_W = 300 // the side column (Area conditions, What-if)
const PANEL_TITLES = { area: 'Area conditions', whatif: 'What-if' }

export default function SideColumn({ anchor, res, step }) {
    const PANEL_W = SIDE_W
    const GAP_PX = 0 // docked: the column joins the window's edge
    const panels = useWhatIfStore((s) => s.sidePanels)
    if (!anchor) return null
    const right = anchor.left + anchor.width + GAP_PX
    const onRight = anchor.sideFits !== false && right + PANEL_W <= window.innerWidth - 8
    const left = onRight ? right : anchor.left - PANEL_W - GAP_PX
    const panel = (kind, body) => (
        <div className={`ww-fire-layers ww-area-panel ${onRight ? 'from-left' : 'from-right'}`} key={kind}>
            <div className="ww-an-header">
                <span />
                <span className="ww-an-heading">{PANEL_TITLES[kind]}</span>
                <button type="button" className="ww-key-icon ww-area-close" title="Close" onClick={() => setSidePanel(kind, false)}>
                    <i className="mdi mdi-close" />
                </button>
            </div>
            {body}
        </div>
    )
    return createPortal(
        <div className={`ww-side-column ${onRight ? 'docked-right' : 'docked-left'}`} style={{ left, top: anchor.top, width: PANEL_W, maxHeight: anchor.maxHeight }}>
            {panels.area &&
                panel(
                    'area',
                    <>
                        <div className="ww-key-section">
                            <AreaConditions res={res} step={step} />
                        </div>
                        <SpotSection />
                    </>
                )}
            {panels.whatif &&
                panel(
                    'whatif',
                    <div className="ww-key-section ww-an-whatif">
                        <WhatIfForm />
                    </div>
                )}
        </div>,
        document.body
    )
}

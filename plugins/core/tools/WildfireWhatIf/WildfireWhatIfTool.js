import React from 'react'
import { createRoot } from 'react-dom/client'
import './WildfireWhatIfTool.css'
import L_ from '@basics/Layers_/Layers_'
import useWhatIfStore from './store'
import { seedFromVars } from './formConfig'
import {
    onToolOpen,
    onToolClose,
    selectFireFromMap,
    ignoreMapFire,
    isNewMapFire,
} from './actions'
import { restoreSession } from './auth'
import WhatIfPanel from './components/WhatIfPanel'

const DEFAULT_VELO_URL = 'https://firepanel.ai/veloserver'

const WildfireWhatIf = {
    height: 0,
    width: 380,
    _root: null,
    MMGISInterface: null,
    _wfigsLayerName: null,

    make: function () {
        const vars = L_.getToolVars('wildfire-whatif') || {}
        WildfireWhatIf._wfigsLayerName = vars.wfigsLayerName || 'b449da31-1ed1-473c-87d6-49f0c0ced8e5'
        useWhatIfStore.setState({
            vars,
            veloUrl: vars.veloUrl || DEFAULT_VELO_URL,
            kcUrl: vars.keycloakUrl || useWhatIfStore.getState().kcUrl,
            kcRealm: vars.keycloakRealm || useWhatIfStore.getState().kcRealm,
            kcClientId:
                vars.keycloakClientId || useWhatIfStore.getState().kcClientId,
            // Schema-declared fields seed their defaults from tool variables
            ...seedFromVars(vars),
        })
        WildfireWhatIf.MMGISInterface = new interfaceWithMMGIS()
        restoreSession() // rehydrates login and loads the user's run history
        onToolOpen() // redraw the scenario or run kept in the store from a previous open
        // MMGIS only notifies the open tool, so a fire selected on the map
        // while the tool was closed (or before its first open) is picked up
        // here and takes over from the kept scenario.
        const af = L_.activeFeature
        if (
            af &&
            af.feature &&
            af.layerName === WildfireWhatIf._wfigsLayerName &&
            isNewMapFire(af.feature)
        )
            selectFireFromMap(af.feature)
    },

    notify: function (type, payload) {
        if (type === 'setActiveFeature' && payload) {
            if (payload.layerName !== WildfireWhatIf._wfigsLayerName) return
            // Clicks made while drawing belong to the drawing, not a fire pick
            const s = useWhatIfStore.getState()
            if (s.drawing || s.drawingDozerLine) ignoreMapFire(payload.feature)
            else selectFireFromMap(payload.feature)
        }
    },

    destroy: function () {
        onToolClose()
        WildfireWhatIf._wfigsLayerName = null
        if (WildfireWhatIf.MMGISInterface)
            WildfireWhatIf.MMGISInterface.separateFromMMGIS()
        WildfireWhatIf.MMGISInterface = null
        if (WildfireWhatIf._root) {
            try {
                WildfireWhatIf._root.unmount()
            } catch (e) {}
            WildfireWhatIf._root = null
        }
    },
}

// The shared tool panel is a full-height frame whose height MMGIS keeps
// adjusting (bottom bar, top bar). Rather than fight that, this tool makes the
// frame invisible and click-through and draws its own box inside it, sized to
// its content and capped at the frame (scrolling beyond it); see #wildfireTool
// in the CSS. The frame's own look is put back on close.
const FRAME_STYLE = {
    background: 'transparent',
    borderColor: 'transparent',
    boxShadow: 'none',
    backdropFilter: 'none',
    webkitBackdropFilter: 'none',
    pointerEvents: 'none',
}

function hidePanelFrame(toolPanel) {
    const st = toolPanel.style
    const saved = {}
    Object.keys(FRAME_STYLE).forEach((k) => {
        saved[k] = st[k]
        st[k] = FRAME_STYLE[k]
    })
    return () => Object.assign(st, saved)
}

function interfaceWithMMGIS() {
    const toolPanel = document.getElementById('toolPanel')
    let restoreFrame = null
    if (toolPanel) {
        toolPanel.innerHTML = ''
        restoreFrame = hidePanelFrame(toolPanel)
        WildfireWhatIf._root = createRoot(toolPanel)
        WildfireWhatIf._root.render(<WhatIfPanel />)
    }
    this.separateFromMMGIS = function () {
        if (restoreFrame) restoreFrame()
        restoreFrame = null
    }
}

export default WildfireWhatIf

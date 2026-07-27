import React from 'react'
import { createRoot } from 'react-dom/client'
import './WildfireWhatIfTool.css'
import L_ from '@basics/Layers_/Layers_'
import useWhatIfStore from './store'
import { seedFromVars } from './formConfig'
import { loadHistory, restoreScenario, cancelMapDraw, setBboxFromMapFeature } from './actions'
import { clearScenarioLayers } from './map'
import WhatIfPanel from './components/WhatIfPanel'

const DEFAULT_VELO_URL = 'veloserver'

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
            // Schema-declared fields seed their defaults from tool variables
            ...seedFromVars(vars),
        })
        WildfireWhatIf.MMGISInterface = new interfaceWithMMGIS()
        loadHistory()
        restoreScenario() // redraw a perimeter kept in the store from a previous open
    },

    notify: function (type, payload) {
        if (type === 'setActiveFeature' && payload) {
            if (payload.layerName === WildfireWhatIf._wfigsLayerName) {
                setBboxFromMapFeature(payload.feature)
            }
        }
    },

    destroy: function () {
        cancelMapDraw()
        clearScenarioLayers()
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

function interfaceWithMMGIS() {
    const toolPanel = document.getElementById('toolPanel')
    if (toolPanel) {
        toolPanel.innerHTML = ''
        toolPanel.style.background = 'var(--color-k)'
        toolPanel.style.boxShadow = 'inset 2px 0px 10px 0px rgba(0,0,0,0.2)'
        WildfireWhatIf._root = createRoot(toolPanel)
        WildfireWhatIf._root.render(<WhatIfPanel />)
    }
    this.separateFromMMGIS = function () {}
}

export default WildfireWhatIf

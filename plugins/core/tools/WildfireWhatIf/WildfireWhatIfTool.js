import React from 'react'
import { createRoot } from 'react-dom/client'
import './WildfireWhatIfTool.css'
import L_ from '@basics/Layers_/Layers_'
import useWhatIfStore from './store'
import { seedFromVars } from './formConfig'
import { loadHistory, restoreScenario, cancelMapDraw } from './actions'
import { clearScenarioLayers } from './map'
import WhatIfPanel from './components/WhatIfPanel'

const DEFAULT_BACKEND_URL = 'http://localhost:8000'

const WildfireWhatIf = {
    height: 0,
    width: 380,
    _root: null,
    MMGISInterface: null,

    make: function () {
        const vars = L_.getToolVars('wildfire-whatif') || {}
        useWhatIfStore.setState({
            vars,
            backendUrl: vars.backendUrl || DEFAULT_BACKEND_URL,
            // Schema-declared fields seed their defaults from tool variables
            ...seedFromVars(vars),
        })
        WildfireWhatIf.MMGISInterface = new interfaceWithMMGIS()
        loadHistory()
        restoreScenario() // redraw a perimeter kept in the store from a previous open
    },

    destroy: function () {
        cancelMapDraw()
        clearScenarioLayers()
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

// The tool closing hides the open fire (and signing out does too); opening the tool
// again redraws it. Registered with the tool's actions.js.
import { setDemoHooks } from '../actions'
import { S, session } from './session'
import { pauseDemo } from './actions'
import { drawDemo, removeDemoLayers } from './render'
import { removeFlow } from './flow'
import { listenForClicks, stopListeningForClicks } from './probe'
import { takeTime, giveTimeBack, syncTime } from './time'

setDemoHooks({
    hide: () => {
        session.hidden = true
        pauseDemo()
        removeDemoLayers()
        removeFlow()
        stopListeningForClicks()
        giveTimeBack() // MMGIS's time is not left on the fire's while the tool is closed
    },
    redraw: () => {
        session.hidden = false
        const s = S.getState()
        if (!s.activeDemo) return false
        listenForClicks()
        drawDemo()
        if (s.syncMapTime) {
            takeTime()
            syncTime(true)
        }
        return true
    },
})

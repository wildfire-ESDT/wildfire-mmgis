import React, { useRef } from 'react'
import useWhatIfStore from '../../store'
import { STEPS, setDemoStep, stepDemo, playDemo, pauseDemo, fmtPass, RAMP_CSS } from '../../demo'

// The forecast's timeline: where the fire is in its six days (click or drag the bar, step, play)
export default function Timeline({ res, step, playing }) {
    const timeOf = (k) => (k === 0 ? res.start_time : res.steps[k - 1].time)
    const day = (k) => fmtPass(timeOf(k), res.grid).split(',')[0]
    const bar = useRef(null)
    const stepAt = (clientX) => {
        const r = bar.current.getBoundingClientRect()
        return Math.round(Math.min(Math.max((clientX - r.left) / r.width, 0), 1) * STEPS)
    }
    const onDown = (e) => {
        pauseDemo()
        setDemoStep(stepAt(e.clientX))
        const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            window.removeEventListener('pointercancel', up)
        }
        // only a new step redraws (every move would repaint the map); the window gone ends the drag
        const move = (ev) => {
            if (!bar.current) return up()
            const k = stepAt(ev.clientX)
            if (k !== useWhatIfStore.getState().demoStep) setDemoStep(k)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up) // a touch the browser takes over never sends pointerup
    }
    return (
        <div className="ww-tl">
            <div className="ww-tl-row">
                <button
                    type="button"
                    className={`ww-tl-play${playing ? ' playing' : ''}`}
                    title={playing ? 'Pause' : 'Play the six days'}
                    onClick={() => (playing ? pauseDemo() : playDemo())}
                >
                    <i className={`mdi ${playing ? 'mdi-pause' : 'mdi-play'}`} />
                </button>
                <button type="button" className="ww-tl-step" title="Previous 12 hours" disabled={step <= 0} onClick={() => stepDemo(-1)}>
                    <i className="mdi mdi-chevron-left" />
                </button>
                <div
                    className="ww-tl-bar"
                    ref={bar}
                    role="slider"
                    aria-valuemin={0}
                    aria-valuemax={STEPS}
                    aria-valuenow={step}
                    title={`${step === 0 ? 'Start' : `+${12 * step} h`} · ${fmtPass(timeOf(step), res.grid)}`}
                    onPointerDown={onDown}
                >
                    <div className="ww-tl-ramp dim" style={{ background: RAMP_CSS }} />
                    <div className="ww-tl-ramp" style={{ background: RAMP_CSS, clipPath: `inset(0 ${100 - (step / STEPS) * 100}% 0 0)` }} />
                    <span className="ww-tl-handle" style={{ left: `${(step / STEPS) * 100}%` }} />
                </div>
                <button type="button" className="ww-tl-step" title="Next 12 hours" disabled={step >= STEPS} onClick={() => stepDemo(1)}>
                    <i className="mdi mdi-chevron-right" />
                </button>
            </div>
            <div className="ww-tl-days">
                <span>{day(0)}</span>
                <span>{day(6)}</span>
                <span>{day(STEPS)}</span>
            </div>
        </div>
    )
}

// The Area conditions panel: the fire's own layers (model prediction, ground
// truth, wind vectors), the weather, terrain and fuel layers, and the spot readout.
import React, { useEffect, useRef, useState } from 'react'
import useWhatIfStore from '../../store'
import {
    setShowObserved,
    setTruthSource,
    truthOf,
    setShowBaseline,
    baselineOf,
    arrivalAt,
    fmtPass,
    activeResult,
    BASELINE_CSS,
    setWindFlow,
    setInputVisible,
    removeInput,
    setInputOpacity,
    setFireOpacity,
    setCompareTruth,
    setShowForecast,
    clearProbe,
    moveInput,
    layerCacheKey,
    START_CSS,
    OBSERVED_CSS,
    RAMP_CSS,
} from '../../demo'
import { dirLabel, msToMph } from '../../utils'
import AddLayerPicker from './AddLayerPicker'
import { ColorKey, EyeButton, OverlayRow, OpacityRow, Drawer } from './widgets'

function MapLayerCard({ layer, step }) {
    const visible = useWhatIfStore((s) => s.visibleInputs.includes(layer.key))
    const loading = useWhatIfStore((s) => s.inputLoading === layer.key)
    const range = useWhatIfStore((s) => s.inputRanges[layerCacheKey(layer.key)])
    const opacity = useWhatIfStore((s) => (s.inputOpacities[layer.key] == null ? 0.75 : s.inputOpacities[layer.key]))
    const when = layer.time ? (step <= 1 ? 'start to +12 h' : `+${12 * (step - 1)} to +${12 * step} h`) : 'same for the whole run'
    return (
        <div className={`ww-key-layer${visible ? '' : ' hidden'}`}>
            <div className="ww-key-row">
                <span className="ww-key-name">{layer.label}</span>
                {loading && <span className="ww-spinner" />}
                <EyeButton visible={visible} onToggle={() => setInputVisible(layer.key, !visible)} label={layer.label} />
                <button type="button" className="ww-key-icon" title={`Remove ${layer.label}`} onClick={() => removeInput(layer.key)}>
                    <i className="mdi mdi-close" />
                </button>
            </div>
            <div className="ww-key-detail">
                {layer.group} · {when}
            </div>
            {visible && (
                <>
                    <ColorKey layer={layer} range={range} />
                    <OpacityRow value={opacity} onChange={(v) => setInputOpacity(layer.key, v)} />
                </>
            )}
        </div>
    )
}

// When a run's fire reaches the spot, in words: {text, step} (step: 0 at the start, 99 never)
function arrivalText(res, probe) {
    const a = arrivalAt(res, probe.lat, probe.lon)
    if (a == null) return null
    if (a === 255) return { step: 0, text: 'Burning at the forecast start' }
    if (a === 0) return { step: 99, text: 'Not within the six days' }
    const st = res.steps[a - 1]
    return { step: a, text: `+${12 * (a - 1)} to +${12 * a} h${st ? ` · by ${fmtPass(st.time, res.grid)}` : ''}` }
}

// When the fire reaches the clicked spot in the run on screen and, for a what-if, in the model forecast
function SpotArrival({ probe }) {
    useWhatIfStore((s) => s.demoIdx) // another run picked: read again
    useWhatIfStore((s) => s.demoResults)
    const res = activeResult()
    const base = baselineOf()
    const now = res && arrivalText(res, probe)
    if (!now) return null
    const was = base && arrivalText(base, probe)
    let shift = null
    if (was && was.step !== now.step) {
        if (now.step === 99) shift = 'The what-if keeps the fire from this spot'
        else if (was.step === 99) shift = 'Only the what-if reaches this spot'
        else shift = `${12 * Math.abs(now.step - was.step)} h ${now.step < was.step ? 'earlier' : 'later'} than the model forecast`
    }
    return (
        <>
            <div className="ww-spot-group">Fire arrival</div>
            <div className="ww-spot-row">
                <span>{was ? 'What-if' : 'Forecast'}</span>
                <span>{now.text}</span>
            </div>
            {was && (
                <div className="ww-spot-row">
                    <span>Model forecast</span>
                    <span>{was.text}</span>
                </div>
            )}
            {shift && <div className="ww-spot-hint">{shift}</div>}
        </>
    )
}

// Every input at the spot clicked on the map, at the shown step
export function SpotSection() {
    const probe = useWhatIfStore((s) => s.probe)
    const data = useWhatIfStore((s) => s.probeData)
    const loading = useWhatIfStore((s) => s.probeLoading)
    const error = useWhatIfStore((s) => s.probeError)
    const box = useRef(null)
    useEffect(() => {
        // a new spot: bring its readout into view in the window
        if (probe && box.current) box.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, [probe, !!data])
    if (!probe) return null
    let group = null
    return (
        <Drawer
            id="spot"
            innerRef={box}
            icon="mdi-map-marker-outline"
            title="At this spot"
            summary={data ? `+${12 * (data.step - 1)} to +${12 * data.step} h` : null}
            actions={
                <>
                    {loading && <span className="ww-spinner" />}
                    <button type="button" className="ww-key-icon" title="Clear the spot" onClick={() => clearProbe()}>
                        <i className="mdi mdi-close" />
                    </button>
                </>
            }
        >
            <SpotArrival probe={probe} />
            {error && <div className="ww-key-detail">{error}</div>}
            {data &&
                data.rows.map((r) => {
                    const head = r.group !== group
                    group = r.group
                    return (
                        <React.Fragment key={r.label}>
                            {head && <div className="ww-spot-group">{r.group}</div>}
                            <div className="ww-spot-row">
                                <span>{r.label}</span>
                                <span>{r.value}</span>
                            </div>
                        </React.Fragment>
                    )
                })}
        </Drawer>
    )
}

// The wind as moving vectors over the fire (the shown run's wind at the shown step), labelled with
// its speed and the way it flows
function WindFlowRow({ windNow }) {
    const on = useWhatIfStore((s) => s.windFlow)
    const loading = useWhatIfStore((s) => s.windFlow && s.flowLoading)
    return (
        <OverlayRow
            swatch={<i className="mdi mdi-weather-windy ww-key-arrow" />}
            label={`Wind vectors${windNow ? ` · ${windNow}` : ''}`}
            visible={on}
            onToggle={() => setWindFlow(!on)}
            loading={loading}
        />
    )
}

// The added layers, top of the list drawn on top; each moves by dragging its handle
function LayerList({ layers, step }) {
    const [from, setFrom] = useState(null)
    const [over, setOver] = useState(null)
    const end = () => {
        setFrom(null)
        setOver(null)
    }
    return (
        <div className="ww-an-layers">
            {layers.map((layer, i) => (
                <div
                    key={layer.key}
                    className={`ww-drag-row${from === i ? ' dragging' : ''}${over === i && from !== null && from !== i ? (from > i ? ' over-above' : ' over-below') : ''}`}
                    onDragOver={(e) => {
                        if (from === null) return
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        if (over !== i) setOver(i)
                    }}
                    onDrop={(e) => {
                        e.preventDefault()
                        if (from !== null && from !== i) moveInput(from, i)
                        end()
                    }}
                >
                    <span
                        className="ww-drag-handle"
                        draggable
                        title="Drag to change which layer is on top"
                        onDragStart={(e) => {
                            setFrom(i)
                            e.dataTransfer.effectAllowed = 'move'
                            e.dataTransfer.setData('text/plain', layer.key)
                        }}
                        onDragEnd={end}
                    >
                        <i className="mdi mdi-drag-vertical" />
                    </span>
                    <div className="ww-drag-body">
                        <MapLayerCard layer={layer} step={step} />
                    </div>
                </div>
            ))}
        </div>
    )
}

// What the Area conditions panel lists: the fire's own layers, then the weather, terrain and fuel ones
export default function AreaConditions({ res, step }) {
    const showForecast = useWhatIfStore((s) => s.showForecast)
    const showObserved = useWhatIfStore((s) => s.showObserved)
    const catalog = useWhatIfStore((s) => (s.activeDemo && s.inputCatalogs[s.activeDemo]) || [])
    const added = useWhatIfStore((s) => s.addedInputKeys)
    const addedLayers = added.map((key) => catalog.find((layer) => layer.key === key)).filter(Boolean)
    const fireOpacity = useWhatIfStore((s) => s.fireOpacity)
    const compare = useWhatIfStore((s) => s.compareTruth)
    const truths = res.truths || []
    const whatif = res.kind === 'whatif' // the ground truth stays as an outline; no acres comparison with a what-if
    const showBaseline = useWhatIfStore((s) => s.showBaseline)
    const hasBaseline = useWhatIfStore((s) => !!baselineOf(s))
    const chosen = truthOf(res, useWhatIfStore((s) => s.truthSource))
    const w = res.steps[Math.max(step, 1) - 1]
    const windNow =
        w && w.wind_speed_ms != null
            ? `${msToMph(w.wind_speed_ms)} mph${w.wind_from_deg != null ? ` toward ${dirLabel((w.wind_from_deg + 180) % 360)}` : ''}`
            : null
    return (
        <>
                <OverlayRow
                    swatch={<i className="ww-key-swatch" style={{ background: RAMP_CSS }} />}
                    label="Model prediction"
                    visible={showForecast}
                    onToggle={() => setShowForecast(!showForecast)}
                />
                {showForecast && (
                    <div className="ww-key-forecast">
                        <div className="ww-key-legend-items">
                            <span>
                                <i className="ww-key-swatch" style={{ background: START_CSS }} /> Fire at the start
                            </span>
                            <span>
                                <i className="ww-key-swatch" style={{ background: RAMP_CSS }} /> Burned by step
                            </span>
                        </div>
                        <OpacityRow value={fireOpacity} onChange={setFireOpacity} />
                    </div>
                )}
                {hasBaseline && (
                    <OverlayRow
                        swatch={<i className="ww-key-swatch edge" style={{ borderColor: BASELINE_CSS }} />}
                        label="Model forecast (for comparison)"
                        visible={showBaseline}
                        onToggle={() => setShowBaseline(!showBaseline)}
                    />
                )}
                <OverlayRow
                    swatch={<i className="ww-key-swatch edge" style={{ borderColor: OBSERVED_CSS }} />}
                    label="Ground truth"
                    visible={showObserved}
                    onToggle={() => setShowObserved(!showObserved)}
                />
                {truths.length > 1 && (
                    <div className="ww-key-truth" role="radiogroup" aria-label="Ground truth source">
                        {truths.map((t) => (
                            <button
                                key={t.key}
                                type="button"
                                role="radio"
                                aria-checked={chosen.key === t.key}
                                className={chosen.key === t.key ? 'on' : ''}
                                title={t.label}
                                onClick={() => setTruthSource(t.key)}
                            >
                                {t.key === 'agency' ? 'WFIGS perimeter' : 'FEDS (VIIRS)'}
                            </button>
                        ))}
                    </div>
                )}
                {!whatif && (
                    <label className="ww-key-row ww-an-compare" title="Shows how far the forecast's acres are from the ground truth's">
                        <input type="checkbox" checked={compare} onChange={(e) => setCompareTruth(e.target.checked)} />
                        <span className="ww-key-name">Compare forecast with ground truth</span>
                    </label>
                )}
                <WindFlowRow windNow={windNow} />
                <div className="ww-an-subhead">Weather, terrain and fuel</div>
                <div className="ww-an-add">
                    <AddLayerPicker />
                </div>
                {addedLayers.length > 0 && <LayerList layers={addedLayers} step={step} />}
                <div className="ww-key-detail ww-spot-hint">
                    {addedLayers.length > 1 ? 'Drag a layer by its handle to put it on top. ' : ''}They draw under the model
                    prediction. Click the map inside the fire's box to read every condition there.
                </div>
        </>
    )
}

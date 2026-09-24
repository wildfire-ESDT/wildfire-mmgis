import React, { useRef } from 'react'
import useWhatIfStore from '../store'
import { startMapDraw, cancelMapDraw, clearPerimeter, uploadPerimeter } from '../actions'
import { ringAcres, fmtAcres } from '../utils'
import { Button, IconButton } from '@design/components'
import SectionLabel from './SectionLabel'

const SOURCE_LABELS = {
    selected: 'Selected on map',
    uploaded: 'Uploaded',
    run: 'From a previous run',
    drawn: 'Drawn',
}

function defaultTitle(source) {
    if (source === 'uploaded') return 'Uploaded perimeter'
    if (source === 'drawn') return 'Drawn perimeter'
    return 'Fire perimeter'
}

export default function PerimeterSection() {
    const drawing = useWhatIfStore((s) => s.drawing)
    const perimeterRing = useWhatIfStore((s) => s.perimeterRing)
    const perimeterSource = useWhatIfStore((s) => s.perimeterSource)
    const perimeterName = useWhatIfStore((s) => s.perimeterName)
    const fileRef = useRef(null)

    return (
        <>
            <SectionLabel>Fire perimeter</SectionLabel>
            {perimeterRing ? (
                <div className="ww-card">
                    <div className="ww-card-head">
                        <span className="ww-card-title">
                            {perimeterName || defaultTitle(perimeterSource)}
                        </span>
                        <IconButton
                            size="sm"
                            onClick={() => clearPerimeter()}
                            title="Clear perimeter"
                        >
                            <i className="mdi mdi-close mdi-16px" />
                        </IconButton>
                    </div>
                    <div className="ww-card-line">
                        {fmtAcres(ringAcres(perimeterRing))} ·{' '}
                        {SOURCE_LABELS[perimeterSource] || 'Drawn'}
                    </div>
                </div>
            ) : (
                <div className="ww-card ww-start">
                    <i className="mdi mdi-cursor-default-click-outline mdi-24px" />
                    <div>
                        <div className="ww-card-title">Select a fire on the map</div>
                        <div className="ww-card-line">
                            or draw or upload a perimeter
                        </div>
                    </div>
                </div>
            )}
            <div className="ww-row">
                <Button
                    className={`ww-grow${drawing ? ' ww-btn-active' : ''}`}
                    onClick={() => (drawing ? cancelMapDraw() : startMapDraw())}
                    title="Draw the fire perimeter on the map"
                >
                    <i className="mdi mdi-pencil mdi-14px ww-btn-icon" />
                    {drawing ? 'Cancel Draw' : 'Draw Perimeter'}
                </Button>
                <Button
                    className="ww-grow"
                    onClick={() => fileRef.current && fileRef.current.click()}
                    title="Upload a GeoJSON perimeter"
                >
                    <i className="mdi mdi-upload mdi-14px ww-btn-icon" />
                    Upload GeoJSON
                </Button>
                <input
                    ref={fileRef}
                    type="file"
                    accept=".geojson,application/geo+json,application/json"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                        const file = e.target.files && e.target.files[0]
                        if (file) uploadPerimeter(file)
                        e.target.value = ''
                    }}
                />
            </div>
            {drawing && (
                <div className="ww-draw-hint">
                    Click to add points · double-click to finish · Esc to
                    cancel
                </div>
            )}
        </>
    )
}

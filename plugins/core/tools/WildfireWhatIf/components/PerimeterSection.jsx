import React, { useRef } from 'react'
import useWhatIfStore, { BBOX_BUFFER_KM } from '../store'
import { startMapDraw, cancelMapDraw, clearPerimeter, uploadPerimeter } from '../actions'
import { Button, IconButton } from '@design/components'

function BboxStatus({ bounds }) {
    const [[latMin, lonMin], [latMax, lonMax]] = bounds
    const midLat = (latMin + latMax) / 2
    const heightKm = Math.round((latMax - latMin) * 111.32)
    const widthKm = Math.round(
        (lonMax - lonMin) * 111.32 * Math.cos((midLat * Math.PI) / 180)
    )
    return (
        <div className="ww-status ww-status-bbox">
            Wind region: {widthKm} × {heightKm} km (perimeter +{' '}
            {BBOX_BUFFER_KM} km)
        </div>
    )
}

// Handles only exist on editable perimeters small enough for map.js to spawn
// them (MAX_EDIT_VERTICES); map-selected fire perimeters are never editable.
function perimeterStatus(source, ring) {
    const editable = source !== 'selected' && ring.length - 1 <= 60
    const adjust = editable ? '. Drag the map handles to adjust it' : ''
    if (source === 'selected') return 'Fire perimeter selected from the map'
    if (source === 'uploaded') return 'Perimeter uploaded' + adjust
    if (source === 'run') return 'Perimeter loaded from the selected run'
    return 'Perimeter drawn' + adjust
}

export default function PerimeterSection() {
    const drawing = useWhatIfStore((s) => s.drawing)
    const perimeterRing = useWhatIfStore((s) => s.perimeterRing)
    const perimeterSource = useWhatIfStore((s) => s.perimeterSource)
    const bboxBounds = useWhatIfStore((s) => s.bboxBounds)
    const fileRef = useRef(null)

    return (
        <>
            <div className="ww-section-label">Fire Perimeter</div>
            <div className="ww-row">
                <Button
                    className={`ww-grow${drawing ? ' ww-btn-active' : ''}`}
                    onClick={() => (drawing ? cancelMapDraw() : startMapDraw())}
                    title="Draw the fire perimeter on the map"
                >
                    <i className="mdi mdi-vector-polygon mdi-14px" />
                    {drawing ? 'Cancel Draw' : 'Draw Perimeter'}
                </Button>
                <Button
                    className="ww-grow"
                    onClick={() => fileRef.current && fileRef.current.click()}
                    title="Upload a GeoJSON perimeter"
                >
                    <i className="mdi mdi-upload mdi-14px" />
                    Upload
                </Button>
                <IconButton
                    size="sm"
                    onClick={() => clearPerimeter()}
                    title="Clear perimeter"
                >
                    <i className="mdi mdi-close mdi-16px" />
                </IconButton>
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
                    Click to add vertices · double-click or Enter to close ·
                    Backspace undoes · Esc cancels
                </div>
            )}
            {perimeterRing ? (
                <div className="ww-status ww-status-ok">
                    {perimeterStatus(perimeterSource, perimeterRing)}
                </div>
            ) : (
                <div className="ww-status ww-status-none">
                    No fire perimeter yet. Draw one, upload a GeoJSON, or
                    click a fire on the map.
                </div>
            )}
            {bboxBounds && <BboxStatus bounds={bboxBounds} />}
        </>
    )
}

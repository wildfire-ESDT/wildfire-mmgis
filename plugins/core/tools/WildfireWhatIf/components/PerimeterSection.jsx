import React, { useRef } from 'react'
import useWhatIfStore, { BBOX_BUFFER_KM } from '../store'
import { startMapDraw, cancelMapDraw, clearPerimeter, uploadPerimeter } from '../actions'
import { Button, IconButton } from '@design/components'
import FirePickerSection from './FirePickerSection'

function BboxStatus({ bounds }) {
    const [[latMin, lonMin], [latMax, lonMax]] = bounds
    const midLat = (latMin + latMax) / 2
    const heightKm = Math.round((latMax - latMin) * 111.32)
    const widthKm = Math.round(
        (lonMax - lonMin) * 111.32 * Math.cos((midLat * Math.PI) / 180)
    )
    return (
        <div className="ww-status ww-status-bbox">
            HRRR region: {widthKm} × {heightKm} km
        </div>
    )
}

export default function PerimeterSection() {
    const drawing = useWhatIfStore((s) => s.drawing)
    const perimeterRing = useWhatIfStore((s) => s.perimeterRing)
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
                    Perimeter set · {perimeterRing.length - 1} vertices · drag
                    handles to adjust, right-click one to remove
                </div>
            ) : (
                <div className="ww-status ww-status-none">
                    No perimeter drawn
                </div>
            )}
            {bboxBounds && <BboxStatus bounds={bboxBounds} />}
            <FirePickerSection />
        </>
    )
}

import React from 'react'
import useWhatIfStore from '../store'
import {
    startDozerLineDraw,
    cancelDozerLineDraw,
    removeDozerLine,
    clearDozerLines,
} from '../actions'
import { Button, IconButton } from '@design/components'
import SectionLabel from './SectionLabel'

export default function DozerLinesSection() {
    const drawingDozerLine = useWhatIfStore((s) => s.drawingDozerLine)
    const dozerLines = useWhatIfStore((s) => s.dozerLines)
    const perimeterRing = useWhatIfStore((s) => s.perimeterRing)

    if (!perimeterRing) return null

    return (
        <>
            <SectionLabel optional>
                Dozer lines
            </SectionLabel>
            {dozerLines.length > 0 && (
                <div className="ww-card ww-list">
                    {dozerLines.map((l, i) => (
                        <div className="ww-list-row" key={l.id}>
                            <span className="ww-dozer-swatch" />
                            <span className="ww-list-label">Line {i + 1}</span>
                            <IconButton
                                size="sm"
                                onClick={() => removeDozerLine(l.id)}
                                title="Remove this dozer line"
                            >
                                <i className="mdi mdi-delete mdi-14px" />
                            </IconButton>
                        </div>
                    ))}
                </div>
            )}
            <div className="ww-row">
                <Button
                    className={`ww-grow${drawingDozerLine ? ' ww-btn-active' : ''}`}
                    onClick={() =>
                        drawingDozerLine
                            ? cancelDozerLineDraw()
                            : startDozerLineDraw()
                    }
                    title="Draw a dozer line: click and drag on the map"
                >
                    <i className="mdi mdi-vector-polyline mdi-14px ww-btn-icon" />
                    {drawingDozerLine ? 'Cancel Draw' : 'Draw Dozer Line'}
                </Button>
                {dozerLines.length > 1 && (
                    <Button onClick={() => clearDozerLines()} title="Remove all dozer lines">
                        Clear all
                    </Button>
                )}
            </div>
            {drawingDozerLine && (
                <div className="ww-draw-hint">
                    Drag on the map to draw · Esc to cancel
                </div>
            )}
        </>
    )
}

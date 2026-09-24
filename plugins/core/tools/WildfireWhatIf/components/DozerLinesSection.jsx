import React from 'react'
import useWhatIfStore from '../store'
import {
    startDozerLineDraw,
    cancelDozerLineDraw,
    removeDozerLine,
    clearDozerLines,
} from '../actions'
import { Button, IconButton } from '@design/components'

export default function DozerLinesSection() {
    const drawingDozerLine = useWhatIfStore((s) => s.drawingDozerLine)
    const dozerLines = useWhatIfStore((s) => s.dozerLines)
    const perimeterRing = useWhatIfStore((s) => s.perimeterRing)

    if (!perimeterRing) return null

    return (
        <>
            <div className="ww-section-label">Dozer Lines</div>
            <div className="ww-row">
                <Button
                    className={`ww-grow${drawingDozerLine ? ' ww-btn-active' : ''}`}
                    onClick={() =>
                        drawingDozerLine
                            ? cancelDozerLineDraw()
                            : startDozerLineDraw()
                    }
                    title="Draw a dozer line — fuel cleared, the spread model won't cross it"
                >
                    <i className="mdi mdi-vector-polyline mdi-14px" />
                    {drawingDozerLine ? 'Cancel Draw' : 'Draw Dozer Line'}
                </Button>
                {dozerLines.length > 0 && (
                    <IconButton
                        size="sm"
                        onClick={() => clearDozerLines()}
                        title="Clear all dozer lines"
                    >
                        <i className="mdi mdi-close mdi-16px" />
                    </IconButton>
                )}
            </div>
            {drawingDozerLine && (
                <div className="ww-draw-hint">
                    Click and drag to paint the line · release to finish · Esc
                    cancels
                </div>
            )}
            {dozerLines.length > 0 ? (
                <div className="ww-status ww-status-ok">
                    {dozerLines.length} dozer line
                    {dozerLines.length > 1 ? 's' : ''} drawn
                    {dozerLines.map((l, i) => (
                        <div className="ww-row" key={l.id}>
                            <span>Line {i + 1}</span>
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
            ) : (
                <div className="ww-status ww-status-none">
                    No dozer lines yet — optional; marks fuel cleared along a
                    line the spread model should not cross.
                </div>
            )}
        </>
    )
}

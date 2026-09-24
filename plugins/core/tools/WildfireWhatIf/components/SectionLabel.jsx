import React from 'react'

// Section heading for the Setup view, with an optional "optional" tag.
export default function SectionLabel({ children, optional }) {
    return (
        <div className="ww-section-label ww-section-head">
            <span className="ww-section-title">{children}</span>
            {optional && <span className="ww-section-opt">optional</span>}
        </div>
    )
}

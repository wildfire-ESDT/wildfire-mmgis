import React from 'react'
import useWhatIfStore from '../store'
import FORM_SECTIONS from '../formConfig'
import { RadioGroup } from '@design/components'

function clampNumber(f, raw) {
    let v = parseInt(raw, 10)
    if (isNaN(v)) v = f.min != null ? f.min : 0
    if (f.min != null) v = Math.max(f.min, v)
    if (f.max != null) v = Math.min(f.max, v)
    return v
}

function FieldInput({ f }) {
    const value = useWhatIfStore((s) => s[f.key])
    const error = useWhatIfStore((s) => (f.errorKey ? s[f.errorKey] : false))
    const set = (v) =>
        useWhatIfStore.setState({
            [f.key]: v,
            ...(f.errorKey ? { [f.errorKey]: false } : {}),
        })

    if (f.type === 'select')
        return (
            <RadioGroup
                value={value}
                onValueChange={set}
                options={f.options}
            />
        )
    if (f.type === 'number')
        return (
            <div className="ww-field-input-row">
                <input
                    type="number"
                    min={f.min}
                    max={f.max}
                    value={value}
                    onChange={(e) => set(clampNumber(f, e.target.value))}
                />
                {f.suffix && (
                    <span className="ww-field-suffix">{f.suffix}</span>
                )}
            </div>
        )
    if (f.type === 'date')
        return (
            <input
                type="date"
                value={value}
                onChange={(e) => set(e.target.value)}
            />
        )
    return (
        <input
            type="text"
            className={error ? 'ww-input-error' : ''}
            placeholder={f.placeholder || ''}
            value={value}
            onChange={(e) => set(e.target.value)}
        />
    )
}

// Renders schema sections from formConfig. `sections` filters by title so
// callers can place each section where it belongs in the panel layout.
export default function SchemaForm({ sections }) {
    return FORM_SECTIONS.filter(
        (s) => !sections || sections.includes(s.title)
    ).map((section) => (
        <React.Fragment key={section.title}>
            <div className="ww-section-label">{section.title}</div>
            <div className="ww-field-grid">
                {section.fields.map((f) => (
                    <div
                        className={`ww-field${f.half ? ' half' : ''}`}
                        key={f.key}
                    >
                        {f.label && (
                            <div className="ww-field-label">
                                <label>{f.label}</label>
                            </div>
                        )}
                        <FieldInput f={f} />
                        {f.description && (
                            <div className="ww-field-description">
                                {f.description}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </React.Fragment>
    ))
}

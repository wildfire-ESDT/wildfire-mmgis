// Small pieces the Fire analysis window and its panels share: an eye toggle, a
// layer row, an opacity slider, a layer's color key, and a drawer.
import React from 'react'
import useWhatIfStore from '../../store'
import { rampCss, toggleDrawer } from '../../demo'
import { Slider } from '@design/components'
import { withUnits } from './format'

export function ColorKey({ layer, range }) {
    if (layer.cats)
        return (
            <div className="ww-key-categories">
                {layer.cats.map((category, index) => (
                    <span key={category}>
                        <i className="ww-key-swatch" style={{ background: layer.colors[index] }} />
                        {category}
                    </span>
                ))}
            </div>
        )
    const shown = range || layer
    return (
        <>
            <div className="ww-key-ramp" style={{ background: rampCss(layer.ramp) }} />
            <div className="ww-key-ramp-labels">
                <span>{withUnits(shown.min, layer)}</span>
                <span>{withUnits(shown.max, layer)}</span>
            </div>
        </>
    )
}

export function EyeButton({ visible, onToggle, label }) {
    return (
        <button type="button" className="ww-key-icon" title={visible ? `Hide ${label}` : `Show ${label}`} onClick={onToggle}>
            <i className={`mdi ${visible ? 'mdi-eye' : 'mdi-eye-off'}`} />
        </button>
    )
}

export function OverlayRow({ swatch, label, visible, onToggle, loading }) {
    return (
        <div className={`ww-key-row${visible ? '' : ' hidden'}`}>
            {swatch}
            <span className="ww-key-name">{label}</span>
            {loading && <span className="ww-spinner" />}
            <EyeButton visible={visible} onToggle={onToggle} label={label} />
        </div>
    )
}

export function OpacityRow({ value, onChange }) {
    return (
        <div className="ww-key-opacity">
            <span>Opacity</span>
            <Slider min={0.1} max={1} step={0.05} value={Number(value)} onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)} />
            <span>{Math.round(value * 100)}%</span>
        </div>
    )
}

// A part of the window that opens and closes from its heading (closed ones are
// remembered for the session)
export function Drawer({ id, icon, title, summary, actions, innerRef, children }) {
    const closed = useWhatIfStore((s) => !!s.drawersClosed[id])
    return (
        <div className={`ww-drawer${closed ? ' closed' : ' open'}`} ref={innerRef}>
            <div className="ww-drawer-head">
                <button
                    type="button"
                    className="ww-drawer-toggle"
                    aria-expanded={!closed}
                    title={closed ? `Open ${title}` : `Close ${title}`}
                    onClick={() => toggleDrawer(id)}
                >
                    {icon && <i className={`mdi ${icon} ww-drawer-icon`} />}
                    <span className="ww-drawer-title">{title}</span>
                    {summary && <span className="ww-drawer-summary">{summary}</span>}
                </button>
                {actions}
            </div>
            {!closed && <div className="ww-drawer-body">{children}</div>}
        </div>
    )
}

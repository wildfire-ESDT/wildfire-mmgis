// The demo's colors: the forecast's burn ramp (one color per 12-hour step), the
// start fire, the ground truth's edge, and the color scales of the input layers.
import { STEPS } from './session'

const START_RGBA = [96, 103, 112, 220] // the fire at the forecast start
const OBSERVED_RGBA = [34, 211, 238, 255] // the ground truth's edge at the current step
// Light to dark through the fire colors: early burn pale, late burn dark
const RAMP = ['#fde68a', '#fbbf24', '#f97316', '#dc2626', '#991b1b', '#581c87']

const BASELINE_RGBA = [255, 255, 255, 255] // the model forecast's edge, drawn under a what-if

export { START_RGBA, OBSERVED_RGBA, BASELINE_RGBA }

export function hexRgb(h) {
    const n = parseInt(h.slice(1), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// The color of step k (1..12), interpolated along RAMP
export function stepColor(k) {
    const t = (Math.min(Math.max(k, 1), STEPS) - 1) / (STEPS - 1)
    const x = t * (RAMP.length - 1)
    const i = Math.min(Math.floor(x), RAMP.length - 2)
    const f = x - i
    const a = hexRgb(RAMP[i])
    const b = hexRgb(RAMP[i + 1])
    return a.map((v, j) => Math.round(v + f * (b[j] - v)))
}

export function stepCss(k) {
    return `rgb(${stepColor(k).join(',')})`
}

export const START_CSS = `rgba(${START_RGBA.slice(0, 3).join(',')},${START_RGBA[3] / 255})`
export const OBSERVED_CSS = `rgb(${OBSERVED_RGBA.slice(0, 3).join(',')})`
export const BASELINE_CSS = `rgb(${BASELINE_RGBA.slice(0, 3).join(',')})`
export const RAMP_CSS = `linear-gradient(to right, ${RAMP.join(', ')})`

// Color scales by name (the server's layer list says which one a layer uses)
export const RAMPS = {
    wind: ['#f7fbff', '#9ecae1', '#4292c6', '#2c3e9e', '#3f007d'],
    temp: ['#313695', '#74add1', '#ffffbf', '#f46d43', '#a50026'],
    humidity: ['#8c510a', '#d8b365', '#f6e8c3', '#5ab4ac', '#01665e'],
    rain: ['#f7fbff', '#9ecae1', '#4292c6', '#08306b'],
    terrain: ['#1a9850', '#a6d96a', '#fee08b', '#c49a6c', '#f5f5f5'],
    slope: ['#ffffcc', '#fd8d3c', '#bd0026', '#4a0010'],
    canopy: ['#f7fcb9', '#addd8e', '#41ab5d', '#005a32'],
    health: ['#a50026', '#f46d43', '#fee08b', '#66bd63', '#006837'],
    moisture: ['#8c510a', '#d8b365', '#f5f5f5', '#5ab4ac', '#01665e'],
    danger: ['#ffffb2', '#fecc5c', '#fd8d3c', '#e31a1c', '#800026'],
}

export function rampColor(name, t) {
    const stops = (RAMPS[name] || RAMPS.danger).map(hexRgb)
    const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1)
    const i = Math.min(Math.floor(x), stops.length - 2)
    const f = x - i
    return stops[i].map((v, j) => Math.round(v + f * (stops[i + 1][j] - v)))
}

export function rampCss(name) {
    return `linear-gradient(to right, ${(RAMPS[name] || RAMPS.danger).join(', ')})`
}

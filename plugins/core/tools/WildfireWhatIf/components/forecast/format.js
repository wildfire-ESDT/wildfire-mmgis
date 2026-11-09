// Text for the Fire analysis window: acres, compass names, layer values, local times.

export function fmtAc(a) {
    if (a == null) return '—'
    return `${Math.round(a).toLocaleString()} ac`
}

const DIR_NAMES = ['north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast', 'southeast', 'south-southeast',
    'south', 'south-southwest', 'southwest', 'west-southwest', 'west', 'west-northwest', 'northwest', 'north-northwest']
export function dirName(deg) {
    return DIR_NAMES[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]
}

export function formatNumber(value) {
    if (value == null) return ''
    const size = Math.abs(value)
    if (size < 0.005) return '0'
    if (size >= 100) return Math.round(value).toLocaleString()
    return size >= 10 ? value.toFixed(0) : size >= 1 ? value.toFixed(1) : value.toFixed(2)
}

export function withUnits(value, layer) {
    if (!layer.units) return formatNumber(value)
    const attached = ['°', '%', '°C'].includes(layer.units)
    return `${formatNumber(value)}${attached ? '' : ' '}${layer.units}`
}

// "Jan 7, 2025, about 10:30 AM local" (the fire's solar time, to the half hour)
export function localWhen(iso, lon) {
    if (!iso) return null
    const d = new Date(String(iso).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(iso)) ? '' : 'Z'))
    if (isNaN(d.getTime())) return null
    const t = new Date(Math.round((d.getTime() + (lon / 15) * 3600e3) / 1800e3) * 1800e3)
    const day = t.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    const hour = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
    return `${day}, about ${hour} local`
}

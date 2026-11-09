// Requests to the wildfire model server (adjacent-servers/wildfire-model), through
// MMGIS's adjacent-server proxy unless the tool's Model Server URL is absolute.
import { S } from './session'

function modelBase() {
    const url = S.getState().modelUrl || 'wildfire-model'
    if (/^https?:\/\//.test(url)) return url.replace(/\/$/, '')
    const root = (window.mmgisglobal && window.mmgisglobal.ROOT_PATH) || ''
    return (root ? root + '/' : '') + url.replace(/^\/|\/$/g, '')
}

export function modelFetch(path, init = {}) {
    return fetch(`${modelBase()}/${path.replace(/^\//, '')}`, {
        credentials: 'same-origin',
        ...init,
        headers: { Accept: 'application/json', ...(init.headers || {}) },
    }).then((r) =>
        r
            .json()
            .catch(() => {
                throw new Error(`the model server sent an unreadable answer (HTTP ${r.status})`)
            })
            .then((body) => {
                if (!r.ok) throw new Error(body.error || `model server HTTP ${r.status}`)
                return body
            })
    )
}

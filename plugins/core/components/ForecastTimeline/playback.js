/**
 * Experimental playback and prefetch. Off unless the mission sets the
 * experimentalPlayback component variable, and only COG fxx cards get the
 * button. A play press prefetches the run first (velocity caches full frames
 * in memory, COG warms the visible tiles), then loops the steps on a timer.
 */

import L_ from '@basics/Layers_/Layers_'

import {
    PLAY_INTERVAL_MS,
    isCogFxx,
    isFxxVelocity,
    setFxx,
    resolveUrlTokens,
    escSel,
    pooled,
} from './common'

const playbackMethods = {
    _frameCache: {},
    _playTimers: {},

    // Off unless the mission opts in via variables.experimentalPlayback.
    _playbackEnabled: function () {
        return this.vars?.experimentalPlayback === true
    },

    // Further limited to HRRR COG raster cards for now.
    _playbackAllowed: function (name) {
        if (!this._playbackEnabled()) return false
        return isCogFxx(L_.layers.data[name])
    },

    // Frames key by run, so a new model run never animates stale data.
    _frameKey: function (name, fc) {
        return `${name}:${this._forecastBase(fc)}`
    },

    // Single-URL fetch target for one step, or null when there isn't one.
    _stepUrl: function (name, fc, idx) {
        const ld = L_.layers.data[name]
        if (!ld) return null
        if (isFxxVelocity(ld)) {
            const timeStr = ld.time?.end || new Date().toISOString()
            return resolveUrlTokens(setFxx(ld.url, idx), timeStr, ld.time?.start)
        }
        return null
    },

    // Viewport tile coords, capped so zoomed-out views can't fan out.
    _visibleTileCoords: function (layer) {
        const map = layer?._map
        if (!map || typeof layer.getTileUrl !== 'function') return []
        const z = Math.round(map.getZoom())
        const size = layer.getTileSize ? layer.getTileSize().x : 256
        const b = map.getBounds()
        const nw = map.project(b.getNorthWest(), z).divideBy(size).floor()
        const se = map.project(b.getSouthEast(), z).divideBy(size).floor()
        const coords = []
        for (let x = nw.x; x <= se.x; x++) {
            for (let y = nw.y; y <= se.y; y++) {
                coords.push({ x, y, z })
                if (coords.length >= 48) return coords
            }
        }
        return coords
    },

    _prefetchSteps: function (name, fc, onProgress) {
        const steps = this._effectiveSteps(fc, name)
        const ld = L_.layers.data[name]
        const key = this._frameKey(name, fc)
        const isVelocity = isFxxVelocity(ld)
        const isCog = isCogFxx(ld)

        if (!this._frameCache[key]) this._frameCache[key] = {}
        const frames = this._frameCache[key]

        const tasks = []
        for (let i = 0; i < steps; i++) {
            const idx = i
            if (isVelocity) {
                if (frames[idx]) continue
                const url = this._stepUrl(name, fc, idx)
                if (!url) continue
                tasks.push(() =>
                    fetch(url)
                        .then((r) => {
                            if (!r.ok) throw new Error(r.status)
                            return r.json()
                        })
                        .then((data) => {
                            frames[idx] = data
                        })
                )
            } else if (isCog) {
                const layer = L_.layers.layer[name]
                const coords = this._visibleTileCoords(layer)
                if (!coords.length) continue
                tasks.push(() =>
                    Promise.all(
                        coords.map((c) => {
                            let u
                            try {
                                u = layer.getTileUrl(c)
                            } catch (e) {
                                return null
                            }
                            if (typeof u !== 'string') return null
                            // Warm the cache, don't keep the bytes.
                            return fetch(setFxx(u, idx), { mode: 'no-cors' }).catch(
                                () => {}
                            )
                        })
                    )
                )
            }
        }

        if (!tasks.length) {
            if (onProgress) onProgress(1, 1)
            return Promise.resolve()
        }
        return pooled(tasks, onProgress)
    },

    _setPlayUI: function (name, mode, pct) {
        const strip = document.getElementById('ftl-strip')
        const card = strip?.querySelector(`.ftl-card[data-layer="${escSel(name)}"]`)
        if (!card) return
        const btn = card.querySelector('.ftl-card-play')
        const icon = btn?.querySelector('i')
        const wrap = card.querySelector('.ftl-card-prefetch')
        const bar = wrap?.querySelector('.ftl-card-prefetch-bar')
        if (icon) {
            icon.className =
                mode === 'idle' ? 'mdi mdi-play' : 'mdi mdi-stop'
        }
        if (btn) {
            btn.classList.toggle('ftl-playing', mode !== 'idle')
            btn.classList.toggle('ftl-prefetching', mode === 'loading')
            btn.title =
                mode === 'loading'
                    ? 'Loading forecast steps — click to cancel'
                    : mode === 'playing'
                    ? 'Stop animation'
                    : 'Play forecast animation'
        }
        if (wrap) wrap.classList.toggle('ftl-prefetching', mode === 'loading')
        if (bar) bar.style.width = `${Math.round((pct || 0) * 100)}%`
    },

    // Built at hover time so step count and wording are always current.
    _playTipHtml: function (name, fc) {
        const steps = this._effectiveSteps(fc, name)
        const unit = (fc?.stepUnit || 'hour') === 'day' ? 'day' : 'hour'
        if (this._isPlaying(name)) {
            return (
                '<b>Stop animation</b><br/>' +
                '<span style="opacity:.75">Returns to manual stepping.</span>'
            )
        }
        return (
            '<b>Play forecast animation</b><br/>' +
            `<span style="opacity:.75">Loads all ${steps} ${unit} steps, then` +
            ' steps through them on the map in a loop. Click again to stop.</span>'
        )
    },

    _isPlaying: function (name) {
        return !!(this._playTimers && this._playTimers[name])
    },

    _stopPlay: function (name) {
        const t = this._playTimers?.[name]
        if (t) {
            clearInterval(t.timer)
            t.cancelled = true
        }
        if (this._playTimers) delete this._playTimers[name]
        this._setPlayUI(name, 'idle', 0)
    },

    _startPlay: function (name, fc) {
        if (!this._playTimers) this._playTimers = {}
        // Defense in depth beyond the button-render gate.
        if (!this._playbackAllowed(name)) return
        if (this.state.cards[name]?.cardState !== 'available') return

        // Placeholder entry so a second click during prefetch cancels.
        const token = { timer: null, cancelled: false }
        this._playTimers[name] = token
        this._setPlayUI(name, 'loading', 0)

        this._prefetchSteps(name, fc, (done, total) => {
            if (!token.cancelled) this._setPlayUI(name, 'loading', total ? done / total : 1)
        }).then(() => {
            if (token.cancelled || this._playTimers[name] !== token) return
            const steps = this._effectiveSteps(fc, name)
            if (steps <= 1) {
                this._stopPlay(name)
                return
            }
            this._setPlayUI(name, 'playing', 1)
            // Start from step 0 so playback reads as a full run.
            let idx = 0
            this._setCardStep(name, fc, idx)
            token.timer = setInterval(() => {
                if (this.state.cards[name]?.cardState !== 'available') {
                    this._stopPlay(name)
                    return
                }
                idx = (idx + 1) % steps
                this._setCardStep(name, fc, idx)
            }, PLAY_INTERVAL_MS)
        })
    },

    _togglePlay: function (name, fc) {
        if (this._isPlaying(name)) this._stopPlay(name)
        else this._startPlay(name, fc)
    },
}

export default playbackMethods

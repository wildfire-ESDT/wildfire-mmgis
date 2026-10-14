/**
 * Experimental playback. Off unless the mission sets the experimentalPlayback
 * component variable; only cards whose forecast type can prefetchStep get a button.
 * A play press warms every step first, then loops them on a timer.
 */

import { PLAY_INTERVAL_MS, escSel, pooled } from '../shared/common'
import { stepTime } from '../shared/timeMath'

const playbackMethods = {
    _playTimers: {},

    _playbackEnabled: function () {
        return this.vars?.experimentalPlayback === true
    },

    _playbackAllowed: function (name) {
        if (!this._playbackEnabled()) return false
        return typeof this._forecastTypeFor(name)?.prefetchStep === 'function'
    },

    _prefetchSteps: function (name, fc, onProgress) {
        const forecastType = this._forecastTypeFor(name)
        const steps = this._effectiveSteps(fc, name)
        const run = this._forecastBase(fc)
        const tasks = []
        for (let idx = 0; idx < steps; idx++) {
            if (this._missingStep(name, fc, idx)) continue
            const call = this._forecastTypeCall(name, fc, { step: idx, steps, stepTime: stepTime(fc, idx, run) })
            tasks.push(() => forecastType.prefetchStep(call))
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
            icon.className = mode === 'idle' ? 'mdi mdi-play' : 'mdi mdi-stop'
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
            const playable = Array.from({ length: steps }, (_, i) => i).filter(
                (i) => !this._missingStep(name, fc, i)
            )
            if (playable.length <= 1) {
                this._stopPlay(name)
                return
            }
            this._setPlayUI(name, 'playing', 1)
            let at = 0
            this._setCardStep(name, fc, playable[at])
            token.timer = setInterval(() => {
                if (this.state.cards[name]?.cardState !== 'available') {
                    this._stopPlay(name)
                    return
                }
                at = (at + 1) % playable.length
                this._setCardStep(name, fc, playable[at])
            }, PLAY_INTERVAL_MS)
        })
    },

    _togglePlay: function (name, fc) {
        if (this._isPlaying(name)) this._stopPlay(name)
        else this._startPlay(name, fc)
    },
}

export default playbackMethods

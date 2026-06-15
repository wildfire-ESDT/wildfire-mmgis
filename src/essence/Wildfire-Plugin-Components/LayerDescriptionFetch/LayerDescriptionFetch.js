import L_ from '../../Basics/Layers_/Layers_'

const PREFETCH_CONCURRENCY = 10

const LayerDescriptionFetch = {
    init: function (vars) {
        const checkAndPrefetch = () => {
            if (!L_.layers || !L_.layers.data) {
                setTimeout(checkAndPrefetch, 500)
                return
            }
            LayerDescriptionFetch.prefetchAllDescriptions()
        }
        checkAndPrefetch()
    },

    prefetchAllDescriptions: async function () {
        const layers = L_.layers.data
        if (!layers) return

        const toFetch = []
        for (const name in layers) {
            const layer = layers[name]
            if (layer.descriptionMarkdownUrl) {
                toFetch.push({ layer, name })
            }
        }

        for (let i = 0; i < toFetch.length; i += PREFETCH_CONCURRENCY) {
            const batch = toFetch.slice(i, i + PREFETCH_CONCURRENCY)
            await Promise.all(
                batch.map(async ({ layer, name }) => {
                    try {
                        const resp = await fetch(layer.descriptionMarkdownUrl)
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
                        const text = (await resp.text()).trim()
                        if (text) layer.description = text
                    } catch (e) {
                        // keep existing layer.description as fallback
                    }
                })
            )
        }
    },
}

export default LayerDescriptionFetch

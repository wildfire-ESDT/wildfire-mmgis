import L_ from '../../Basics/Layers_/Layers_'

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

        await Promise.all(
            Object.values(layers)
                .filter((layer) => layer.descriptionMarkdownUrl)
                .map(async (layer) => {
                    try {
                        const resp = await fetch(layer.descriptionMarkdownUrl)
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
                        const text = (await resp.text()).trim()
                        if (text) layer.description = text
                    } catch (e) {
                        // keep existing layer.description as fallback so do nothing
                    }
                })
        )
    },
}

export default LayerDescriptionFetch

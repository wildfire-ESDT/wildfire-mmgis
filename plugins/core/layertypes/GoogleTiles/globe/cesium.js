/**
 * Google Photorealistic 3D Tiles layer type, Cesium globe renderer.
 */
import * as Cesium from 'cesium'
import L_ from '@basics/Layers_/Layers_'

const TYPE = 'googletiles'

function toGlobeConfig(layerObj) {
    return {
        name: layerObj.name,
        apiKey: layerObj.googleApiKey,
        opacity: L_.layers.opacity[layerObj.name] ?? 1,
        maximumScreenSpaceError: layerObj.maximumScreenSpaceError ?? 16,
        hideGlobe: layerObj.hideGlobe !== false,
    }
}

function make(layerObj, gctx) {
    if (gctx.hasLayer(layerObj.name))
        return gctx.toggleLayer(layerObj.name, true)
    return render(toGlobeConfig(layerObj), gctx)
}

function onToggle(layerObj, gctx) {
    if (!gctx.visible) gctx.toggleLayer(layerObj.name, false)
}

async function render(layerConfig, gctx) {
    const { renderer, layers, loadingLayers } = gctx
    const { name } = layerConfig

    if (loadingLayers[name]) return
    if (!layerConfig.apiKey) {
        console.error(`Google 3D Tiles layer "${name}" has no API key.`)
        return
    }
    loadingLayers[name] = true

    try {
        const tileset = await Cesium.createGooglePhotorealistic3DTileset(
            {
                key: layerConfig.apiKey,
                // MMGIS's globe has no geocoder, so these tiles are never
                // paired with a non-Google one.
                onlyUsingWithGoogleGeocoder: true,
            },
            {
                maximumScreenSpaceError: layerConfig.maximumScreenSpaceError,
                // Google requires its data attributions on screen, not only
                // behind the credits popup.
                showCreditsOnScreen: true,
            }
        )
        delete loadingLayers[name]

        renderer.scene.primitives.add(tileset)
        layers[name] = {
            type: TYPE,
            kind: 'tileset',
            tileset,
            visible: true,
            hideGlobe: layerConfig.hideGlobe,
            opacity: layerConfig.opacity,
        }
        applyOpacity(layers[name])
        syncScene(gctx)
    } catch (err) {
        delete loadingLayers[name]
        console.error(`Failed to load Google 3D Tiles layer "${name}":`, err)
    }
}
function destroy(name, gctx) {
    const layerInfo = gctx.layers[name]
    if (!layerInfo) return
    layerInfo.visible = false
    gctx.renderer.scene.primitives.remove(layerInfo.tileset)
    syncScene(gctx)
}

function setVisibility(name, visible, gctx) {
    const layerInfo = gctx.layers[name]
    if (!layerInfo) return
    layerInfo.tileset.show = visible
    layerInfo.visible = visible
    syncScene(gctx)
}

function setOpacity(name, opacity, gctx) {
    const layerInfo = gctx.layers[name]
    if (!layerInfo) return
    layerInfo.opacity = opacity
    applyOpacity(layerInfo)
    gctx.requestRender()
}

function applyOpacity(layerInfo) {
    layerInfo.tileset.style =
        layerInfo.opacity < 1
            ? new Cesium.Cesium3DTileStyle({
                  color: `color("white", ${layerInfo.opacity})`,
              })
            : undefined
}

function syncScene(gctx) {
    const on = Object.values(gctx.layers).filter(
        (l) => l.type === TYPE && l.visible
    )
    gctx.renderer.scene.globe.show = !on.some((l) => l.hideGlobe)

    const credits = gctx.renderer.container.querySelector(
        '.cesium-widget-credits'
    )
    if (credits) {
        if (on.length > 0) credits.style.setProperty('display', 'block', 'important')
        else credits.style.removeProperty('display')
    }
    gctx.requestRender()
}

export default {
    make,
    onToggle,
    render,
    destroy,
    setVisibility,
    setOpacity,
}
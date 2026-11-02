// Tuning for photorealistic 3D Tiles from Cesium ion: defaults for the layer's
// config fields, how soon the tileset shows, and how layers are draped on it.

export const ION_PHOTOREALISTIC_LAYER_TYPE = 'ionphotorealistic'

// Google Photorealistic 3D Tiles
export const DEFAULT_ION_ASSET_ID = 2275207
export const DEFAULT_MAXIMUM_SCREEN_SPACE_ERROR = 16
export const DEFAULT_DRAPED_OPACITY = 0.75

// Toggled on the viewer container while any such layer is visible, so the
// credits hidden globally in mmgis.css show for tilesets that require on-screen
// attribution (Google Photorealistic 3D Tiles served through Cesium ion).
export const CREDITS_CLASS = 'mmgis-cesium-credits'
// How long after its first tile arrives the tileset is shown, even if the view
// is still sharpening.
export const FIRST_TILES_GRACE_MS = 1000
// Keeps more of a city in memory, so panning or zooming back doesn't download
// it again.
export const TILE_CACHE_BYTES = 1024 * 1024 * 1024

// Cesium drapes about one image tile per mesh tile, so the coarse mesh tiles
// shown first would stretch one image over a whole region. Below this level
// (~130 m a pixel) they get none; a layer appears on the mesh once its finer
// tiles load.
export const MINIMUM_DRAPED_IMAGERY_LEVEL = 10
export const DEFAULT_IMAGERY_TILE_PIXELS = 256

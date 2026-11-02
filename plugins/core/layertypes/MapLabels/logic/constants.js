// Tuning for 3D roads and labels: which places and roads show at which zoom, how they look and rank where
// they overlap, and how tiles are loaded and swapped.

export const MAP_LABELS_LAYER_TYPE = 'maplabels'
export const DEFAULT_TILES_URL = 'https://tiles.openfreemap.org/planet'
export const DEFAULT_MAXIMUM_TILE_ZOOM = 14
export const DEFAULT_FONT_SIZE_PIXELS = 14

export const EARTH_CIRCUMFERENCE_METERS = 40075017
export const MAXIMUM_TILES_IN_VIEW = 64
// Past this, a tile's data is reused; only which features are shown changes.
export const MAXIMUM_LABEL_DETAIL_ZOOM = 17
export const MAXIMUM_CACHED_TILES = 256
// Replaced tiles stay until their replacements are drawn, but never longer than this.
export const STALE_TILES_LIMIT_MS = 3000
// How often, while the camera moves, the tiles in view are updated and overlapping labels re-sorted.
export const TILE_UPDATE_INTERVAL_MS = 300
export const LABEL_LAYOUT_INTERVAL_MS = 50

// Which label wins where two overlap: lower first. Bigger places win (cities by rank); street names
// outrank neighbourhoods and smaller places.
export const PLACE_CLASS_PRIORITY = { country: 0, state: 1, province: 1, city: 2, town: 3, village: 4, suburb: 4 }
export const FREEWAY_NAME_PRIORITY = 5
export const ROAD_NAME_PRIORITY = 6
export const DEFAULT_PLACE_PRIORITY = 7
export const STALE_LABEL_PRIORITY_PENALTY = 0.5
export const SCREEN_AREA_CELL_PIXELS = 128

// The camera zoom at which each place class starts showing. Big cities start sooner, by rank.
export const PLACE_CLASS_MINIMUM_ZOOM = {
    country: 2,
    state: 4,
    province: 4,
    city: 6,
    town: 9,
    village: 11,
    suburb: 11,
    hamlet: 13,
    quarter: 13,
    neighbourhood: 14,
    locality: 14,
    isolated_dwelling: 15,
}
export const DEFAULT_PLACE_MINIMUM_ZOOM = 15
// Cities ranked up to this show from this zoom; each rank after that a zoom later, until the city zoom.
export const BIG_CITY_MINIMUM_ZOOM = 3
// Past this zoom a place class is too broad to label.
export const PLACE_CLASS_MAXIMUM_ZOOM = { country: 6, state: 8, province: 8 }
export const LOWEST_LABEL_ZOOM = Math.min(...Object.values(PLACE_CLASS_MINIMUM_ZOOM))
export const PLACE_CLASS_STYLE = {
    country: { fontScale: 1.3, fontWeight: 700, farthestMeters: Number.MAX_VALUE },
    state: { fontScale: 0.95, fontWeight: 600, farthestMeters: Number.MAX_VALUE },
    province: { fontScale: 0.95, fontWeight: 600, farthestMeters: Number.MAX_VALUE },
    city: { fontScale: 1.35, fontWeight: 700, farthestMeters: Number.MAX_VALUE },
    town: { fontScale: 1.15, fontWeight: 600, farthestMeters: 300_000 },
    village: { fontScale: 1.0, fontWeight: 600, farthestMeters: 80_000 },
    suburb: { fontScale: 1.0, fontWeight: 600, farthestMeters: 80_000 },
}
export const DEFAULT_PLACE_STYLE = { fontScale: 0.9, fontWeight: 500, farthestMeters: 30_000 }
export const PLACE_LABEL_COLOR = '#ffffff'

// The camera zoom at which each road class's names start showing.
export const ROAD_NAME_CLASS_MINIMUM_ZOOM = {
    motorway: 11,
    trunk: 12,
    primary: 12,
    secondary: 13,
    tertiary: 14,
    minor: 15,
}
// A road's name repeats along it about this many tile widths apart at the label detail zoom (~128-256 px on screen).
export const ROAD_NAME_SPACING_TILES = 0.5
export const FREEWAY_NAME_STYLE = { fontScale: 0.95, fontWeight: 600, farthestMeters: 60_000, color: '#ffe2a6' }
export const ROAD_NAME_STYLE = { fontScale: 0.85, fontWeight: 600, farthestMeters: 12_000, color: '#ffffff' }

// Ground-clamped lines are redrawn against the terrain and mesh every frame, so only freeways get one;
// other roads are named but not drawn.
export const ROAD_LINE_CLASS_STYLE = {
    motorway: { minimumZoom: 7, widthPixels: 3.5, color: '#ffcf70' },
    trunk: { minimumZoom: 8, widthPixels: 3, color: '#ffe2a6' },
}
export const ROAD_LINE_ALPHA = 0.75

export const LABEL_FONT_FAMILY = 'lato, sans-serif'
export const LABEL_OUTLINE_WIDTH_PIXELS = 3
export const LABEL_OUTLINE_ALPHA = 0.85
export const LABEL_LIFT_PIXELS = 4
// The on-screen box that keeps labels apart: Lato averages about half an em per character.
export const LABEL_HALF_WIDTH_EMS_PER_CHARACTER = 0.26
export const LABEL_LINE_HEIGHT_EMS = 1.2
export const LABEL_BOX_PADDING_PIXELS = 2

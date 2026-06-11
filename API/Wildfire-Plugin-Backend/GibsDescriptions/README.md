# GibsDescriptions Plugin

Fetches GIBS layer descriptions from NASA Worldview GitHub repository and caches them in memory for all users.

## Features
- **WebSocket Auto-Refresh**: Updates cache when configs change
- **Smart Fetching**: If server is running, and a new layer is added, it will fetch only new descriptions, and use the existing chached ones
- **Pruning**: Automatically removes descriptions for deleted layers ensuring cache is maintained.
- **Concurrency**: Fetches 5 descriptions at once for faster startup
- **Timeout Protection**: 15 second timeout per fetch
- **Manual Refresh**: Admin-only endpoint to force rebuild, used if you want to regenerate the cache without a server restart.
- **Authentication**: Public can read descriptions, admin required for stats/list/refresh

## Architecture

```
GibsDescriptions/
├── processes/
│   └── gibsCache.js       Core logic (fetch, sync, prune)
├── routes/
│   └── gibsdescriptions.js API endpoints
└── setup.js                Plugin registration
```

## Setup

### Environment Variables

Add to your `.env` file:

```bash
# Required: Enable WebSocket auto-refresh
ENABLE_MMGIS_WEBSOCKETS=true

# Optional: Filter to single mission (e.g., Wildfire)
GIBS_MISSION_FILTER=yourmission
```

**Note:** WebSockets enable automatic cache updates when configs change. Without it, you'd need to restart the server after every config save.

### Restart Server

```bash
npm start
```

## Usage

### How It Works: GitHub URL Mapping

Descriptions are fetched from NASA's Worldview GitHub repository. The plugin constructs URLs like this:

**Base URL:**
```
https://raw.githubusercontent.com/nasa-gibs/worldview/main/config/default/common/config/metadata/layers/
```

**Your `worldviewPath` is appended with `.md`:**
```
worldviewPath: "modis/aqua/MODIS_Aqua"
→ Full URL: https://raw.githubusercontent.com/.../layers/modis/aqua/MODIS_Aqua.md
```

**Browse available descriptions:**
- Visit: https://github.com/nasa-gibs/worldview/tree/main/config/default/common/config/metadata/layers
- Navigate through folders (e.g., `modis/aqua/`)
- Find your layer's `.md` file
- Copy the path after `layers/` (without `.md`)

### Finding the Right Path for GIBS Layers

**Example: MODIS Aqua Thermal Anomalies**

1. **Your GIBS layer URL in config:**
```
https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Aqua_Thermal_Anomalies_All/...
```

2. **Extract the layer identifier:**
```
MODIS_Aqua_Thermal_Anomalies_All
```

3. **Find it on GitHub:**
   - Go to: https://github.com/nasa-gibs/worldview/tree/main/config/default/common/config/metadata/layers
   - Navigate: `modis/aqua/`
   - Find: `MODIS_Aqua_Thermal_Anomalies_All.md`

4. **Your `worldviewPath`:**
```json
"worldviewPath": "modis/aqua/MODIS_Aqua_Thermal_Anomalies_All"
```

**Common patterns:**
- MODIS Aqua: `modis/aqua/[LAYER_NAME]`
- MODIS Terra: `modis/terra/[LAYER_NAME]`
- VIIRS SNPP: `viirs/snpp/[LAYER_NAME]`
- VIIRS NOAA-20: `viirs/noaa20/[LAYER_NAME]`

**Important:** GIBS URLs use underscores (`MODIS_Aqua_Thermal_Anomalies_All`) but GitHub paths also use underscores - they match exactly. Just copy the layer name from your GIBS URL and use it in the GitHub path.

### Config Setup

**1. Add `worldviewPath` to layers:**

```json
{
  "layers": [
    {
      "name": "MODIS_Aqua_Thermal_Anomalies",
      "type": "tile",
      "url": "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Aqua_Thermal_Anomalies_All/...",
      "worldviewPath": "modis/aqua/MODIS_Aqua_Thermal_Anomalies_All"
    }
  ]
}
```

**2. Enable frontend component:**

```json
{
  "components": [
    {
      "name": "GibsDescriptions",
      "on": true
    }
  ]
}
```

**Note:** If a layer doesn't have a description on GitHub, omit `worldviewPath` - the layer will work normally.

## API Endpoints

All endpoints are relative to your MMGIS instance (e.g., `https://your-mmgis-instance.com/api/gibsdescriptions/...`)

### Public (No Authentication Required)

**POST /api/gibsdescriptions/batch**
- Get multiple descriptions (cache-only, no GitHub fetch)
- Body: `{ "paths": ["modis/aqua/MODIS_Aqua", ...] }`
- Rate limit: Global MMGIS limit (20,000 requests per 5 minutes)
- No authentication required (public NASA data, cache-only reads)

### Admin Only

**GET /api/gibsdescriptions/stats**
- Cache statistics
- Requires admin authentication

**GET /api/gibsdescriptions/list**
- List all cached paths
- Requires admin authentication

**POST /api/gibsdescriptions/refresh**
- Force full cache rebuild (fetches from GitHub)
- In-flight-locked (concurrent calls share one run)
- Requires admin authentication

## How It Works

### Startup
1. Server starts → `onceSynced` triggers
2. Query all configs, get latest version of each mission
3. Extract all `worldviewPath` fields
4. Fetch descriptions from GitHub (5 at once)
5. Cache in memory

### Config Change
1. Admin saves config → WebSocket message sent
2. Plugin receives message → triggers `syncAll()`
3. Extract all paths from latest configs
4. **Smart fetching**: Only fetch paths not in cache
5. **Prune**: Remove paths no longer in any config

### Frontend Component

The frontend component automatically enriches your layers with descriptions:

1. **Waits for layers to load** - Monitors `L_.layers.data` until ready
2. **Collects paths** - Finds all layers with `worldviewPath` field
3. **Batch request** - Single POST to `/api/gibsdescriptions/batch` with all paths
4. **Stores descriptions** - Saves to `L_.layers.data[layerName].description`
5. **LayerInfoModal displays** - When users click layer info button, description appears

**Result:** Users see rich NASA descriptions in layer info panels without any manual work.


## Security

- **Path Validation**: Regex whitelist (alphanumeric, hyphens, underscores, slashes)
- **Traversal Protection**: Blocks `..` sequences
- **Length Limit**: Max 256 characters
- **Authentication**: Public endpoints require no auth (cache-only reads), refresh requires admin
- **Admin Gate**: Refresh endpoint requires admin privileges (triggers GitHub fetches)
- **Rate Limiting**: Global MMGIS limiter (20,000 requests per 5 minutes)
- **Timeout**: 15 second limit per fetch

## Performance

- **In-Memory Cache**: Shared across all users
- **Concurrency**: Fetches 5 descriptions at once
- **Smart Fetching**: Only fetches new descriptions, reuses cached ones
- **In-Flight Deduplication**: Prevents duplicate fetches
- **Failed Request Caching**: 5 minute cooldown on failures

## Opt-Out

### Disable Frontend
Set `on: false` in config:
```json
{
  "components": [
    {
      "name": "GibsDescriptions",
      "on": false
    }
  ]
}
```

### Disable Backend
Prefix directory with underscore:
```bash
mv API/Wildfire-Plugin-Backend/GibsDescriptions \
   API/Wildfire-Plugin-Backend/_GibsDescriptions
```

## Debugging

Enable debug logging in `processes/gibsCache.js`:
```javascript
const DEBUG = true;
```

Check cache stats:
```bash
curl http://localhost:8888/api/gibsdescriptions/stats
```

Force refresh (admin only):
```bash
curl -X POST http://localhost:8888/api/gibsdescriptions/refresh \
  -H "Cookie: connect.sid=..." \
  -H "Content-Type: application/json"
```

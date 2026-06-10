const router = require("./routes/worldviewmetadata");
const Config = require("../../Backend/Config/models/config");
const WebSocket = require('isomorphic-ws');

const DEBUG = true;

async function preloadWorldviewDescriptions() {
  if (DEBUG) console.log('WorldviewMetadata: Preloading descriptions...');
  
  try {
    // Get all configs with mission and version info
    const configs = await Config.findAll({
      attributes: ['config', 'mission', 'version'],
    });
    
    // Group by mission and keep only the latest version
    const latestConfigs = {};
    configs.forEach(configRecord => {
      const mission = configRecord.mission;
      const version = configRecord.version;
      
      if (!latestConfigs[mission] || latestConfigs[mission].version < version) {
        latestConfigs[mission] = configRecord;
      }
    });
    
    const worldviewPaths = new Set();
    
    // Extract worldviewPaths only from latest versions
    Object.values(latestConfigs).forEach(configRecord => {
      const config = configRecord.config;
      if (config && config.layers) {
        extractWorldviewPaths(config.layers, worldviewPaths);
      }
    });
    
    if (worldviewPaths.size === 0) {
      if (DEBUG) console.log('WorldviewMetadata: No worldviewPath fields found in configs');
      return;
    }
    
    if (DEBUG) console.log(`WorldviewMetadata: Found ${worldviewPaths.size} unique worldview paths, fetching...`);
    
    // Clear caches before refetching
    router.descriptionCache.clear();
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const path of worldviewPaths) {
      const description = await router.fetchWorldviewDescription(path);
      if (description) {
        router.descriptionCache.set(path, description);
        successCount++;
      } else {
        errorCount++;
      }
    }
    
    if (DEBUG) console.log(`WorldviewMetadata: Preload complete - ${successCount} loaded, ${errorCount} failed`);
  } catch (error) {
    console.error('WorldviewMetadata: Error during preload:', error.message);
  }
}

function extractWorldviewPaths(layers, paths) {
  if (!Array.isArray(layers)) return;
  
  layers.forEach(layer => {
    if (layer.worldviewPath) {
      paths.add(layer.worldviewPath);
    }
    if (layer.sublayers) {
      extractWorldviewPaths(layer.sublayers, paths);
    }
  });
}

let setup = {
  // Once the app initializes
  onceInit: (s) => {
    s.app.use(
      s.ROOT_PATH + "/api/worldviewmetadata",
      s.setContentType,
      router
    );
  },
  
  // Once the server starts
  onceStarted: (s) => {
    // Listen to WebSocket for config changes
    if (process.env.ENABLE_MMGIS_WEBSOCKETS === "true") {
      const port = parseInt(process.env.PORT || "8888", 10);
      const path = `${process.env.HTTPS == "true" ? "wss" : "ws"}://localhost:${port}${process.env.WEBSOCKET_ROOT_PATH || process.env.ROOT_PATH || ""}/`;
      
      try {
        const ws = new WebSocket(path);
        
        ws.on('message', async (data) => {
          try {
            const message = JSON.parse(data);
            // Check if it's a config update
            if (message.body?.config === true) {
              if (DEBUG) console.log('WorldviewMetadata: Config changed via WebSocket, refreshing cache...');
              await preloadWorldviewDescriptions();
            }
          } catch (err) {
            // Ignore parse errors
          }
        });
        
        ws.on('error', (err) => {
          console.error('WorldviewMetadata: WebSocket error:', err.message);
        });
        
        if (DEBUG) console.log('WorldviewMetadata: Connected to WebSocket for auto-refresh');
      } catch (err) {
        console.error('WorldviewMetadata: Failed to connect to WebSocket:', err.message);
      }
    }
  },
  
  // Once all tables sync
  onceSynced: (s) => {
    preloadWorldviewDescriptions();
  },
};

module.exports = setup;
module.exports.preloadWorldviewDescriptions = preloadWorldviewDescriptions;
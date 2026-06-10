const router = require("./routes/worldviewmetadata");
const Config = require("../../Backend/Config/models/config");

async function preloadWorldviewDescriptions() {
  console.log('WorldviewMetadata: Preloading descriptions on server start...');
  
  try {
    const configs = await Config.findAll({
      attributes: ['config'],
    });
    
    const worldviewPaths = new Set();
    
    configs.forEach(configRecord => {
      const config = configRecord.config;
      if (config && config.layers) {
        extractWorldviewPaths(config.layers, worldviewPaths);
      }
    });
    
    if (worldviewPaths.size === 0) {
      console.log('WorldviewMetadata: No worldviewPath fields found in configs');
      return;
    }
    
    console.log(`WorldviewMetadata: Found ${worldviewPaths.size} unique worldview paths, fetching...`);
    
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
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log(`WorldviewMetadata: Preload complete - ${successCount} loaded, ${errorCount} failed`);
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
  onceStarted: (s) => {},
  // Once all tables sync
  onceSynced: (s) => {
    preloadWorldviewDescriptions();
  },
};

module.exports = setup;
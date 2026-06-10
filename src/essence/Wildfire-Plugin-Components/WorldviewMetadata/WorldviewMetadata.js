import $ from 'jquery'
import L_ from '../../Basics/Layers_/Layers_'

const WorldviewMetadata = {
  init: function(vars) {
    console.log('WorldviewMetadata plugin initialized');
    
    // Wait for layers to be loaded
    const checkAndFetchDescriptions = () => {
      if (!L_.layers || !L_.layers.data) {
        console.log('WorldviewMetadata: Layers not ready yet, waiting...');
        setTimeout(checkAndFetchDescriptions, 500);
        return;
      }

      console.log('WorldviewMetadata: Layers ready, fetching descriptions for worldviewPath layers');
      
      // Collect all worldviewPaths that need descriptions
      const pathsToFetch = [];
      const layersByPath = {};
      
      Object.keys(L_.layers.data).forEach((layerName) => {
        const layer = L_.layers.data[layerName];
        if (layer.worldviewPath && !layer.description) {
          pathsToFetch.push(layer.worldviewPath);
          layersByPath[layer.worldviewPath] = layerName;
        }
      });
      
      if (pathsToFetch.length === 0) {
        console.log('WorldviewMetadata: No descriptions needed');
        return;
      }
      
      console.log(`WorldviewMetadata: Fetching ${pathsToFetch.length} descriptions in batch`);
      
      // Single batch request for all descriptions
      const metadataUrl = `${
        window.mmgisglobal.ROOT_PATH ? window.mmgisglobal.ROOT_PATH + '/' : ''
      }api/worldviewmetadata/descriptions/batch`;
      
      $.ajax({
        type: 'POST',
        url: metadataUrl,
        contentType: 'application/json',
        data: JSON.stringify({ paths: pathsToFetch }),
        xhrFields: {
          withCredentials: true,
        },
        success: (response) => {
          if (response.success && response.results) {
            let loadedCount = 0;
            let failedCount = 0;
            
            Object.keys(response.results).forEach((path) => {
              const result = response.results[path];
              const layerName = layersByPath[path];
              
              if (result.success && result.data && result.data.summary) {
                L_.layers.data[layerName].description = result.data.summary;
                loadedCount++;
                console.log(`WorldviewMetadata: Description loaded for ${L_.layers.data[layerName].display_name}`);
              } else {
                failedCount++;
                console.warn(`WorldviewMetadata: Failed to load description for ${L_.layers.data[layerName].display_name}:`, result.message);
              }
            });
            
            console.log(`WorldviewMetadata: Batch complete - ${loadedCount} loaded, ${failedCount} failed`);
          }
        },
        error: (xhr, status, error) => {
          console.error('WorldviewMetadata: Batch fetch failed:', error);
          // No fallback - user will see "No Description" in modal
        }
      });
    };

    // Start checking for layers
    checkAndFetchDescriptions();
  }
};

export default WorldviewMetadata;
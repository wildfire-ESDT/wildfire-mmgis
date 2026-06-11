import $ from 'jquery'
import L_ from '../../Basics/Layers_/Layers_'

const DEBUG = false;

const GibsDescriptions = {
  init: function(vars) {
    if (DEBUG) console.log('GibsDescriptions plugin initialized');
    
    // Wait for layers to be loaded
    const checkAndFetchDescriptions = () => {
      if (!L_.layers || !L_.layers.data) {
        if (DEBUG) console.log('GibsDescriptions: Layers not ready yet, waiting...');
        setTimeout(checkAndFetchDescriptions, 500);
        return;
      }

      if (DEBUG) console.log('GibsDescriptions: Layers ready, fetching descriptions for worldviewPath layers');
      
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
        if (DEBUG) console.log('GibsDescriptions: No descriptions needed');
        return;
      }
      
      if (DEBUG) console.log(`GibsDescriptions: Fetching ${pathsToFetch.length} descriptions in batch`);
      
      // Single batch request for all descriptions
      const apiUrl = `${
        window.mmgisglobal.ROOT_PATH ? window.mmgisglobal.ROOT_PATH + '/' : ''
      }api/gibsdescriptions/batch`;
      
      $.ajax({
        type: 'POST',
        url: apiUrl,
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
                if (DEBUG) console.log(`GibsDescriptions: Description loaded for ${L_.layers.data[layerName].display_name}`);
              } else {
                failedCount++;
                if (DEBUG) console.warn(`GibsDescriptions: Failed to load description for ${L_.layers.data[layerName].display_name}:`, result.message);
              }
            });
            
            if (DEBUG) console.log(`GibsDescriptions: Batch complete - ${loadedCount} loaded, ${failedCount} failed`);
          }
        },
        error: (xhr, status, error) => {
          console.error('GibsDescriptions: Batch fetch failed:', error);
          // No fallback - user will see "No Description" in modal
        }
      });
    };

    // Start checking for layers
    checkAndFetchDescriptions();
  }
};

export default GibsDescriptions;

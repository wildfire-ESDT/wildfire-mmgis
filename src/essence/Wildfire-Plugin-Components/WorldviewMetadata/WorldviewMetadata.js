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
      
      // Iterate through all layers and fetch descriptions for those with worldviewPath
      Object.keys(L_.layers.data).forEach((layerName) => {
        const layer = L_.layers.data[layerName];
        
        if (layer.worldviewPath && !layer.description) {
          const encodedPath = encodeURIComponent(layer.worldviewPath);
          const metadataUrl = `${
            window.mmgisglobal.ROOT_PATH
              ? window.mmgisglobal.ROOT_PATH + '/'
              : ''
          }api/worldviewmetadata/description/${encodedPath}`;
          
          $.ajax({
            type: 'GET',
            url: metadataUrl,
            xhrFields: {
              withCredentials: true,
            },
            success: (response) => {
              if (response.success && response.data && response.data.summary) {
                // Remove image references from markdown to prevent 404 errors
                let description = response.data.summary;
                if (description) {
                  description = description.replace(/!\[.*?\]\(.*?\)/g, '');
                }
                L_.layers.data[layerName].description = description;
                console.log(`WorldviewMetadata: Description loaded for ${layer.display_name}`);
              }
            },
            error: (xhr, status, error) => {
              console.warn(`WorldviewMetadata: Failed to fetch description for ${layer.display_name}:`, error);
            }
          });
        }
      });
    };

    // Start checking for layers
    checkAndFetchDescriptions();
  }
};

export default WorldviewMetadata;

import { test, expect } from '@playwright/test';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

/**
 * LayerMetadata Config Validation Tests
 * 
 * Verifies that each layer's worldviewPath correctly matches its GIBS URL
 * and that the Worldview description is appropriate for the configured product.
 */

const WORLDVIEW_BASE_URL = 'https://raw.githubusercontent.com/nasa-gibs/worldview/main/config/default/common/config/metadata/layers';
const CONFIG_PATH = path.join(process.cwd(), 'Missions', 'dev-config.json');

test.describe('LayerMetadata - Config Validation', () => {
  let config;
  let layersWithWorldview;

  test.beforeAll(() => {
    const configContent = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = JSON.parse(configContent);
    
    layersWithWorldview = [];
    
    function extractLayers(layers) {
      for (const layer of layers) {
        if (layer.worldviewPath && layer.url) {
          layersWithWorldview.push({
            name: layer.name,
            worldviewPath: layer.worldviewPath,
            url: layer.url
          });
        }
        if (layer.sublayers && layer.sublayers.length > 0) {
          extractLayers(layer.sublayers);
        }
      }
    }
    
    if (config.layers) {
      extractLayers(config.layers);
    }
  });

  test('config file should exist and be valid JSON', () => {
    expect(config).toBeTruthy();
    expect(config.layers).toBeTruthy();
  });

  test('should have exactly 40 layers with worldviewPath', () => {
    expect(layersWithWorldview.length).toBe(40);
  });

  test('each worldviewPath should match the product name in GIBS URL', async () => {
    const mismatches = [];
    
    for (const layer of layersWithWorldview) {
      let productNameFromUrl;
      
      // Handle WMS format: layers=PRODUCT_NAME
      const wmsMatch = layer.url.match(/layers=((?:MODIS|VIIRS|GOES|TEMPO|SMAP|TROPOMI|OPERA)[^&]+)/);
      if (wmsMatch) {
        productNameFromUrl = wmsMatch[1];
      } else {
        // Handle WMTS format: /PRODUCT_NAME/default/
        const wmtsMatch = layer.url.match(/\/((?:MODIS|VIIRS|GOES|TEMPO|SMAP|TROPOMI|OPERA)[^/]+)\/default/);
        if (wmtsMatch) {
          productNameFromUrl = wmtsMatch[1];
        }
      }
      
      if (!productNameFromUrl) {
        mismatches.push({
          layer: layer.name,
          reason: 'Could not extract product name from URL',
          url: layer.url
        });
        continue;
      }
      
      const productNameFromPath = layer.worldviewPath.split('/').pop();
      
      if (productNameFromUrl !== productNameFromPath) {
        mismatches.push({
          layer: layer.name,
          urlProduct: productNameFromUrl,
          pathProduct: productNameFromPath,
          worldviewPath: layer.worldviewPath
        });
      }
    }
    
    if (mismatches.length > 0) {
      console.log('Product name mismatches:', JSON.stringify(mismatches, null, 2));
    }
    
    expect(mismatches).toHaveLength(0);
  });

  test('each Worldview description should mention the correct product', async () => {
    const descriptionMismatches = [];
    
    for (const layer of layersWithWorldview) {
      const worldviewUrl = `${WORLDVIEW_BASE_URL}/${layer.worldviewPath}.md`;
      
      try {
        const response = await fetch(worldviewUrl);
        if (!response.ok) {
          descriptionMismatches.push({
            layer: layer.name,
            reason: `HTTP ${response.status}`,
            worldviewPath: layer.worldviewPath
          });
          continue;
        }
        
        const markdown = await response.text();
        const productName = layer.worldviewPath.split('/').pop();
        
        const instrumentMatch = productName.match(/^(MODIS|VIIRS|GOES|TEMPO|SMAP|TROPOMI|OPERA)/);
        if (!instrumentMatch) continue;
        
        const instrument = instrumentMatch[1];
        const instrumentVariants = {
          'MODIS': ['MODIS', 'Moderate Resolution Imaging Spectroradiometer'],
          'VIIRS': ['VIIRS', 'Visible Infrared Imaging Radiometer Suite'],
          'GOES': ['GOES', 'Geostationary Operational Environmental Satellite'],
          'TEMPO': ['TEMPO', 'Tropospheric Emissions: Monitoring of Pollution'],
          'SMAP': ['SMAP', 'Soil Moisture Active Passive'],
          'TROPOMI': ['TROPOMI', 'TROPOspheric Monitoring Instrument'],
          'OPERA': ['OPERA', 'Observational Products for End-Users from Remote Sensing Analysis']
        };
        
        const variants = instrumentVariants[instrument] || [instrument];
        const mentionsInstrument = variants.some(variant => 
          markdown.includes(variant)
        );
        
        if (!mentionsInstrument) {
          descriptionMismatches.push({
            layer: layer.name,
            instrument: instrument,
            reason: `Description does not mention ${instrument}`,
            worldviewPath: layer.worldviewPath,
            descriptionPreview: markdown.substring(0, 200)
          });
        }
        
      } catch (error) {
        descriptionMismatches.push({
          layer: layer.name,
          reason: error.message,
          worldviewPath: layer.worldviewPath
        });
      }
    }
    
    if (descriptionMismatches.length > 0) {
      console.log('Description validation issues:', JSON.stringify(descriptionMismatches, null, 2));
    }
    
    expect(descriptionMismatches).toHaveLength(0);
  });

  test('SMAP layers should reference correct L4 products', async () => {
    const smapLayers = layersWithWorldview.filter(l => l.worldviewPath.includes('smap/'));
    
    expect(smapLayers.length).toBe(3);
    
    for (const layer of smapLayers) {
      const worldviewUrl = `${WORLDVIEW_BASE_URL}/${layer.worldviewPath}.md`;
      const response = await fetch(worldviewUrl);
      const markdown = await response.text();
      
      expect(markdown).toContain('SMAP');
      expect(markdown).toContain('L4');
      
      if (layer.worldviewPath.includes('Temperature')) {
        expect(markdown.toLowerCase()).toContain('temperature');
      } else if (layer.worldviewPath.includes('Surface_Soil_Moisture')) {
        expect(markdown.toLowerCase()).toContain('surface');
        expect(markdown.toLowerCase()).toContain('soil moisture');
      } else if (layer.worldviewPath.includes('Root_Zone')) {
        expect(markdown.toLowerCase()).toContain('root zone');
      }
    }
  });

  test('MODIS layers should distinguish between satellites (Aqua/Terra)', async () => {
    const modisLayers = layersWithWorldview.filter(l => 
      l.worldviewPath.includes('modis/') && !l.worldviewPath.includes('combined')
    );
    
    for (const layer of modisLayers) {
      const worldviewUrl = `${WORLDVIEW_BASE_URL}/${layer.worldviewPath}.md`;
      const response = await fetch(worldviewUrl);
      const markdown = await response.text();
      
      // Check if satellite is mentioned in description or references (DOI codes)
      if (layer.worldviewPath.includes('aqua')) {
        const mentionsAqua = markdown.includes('Aqua') || 
                            markdown.match(/MYD\d{2}/i) || // Aqua products start with MYD
                            markdown.includes('EOS-PM');
        expect(mentionsAqua).toBeTruthy();
      } else if (layer.worldviewPath.includes('terra')) {
        const mentionsTerra = markdown.includes('Terra') || 
                             markdown.match(/MOD\d{2}/i) || // Terra products start with MOD
                             markdown.includes('EOS-AM');
        expect(mentionsTerra).toBeTruthy();
      }
    }
  });

  test('VIIRS layers should distinguish between satellites (SNPP/NOAA-20/NOAA-21)', async () => {
    const viirsLayers = layersWithWorldview.filter(l => l.worldviewPath.includes('viirs/'));
    
    for (const layer of viirsLayers) {
      const worldviewUrl = `${WORLDVIEW_BASE_URL}/${layer.worldviewPath}.md`;
      const response = await fetch(worldviewUrl);
      const markdown = await response.text();
      
      if (layer.worldviewPath.includes('snpp')) {
        expect(markdown.toLowerCase()).toMatch(/suomi|snpp|s-npp/);
      } else if (layer.worldviewPath.includes('noaa20')) {
        expect(markdown.toLowerCase()).toMatch(/noaa-20|noaa 20|jpss-1/);
      } else if (layer.worldviewPath.includes('noaa21')) {
        expect(markdown.toLowerCase()).toMatch(/noaa-21|noaa 21|jpss-2/);
      }
    }
  });

  test('GOES layers should distinguish between East and West', async () => {
    const goesLayers = layersWithWorldview.filter(l => l.worldviewPath.includes('goes/'));
    
    for (const layer of goesLayers) {
      const worldviewUrl = `${WORLDVIEW_BASE_URL}/${layer.worldviewPath}.md`;
      const response = await fetch(worldviewUrl);
      const markdown = await response.text();
      
      if (layer.worldviewPath.includes('East')) {
        expect(markdown).toContain('East');
      } else if (layer.worldviewPath.includes('West')) {
        expect(markdown).toContain('West');
      }
    }
  });

  test('vegetation index layers should reference correct product type (EVI/NDVI)', async () => {
    const vegLayers = layersWithWorldview.filter(l => 
      l.worldviewPath.includes('EVI') || l.worldviewPath.includes('NDVI')
    );
    
    for (const layer of vegLayers) {
      const worldviewUrl = `${WORLDVIEW_BASE_URL}/${layer.worldviewPath}.md`;
      const response = await fetch(worldviewUrl);
      const markdown = await response.text();
      
      if (layer.worldviewPath.includes('EVI')) {
        expect(markdown).toMatch(/Enhanced Vegetation Index|EVI/);
      } else if (layer.worldviewPath.includes('NDVI')) {
        expect(markdown).toMatch(/Normalized Difference Vegetation Index|NDVI/);
      }
    }
  });

  test('all layers should have consistent URL and worldviewPath structure', () => {
    const structureIssues = [];
    
    for (const layer of layersWithWorldview) {
      const isGIBS = layer.url.includes('gibs.earthdata.nasa.gov') || 
                     layer.url.includes('gitc.earthdata.nasa.gov');
      
      if (!isGIBS) {
        structureIssues.push({
          layer: layer.name,
          reason: 'URL is not from GIBS/GITC',
          url: layer.url
        });
      }
      
      const pathParts = layer.worldviewPath.split('/');
      if (pathParts.length < 2) {
        structureIssues.push({
          layer: layer.name,
          reason: 'worldviewPath should have at least 2 parts (instrument/product)',
          worldviewPath: layer.worldviewPath
        });
      }
    }
    
    if (structureIssues.length > 0) {
      console.log('Structure issues:', JSON.stringify(structureIssues, null, 2));
    }
    
    expect(structureIssues).toHaveLength(0);
  });
});

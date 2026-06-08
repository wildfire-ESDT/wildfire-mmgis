import { test, expect } from '@playwright/test';
import fetch from 'node-fetch';

/**
 * LayerMetadata Worldview Integration Tests
 * 
 * Tests that all layers with worldviewPath successfully fetch descriptions
 * from NASA Worldview's GitHub repository.
 */

const WORLDVIEW_BASE_URL = 'https://raw.githubusercontent.com/nasa-gibs/worldview/main/config/default/common/config/metadata/layers';

const WORLDVIEW_LAYERS = [
  { name: 'MODIS Aqua Thermal Anomalies', path: 'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All' },
  { name: 'MODIS Terra Thermal Anomalies', path: 'modis/terra/MODIS_Terra_Thermal_Anomalies_All' },
  { name: 'MODIS Combined Thermal Anomalies', path: 'modis/combined/MODIS_Combined_Thermal_Anomalies_All' },
  { name: 'VIIRS SNPP Thermal Anomalies', path: 'viirs/snpp/VIIRS_SNPP_Thermal_Anomalies_375m_All' },
  { name: 'VIIRS NOAA-20 Thermal Anomalies', path: 'viirs/noaa20/VIIRS_NOAA20_Thermal_Anomalies_375m_All' },
  { name: 'VIIRS NOAA-21 Thermal Anomalies', path: 'viirs/noaa21/VIIRS_NOAA21_Thermal_Anomalies_375m_All' },
  { name: 'TEMPO Ozone Column Amount', path: 'tempo/TEMPO_L3_Ozone_Column_Amount' },
  { name: 'TEMPO NO2 Troposphere', path: 'tempo/TEMPO_L3_NO2_Vertical_Column_Troposphere' },
  { name: 'TEMPO Formaldehyde', path: 'tempo/TEMPO_L3_Formaldehyde_Vertical_Column' },
  { name: 'GOES-East Fire Temperature', path: 'goes/GOES-East_ABI_FireTemp' },
  { name: 'GOES-West Fire Temperature', path: 'goes/GOES-West_ABI_FireTemp' },
  { name: 'GOES-West Dust', path: 'goes/GOES-West_ABI_Dust' },
  { name: 'GOES-East Dust', path: 'goes/GOES-East_ABI_Dust' },
  { name: 'GOES-West Air Mass', path: 'goes/GOES-West_ABI_Air_Mass' },
  { name: 'GOES-East Air Mass', path: 'goes/GOES-East_ABI_Air_Mass' },
  { name: 'GOES-West Red Visible', path: 'goes/GOES-West_ABI_Band2_Red_Visible_1km' },
  { name: 'GOES-East Red Visible', path: 'goes/GOES-East_ABI_Band2_Red_Visible_1km' },
  { name: 'GOES-West GeoColor', path: 'goes/GOES-West_ABI_GeoColor' },
  { name: 'GOES-East GeoColor', path: 'goes/GOES-East_ABI_GeoColor' },
  { name: 'GOES-East Clean Infrared', path: 'goes/GOES-East_ABI_Band13_Clean_Infrared' },
  { name: 'GOES-West Clean Infrared', path: 'goes/GOES-West_ABI_Band13_Clean_Infrared' },
  { name: 'SMAP Surface Soil Temperature', path: 'smap/SMAP_L4_Soil_Temperature_Layer_1' },
  { name: 'SMAP Surface Soil Moisture', path: 'smap/SMAP_L4_Analyzed_Surface_Soil_Moisture' },
  { name: 'SMAP Root Zone Soil Moisture', path: 'smap/SMAP_L4_Analyzed_Root_Zone_Soil_Moisture' },
  { name: 'OPERA Vegetation Disturbance Status', path: 'multi-mission/opera/OPERA_L3_DIST-ALERT-HLS_Color_Index' },
  { name: 'OPERA Vegetation Disturbance Annual', path: 'multi-mission/opera/OPERA_L3_DIST-ANN-HLS_Color_Index' },
  { name: 'TROPOMI Sulfur Dioxide', path: 'tropomi/TROPOMI_L2_Sulfur_Dioxide_Total_Vertical_Column' },
  { name: 'TROPOMI Nitrogen Dioxide', path: 'tropomi/TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column' },
  { name: 'MODIS Aqua True Color', path: 'modis/aqua/MODIS_Aqua_CorrectedReflectance_TrueColor' },
  { name: 'MODIS Terra True Color', path: 'modis/terra/MODIS_Terra_CorrectedReflectance_TrueColor' },
  { name: 'MODIS Aqua EVI 16-Day', path: 'modis/aqua/MODIS_Aqua_L3_EVI_16Day' },
  { name: 'MODIS Terra EVI 16-Day', path: 'modis/terra/MODIS_Terra_L3_EVI_16Day' },
  { name: 'MODIS Terra EVI 8-Day', path: 'modis/terra/MODIS_Terra_EVI_8Day' },
  { name: 'MODIS Terra NDVI 8-Day', path: 'modis/terra/MODIS_Terra_NDVI_8Day' },
  { name: 'VIIRS NOAA-20 Corrected Reflectance', path: 'viirs/noaa20/VIIRS_NOAA20_CorrectedReflectance_BandsM11-I2-I1' },
  { name: 'VIIRS SNPP Corrected Reflectance', path: 'viirs/snpp/VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1' },
  { name: 'VIIRS NOAA-20 EVI 8-Day', path: 'viirs/noaa20/VIIRS_NOAA20_EVI_8Day' },
  { name: 'VIIRS SNPP EVI 8-Day', path: 'viirs/snpp/VIIRS_SNPP_EVI_8Day' },
  { name: 'VIIRS NOAA-20 NDVI 8-Day', path: 'viirs/noaa20/VIIRS_NOAA20_NDVI_8Day' },
  { name: 'VIIRS SNPP NDVI 8-Day', path: 'viirs/snpp/VIIRS_SNPP_NDVI_8Day' },
];

test.describe('LayerMetadata - Worldview Integration', () => {
  
  test('should have 40 layers configured with worldviewPath', () => {
    expect(WORLDVIEW_LAYERS.length).toBe(40);
  });

  test.describe('Worldview GitHub API', () => {
    
    test('all worldviewPath URLs should return 200 OK', async () => {
      const results = [];
      
      for (const layer of WORLDVIEW_LAYERS) {
        const url = `${WORLDVIEW_BASE_URL}/${layer.path}.md`;
        
        try {
          const response = await fetch(url);
          results.push({
            name: layer.name,
            path: layer.path,
            status: response.status,
            ok: response.ok,
            url: url
          });
          
          expect(response.ok).toBe(true);
          expect(response.status).toBe(200);
        } catch (error) {
          results.push({
            name: layer.name,
            path: layer.path,
            status: 'ERROR',
            ok: false,
            error: error.message,
            url: url
          });
          throw new Error(`Failed to fetch ${layer.name}: ${error.message}`);
        }
      }
      
      // Log summary
      const successful = results.filter(r => r.ok).length;
      console.log(`Successfully fetched ${successful}/${WORLDVIEW_LAYERS.length} Worldview descriptions`);
    });

    test('all descriptions should contain non-empty markdown content', async () => {
      const emptyDescriptions = [];
      
      for (const layer of WORLDVIEW_LAYERS) {
        const url = `${WORLDVIEW_BASE_URL}/${layer.path}.md`;
        const response = await fetch(url);
        const markdown = await response.text();
        
        if (!markdown || markdown.trim().length === 0) {
          emptyDescriptions.push(layer.name);
        }
        
        expect(markdown).toBeTruthy();
        expect(markdown.trim().length).toBeGreaterThan(0);
      }
      
      if (emptyDescriptions.length > 0) {
        throw new Error(`Empty descriptions found for: ${emptyDescriptions.join(', ')}`);
      }
    });

    test('descriptions should be valid markdown format', async () => {
      const invalidMarkdown = [];
      
      for (const layer of WORLDVIEW_LAYERS) {
        const url = `${WORLDVIEW_BASE_URL}/${layer.path}.md`;
        const response = await fetch(url);
        const markdown = await response.text();
        
        // Basic markdown validation - should not be HTML or JSON
        const isHTML = markdown.trim().startsWith('<');
        const isJSON = markdown.trim().startsWith('{') || markdown.trim().startsWith('[');
        
        if (isHTML || isJSON) {
          invalidMarkdown.push({
            name: layer.name,
            type: isHTML ? 'HTML' : 'JSON'
          });
        }
        
        expect(isHTML).toBe(false);
        expect(isJSON).toBe(false);
      }
      
      if (invalidMarkdown.length > 0) {
        throw new Error(`Invalid markdown format for: ${invalidMarkdown.map(m => `${m.name} (${m.type})`).join(', ')}`);
      }
    });
  });

  test.describe('Layer categorization', () => {
    
    test('should have correct distribution by category', () => {
      const categories = {
        fire: WORLDVIEW_LAYERS.filter(l => l.path.includes('Thermal_Anomalies')).length,
        tempo: WORLDVIEW_LAYERS.filter(l => l.path.includes('tempo/')).length,
        goes: WORLDVIEW_LAYERS.filter(l => l.path.includes('goes/')).length,
        smap: WORLDVIEW_LAYERS.filter(l => l.path.includes('smap/')).length,
        opera: WORLDVIEW_LAYERS.filter(l => l.path.includes('opera/')).length,
        tropomi: WORLDVIEW_LAYERS.filter(l => l.path.includes('tropomi/')).length,
        modis: WORLDVIEW_LAYERS.filter(l => l.path.includes('modis/') && !l.path.includes('Thermal_Anomalies')).length,
        viirs: WORLDVIEW_LAYERS.filter(l => l.path.includes('viirs/') && !l.path.includes('Thermal_Anomalies')).length,
      };
      
      expect(categories.fire).toBe(6);
      expect(categories.tempo).toBe(3);
      expect(categories.goes).toBe(12);
      expect(categories.smap).toBe(3);
      expect(categories.opera).toBe(2);
      expect(categories.tropomi).toBe(2);
      expect(categories.modis).toBe(6);
      expect(categories.viirs).toBe(6);
      
      const total = Object.values(categories).reduce((sum, count) => sum + count, 0);
      expect(total).toBe(40);
    });
  });
});

import { test, expect } from '@playwright/test';

/**
 * Tests for LayerMetadata API integration with NASA Worldview.
 *
 * Tests the backend endpoint that fetches layer descriptions from
 * NASA Worldview's GitHub repository using worldviewPath.
 *
 * These tests verify:
 * - URL encoding/decoding works correctly
 * - Worldview GitHub API is accessible
 * - Response format matches expected structure
 * - Error handling for invalid paths
 */

test.describe('LayerMetadata API', () => {
  const BASE_URL = process.env.TEST_URL || 'http://localhost:18888';

  test('GET /api/layermetadata/description/:encodedPath returns valid description for MODIS Aqua', async ({ request }) => {
    const worldviewPath = 'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All';
    const encodedPath = encodeURIComponent(worldviewPath);
    
    const res = await request.get(`${BASE_URL}/api/layermetadata/description/${encodedPath}`);
    const data = await res.json();

    expect(res.ok()).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data).toBeTruthy();
    expect(data.data.summary).toBeTruthy();
    expect(data.data.source).toBe('worldview');
    expect(data.data.path).toBe(worldviewPath);
    expect(data.data.summary).toContain('MODIS');
  });

  test('GET /api/layermetadata/description/:encodedPath handles paths with slashes correctly', async ({ request }) => {
    const worldviewPath = 'viirs/snpp/VIIRS_SNPP_Thermal_Anomalies_375m_All';
    const encodedPath = encodeURIComponent(worldviewPath);
    
    const res = await request.get(`${BASE_URL}/api/layermetadata/description/${encodedPath}`);
    const data = await res.json();

    expect(res.ok()).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data.path).toBe(worldviewPath);
    expect(data.data.summary).toContain('VIIRS');
  });

  test('GET /api/layermetadata/description/:encodedPath returns valid description for GOES', async ({ request }) => {
    const worldviewPath = 'goes/GOES-East_ABI_FireTemp';
    const encodedPath = encodeURIComponent(worldviewPath);
    
    const res = await request.get(`${BASE_URL}/api/layermetadata/description/${encodedPath}`);
    const data = await res.json();

    expect(res.ok()).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data.summary).toContain('GOES');
  });

  test('GET /api/layermetadata/description/:encodedPath returns valid description for TEMPO', async ({ request }) => {
    const worldviewPath = 'tempo/TEMPO_L3_Ozone_Column_Amount';
    const encodedPath = encodeURIComponent(worldviewPath);
    
    const res = await request.get(`${BASE_URL}/api/layermetadata/description/${encodedPath}`);
    const data = await res.json();

    expect(res.ok()).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data.summary).toContain('TEMPO');
  });

  test('GET /api/layermetadata/description/:encodedPath returns valid description for SMAP', async ({ request }) => {
    const worldviewPath = 'smap/SMAP_L4_Soil_Temperature_Layer_1';
    const encodedPath = encodeURIComponent(worldviewPath);
    
    const res = await request.get(`${BASE_URL}/api/layermetadata/description/${encodedPath}`);
    const data = await res.json();

    expect(res.ok()).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data.summary).toContain('SMAP');
    expect(data.data.summary.toLowerCase()).toContain('temperature');
  });

  test('GET /api/layermetadata/description/:encodedPath returns valid description for TROPOMI', async ({ request }) => {
    const worldviewPath = 'tropomi/TROPOMI_L2_Sulfur_Dioxide_Total_Vertical_Column';
    const encodedPath = encodeURIComponent(worldviewPath);
    
    const res = await request.get(`${BASE_URL}/api/layermetadata/description/${encodedPath}`);
    const data = await res.json();

    expect(res.ok()).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data.summary).toContain('TROPOMI');
  });

  test('GET /api/layermetadata/description/:encodedPath returns valid description for OPERA', async ({ request }) => {
    const worldviewPath = 'multi-mission/opera/OPERA_L3_DIST-ALERT-HLS_Color_Index';
    const encodedPath = encodeURIComponent(worldviewPath);
    
    const res = await request.get(`${BASE_URL}/api/layermetadata/description/${encodedPath}`);
    const data = await res.json();

    expect(res.ok()).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data.summary).toContain('OPERA');
  });

  test('GET /api/layermetadata/description/:encodedPath returns 404 for non-existent path', async ({ request }) => {
    const worldviewPath = 'invalid/path/DOES_NOT_EXIST';
    const encodedPath = encodeURIComponent(worldviewPath);
    
    const res = await request.get(`${BASE_URL}/api/layermetadata/description/${encodedPath}`);
    const data = await res.json();

    expect(res.status()).toBe(404);
    expect(data.success).toBe(false);
    expect(data.message).toContain('404');
  });

  test('GET /api/layermetadata/description/ without path returns 404', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/layermetadata/description/`);
    
    expect(res.status()).toBe(404);
  });

  test('response includes markdown content with proper formatting', async ({ request }) => {
    const worldviewPath = 'modis/terra/MODIS_Terra_Thermal_Anomalies_All';
    const encodedPath = encodeURIComponent(worldviewPath);
    
    const res = await request.get(`${BASE_URL}/api/layermetadata/description/${encodedPath}`);
    const data = await res.json();

    expect(res.ok()).toBe(true);
    expect(data.data.summary.length).toBeGreaterThan(100);
    expect(data.data.summary).not.toMatch(/^</); // Not HTML
    expect(data.data.summary).not.toMatch(/^[{[]/); // Not JSON
  });

  test('handles special characters in worldviewPath', async ({ request }) => {
    const worldviewPath = 'goes/GOES-East_ABI_Band13_Clean_Infrared';
    const encodedPath = encodeURIComponent(worldviewPath);
    
    const res = await request.get(`${BASE_URL}/api/layermetadata/description/${encodedPath}`);
    const data = await res.json();

    expect(res.ok()).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data.path).toBe(worldviewPath);
  });

  test('response time is reasonable (< 5 seconds)', async ({ request }) => {
    const worldviewPath = 'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All';
    const encodedPath = encodeURIComponent(worldviewPath);
    
    const startTime = Date.now();
    const res = await request.get(`${BASE_URL}/api/layermetadata/description/${encodedPath}`);
    const endTime = Date.now();
    
    const responseTime = endTime - startTime;

    expect(res.ok()).toBe(true);
    expect(responseTime).toBeLessThan(5000);
  });
});

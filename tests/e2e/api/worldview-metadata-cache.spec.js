/**
 * @file worldview-metadata-cache.spec.js
 * @description Tests for WorldviewMetadata caching behavior
 */

const { test, expect } = require('@playwright/test');

test.describe('WorldviewMetadata Caching', () => {
  const BASE_URL = process.env.TEST_URL || 'http://localhost:18888';
  const TEST_PATH = 'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All';
  const ENCODED_PATH = encodeURIComponent(TEST_PATH);

  test('should fetch description from GitHub and cache it', async ({ request }) => {
    // First request - should fetch from GitHub
    const response1 = await request.get(
      `${BASE_URL}/api/worldviewmetadata/description/${ENCODED_PATH}`
    );
    
    expect(response1.ok()).toBeTruthy();
    const data1 = await response1.json();
    
    expect(data1.success).toBe(true);
    expect(data1.data).toBeDefined();
    expect(data1.data.summary).toBeTruthy();
    expect(data1.data.path).toBe(TEST_PATH);
    
    // Source could be 'worldview' (fresh fetch) or 'worldview-cached' (preloaded)
    expect(['worldview', 'worldview-cached']).toContain(data1.data.source);
    
    // Second request - should definitely come from cache
    const response2 = await request.get(
      `${BASE_URL}/api/worldviewmetadata/description/${ENCODED_PATH}`
    );
    
    expect(response2.ok()).toBeTruthy();
    const data2 = await response2.json();
    
    expect(data2.success).toBe(true);
    expect(data2.data.source).toBe('worldview-cached');
    expect(data2.data.summary).toBe(data1.data.summary);
  });

  test('should return same description on multiple requests', async ({ request }) => {
    // Make requests sequentially to ensure caching happens
    const response1 = await request.get(`${BASE_URL}/api/worldviewmetadata/description/${ENCODED_PATH}`);
    const data1 = await response1.json();
    
    const response2 = await request.get(`${BASE_URL}/api/worldviewmetadata/description/${ENCODED_PATH}`);
    const data2 = await response2.json();
    
    const response3 = await request.get(`${BASE_URL}/api/worldviewmetadata/description/${ENCODED_PATH}`);
    const data3 = await response3.json();
    
    // All should succeed
    expect(data1.success).toBe(true);
    expect(data2.success).toBe(true);
    expect(data3.success).toBe(true);
    
    expect(data1.data.summary).toBeTruthy();
    expect(data2.data.summary).toBeTruthy();
    expect(data3.data.summary).toBeTruthy();
    
    // All should have same description
    expect(data1.data.summary).toBe(data2.data.summary);
    expect(data2.data.summary).toBe(data3.data.summary);
    
    // Second and third should be from cache
    expect(data2.data.source).toBe('worldview-cached');
    expect(data3.data.source).toBe('worldview-cached');
  });

  test('should handle invalid worldview path gracefully', async ({ request }) => {
    const invalidPath = encodeURIComponent('invalid/path/does_not_exist');
    
    const response = await request.get(
      `${BASE_URL}/api/worldviewmetadata/description/${invalidPath}`
    );
    
    expect(response.status()).toBe(404);
    const data = await response.json();
    
    expect(data.success).toBe(false);
    expect(data.message).toContain('not found');
  });

  test('should cache multiple different worldview paths', async ({ request }) => {
    const paths = [
      'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All',
      'modis/terra/MODIS_Terra_Thermal_Anomalies_All',
      'viirs/snpp/VIIRS_SNPP_Thermal_Anomalies_375m_All',
    ];
    
    for (const path of paths) {
      const encodedPath = encodeURIComponent(path);
      
      // First request
      const response1 = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/${encodedPath}`
      );
      const data1 = await response1.json();
      
      expect(data1.success).toBe(true);
      expect(data1.data.path).toBe(path);
      
      // Second request - should be cached
      const response2 = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/${encodedPath}`
      );
      const data2 = await response2.json();
      
      expect(data2.success).toBe(true);
      expect(data2.data.source).toBe('worldview-cached');
      expect(data2.data.summary).toBe(data1.data.summary);
    }
  });

  test('should strip image references from markdown', async ({ request }) => {
    const response = await request.get(
      `${BASE_URL}/api/worldviewmetadata/description/${ENCODED_PATH}`
    );
    
    const data = await response.json();
    
    expect(data.success).toBe(true);
    // Should not contain markdown image syntax
    expect(data.data.summary).not.toMatch(/!\[.*?\]\(.*?\)/);
  });
});

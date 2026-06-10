/**
 * @file worldview-metadata-concurrent.spec.js
 * @description Tests concurrent access to worldview metadata cache
 */

const { test, expect } = require('@playwright/test');

test.describe('WorldviewMetadata Concurrent Access', () => {
  const BASE_URL = process.env.TEST_URL || 'http://localhost:18888';
  const TEST_PATH = 'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All';
  const ENCODED_PATH = encodeURIComponent(TEST_PATH);

  test('should handle 100 concurrent users without duplicate fetches', async ({ request }) => {
    // Create 100 concurrent requests
    const requests = Array.from({ length: 100 }, (_, i) => 
      request.get(`${BASE_URL}/api/worldviewmetadata/description/${ENCODED_PATH}`)
    );
    
    console.log('Sending 100 concurrent requests...');
    const startTime = Date.now();
    
    // Execute all requests in parallel
    const responses = await Promise.all(requests);
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    console.log(`All 100 requests completed in ${duration}ms`);
    
    // Parse all responses
    const data = await Promise.all(responses.map(r => r.json()));
    
    // All requests should succeed
    data.forEach((d, index) => {
      expect(d.success, `Request ${index + 1} should succeed`).toBe(true);
      expect(d.data.summary, `Request ${index + 1} should have summary`).toBeTruthy();
      expect(d.data.path, `Request ${index + 1} should have correct path`).toBe(TEST_PATH);
    });
    
    // All should have the same description
    const firstDescription = data[0].data.summary;
    data.forEach((d, index) => {
      expect(d.data.summary, `Request ${index + 1} should match first description`).toBe(firstDescription);
    });
    
    // Count how many came from cache vs fresh fetch
    const cachedCount = data.filter(d => d.data.source === 'worldview-cached').length;
    const freshCount = data.filter(d => d.data.source === 'worldview').length;
    
    console.log(`Results: ${cachedCount} from cache, ${freshCount} fresh fetches`);
    
    // Should be either:
    // - All from cache (if preloaded), OR
    // - 1 fresh fetch + 99 from cache (if not preloaded, race condition handled)
    expect(freshCount).toBeLessThanOrEqual(1);
    
    if (freshCount === 1) {
      expect(cachedCount).toBe(99);
      console.log('Race condition handled correctly: 1 fetch, 99 cached');
    } else {
      expect(cachedCount).toBe(100);
      console.log('All served from preloaded cache');
    }
  });

  test('should handle 100 concurrent users for multiple different paths', async ({ request }) => {
    const paths = [
      'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All',
      'modis/terra/MODIS_Terra_Thermal_Anomalies_All',
      'viirs/snpp/VIIRS_SNPP_Thermal_Anomalies_375m_All',
    ];
    
    // Create 100 requests (33-34 per path)
    const requests = [];
    for (let i = 0; i < 100; i++) {
      const path = paths[i % paths.length];
      const encodedPath = encodeURIComponent(path);
      requests.push(request.get(`${BASE_URL}/api/worldviewmetadata/description/${encodedPath}`));
    }
    
    console.log('Sending 100 concurrent requests across 3 different paths...');
    const startTime = Date.now();
    
    const responses = await Promise.all(requests);
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    console.log(`All 100 requests completed in ${duration}ms`);
    
    const data = await Promise.all(responses.map(r => r.json()));
    
    // All should succeed
    data.forEach((d, index) => {
      expect(d.success, `Request ${index + 1} should succeed`).toBe(true);
      expect(d.data.summary, `Request ${index + 1} should have summary`).toBeTruthy();
    });
    
    // Group by path and verify consistency
    paths.forEach(path => {
      const pathData = data.filter(d => d.data.path === path);
      expect(pathData.length).toBeGreaterThan(0);
      
      const firstDesc = pathData[0].data.summary;
      pathData.forEach((d, index) => {
        expect(d.data.summary, `Path ${path} request ${index + 1} should match`).toBe(firstDesc);
      });
      
      const cachedCount = pathData.filter(d => d.data.source === 'worldview-cached').length;
      const freshCount = pathData.filter(d => d.data.source === 'worldview').length;
      
      console.log(`Path ${path}: ${cachedCount} cached, ${freshCount} fresh`);
      
      // Each path should have at most 1 fresh fetch
      expect(freshCount).toBeLessThanOrEqual(1);
    });
  });
});

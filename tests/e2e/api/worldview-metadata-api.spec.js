/**
 * @file worldview-metadata-api.spec.js
 * @description Tests for WorldviewMetadata backend API endpoints
 */

const { test, expect } = require('@playwright/test');

test.describe('WorldviewMetadata Backend API', () => {
  const BASE_URL = process.env.TEST_URL || 'http://localhost:18888';

  test.describe('GET /api/worldviewmetadata/description/:path', () => {
    test('should return valid description for MODIS Aqua', async ({ request }) => {
      const path = 'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All';
      const encodedPath = encodeURIComponent(path);
      
      const response = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/${encodedPath}`
      );
      
      expect(response.ok()).toBeTruthy();
      expect(response.status()).toBe(200);
      
      const data = await response.json();
      
      expect(data).toHaveProperty('success', true);
      expect(data).toHaveProperty('data');
      expect(data.data).toHaveProperty('path', path);
      expect(data.data).toHaveProperty('summary');
      expect(data.data).toHaveProperty('source');
      expect(data.data.summary).toBeTruthy();
      expect(typeof data.data.summary).toBe('string');
      expect(data.data.summary.length).toBeGreaterThan(0);
    });

    test('should return valid description for MODIS Terra', async ({ request }) => {
      const path = 'modis/terra/MODIS_Terra_Thermal_Anomalies_All';
      const encodedPath = encodeURIComponent(path);
      
      const response = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/${encodedPath}`
      );
      
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      
      expect(data.success).toBe(true);
      expect(data.data.path).toBe(path);
      expect(data.data.summary).toBeTruthy();
    });

    test('should return valid description for VIIRS SNPP', async ({ request }) => {
      const path = 'viirs/snpp/VIIRS_SNPP_Thermal_Anomalies_375m_All';
      const encodedPath = encodeURIComponent(path);
      
      const response = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/${encodedPath}`
      );
      
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      
      expect(data.success).toBe(true);
      expect(data.data.path).toBe(path);
      expect(data.data.summary).toBeTruthy();
    });

    test('should return 404 for non-existent path', async ({ request }) => {
      const invalidPath = encodeURIComponent('invalid/path/does_not_exist');
      
      const response = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/${invalidPath}`
      );
      
      expect(response.status()).toBe(404);
      const data = await response.json();
      
      expect(data.success).toBe(false);
      expect(data).toHaveProperty('message');
      expect(data.message).toContain('not found');
    });

    test('should handle paths with special characters correctly', async ({ request }) => {
      const path = 'viirs/noaa20/VIIRS_NOAA20_Thermal_Anomalies_375m_All';
      const encodedPath = encodeURIComponent(path);
      
      const response = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/${encodedPath}`
      );
      
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      
      expect(data.success).toBe(true);
      expect(data.data.path).toBe(path);
    });

    test('should return response in reasonable time (< 5 seconds)', async ({ request }) => {
      const path = 'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All';
      const encodedPath = encodeURIComponent(path);
      
      const startTime = Date.now();
      const response = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/${encodedPath}`
      );
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      expect(response.ok()).toBeTruthy();
      expect(duration).toBeLessThan(5000);
    });

    test('should strip markdown image references from description', async ({ request }) => {
      const path = 'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All';
      const encodedPath = encodeURIComponent(path);
      
      const response = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/${encodedPath}`
      );
      
      const data = await response.json();
      
      expect(data.success).toBe(true);
      // Should not contain markdown image syntax ![alt](url)
      expect(data.data.summary).not.toMatch(/!\[.*?\]\(.*?\)/);
    });

    test('should include source indicator (worldview or worldview-cached)', async ({ request }) => {
      const path = 'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All';
      const encodedPath = encodeURIComponent(path);
      
      const response = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/${encodedPath}`
      );
      
      const data = await response.json();
      
      expect(data.success).toBe(true);
      expect(data.data.source).toBeDefined();
      expect(['worldview', 'worldview-cached']).toContain(data.data.source);
    });

    test('should return consistent data structure', async ({ request }) => {
      const path = 'modis/terra/MODIS_Terra_Thermal_Anomalies_All';
      const encodedPath = encodeURIComponent(path);
      
      const response = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/${encodedPath}`
      );
      
      const data = await response.json();
      
      // Verify response structure
      expect(data).toMatchObject({
        success: expect.any(Boolean),
        data: {
          path: expect.any(String),
          summary: expect.any(String),
          source: expect.any(String)
        }
      });
    });

    test('should handle URL-encoded slashes in path', async ({ request }) => {
      const path = 'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All';
      const encodedPath = encodeURIComponent(path);
      
      const response = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/${encodedPath}`
      );
      
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      
      expect(data.success).toBe(true);
      // Path should be decoded correctly
      expect(data.data.path).toBe(path);
      expect(data.data.path).toContain('/');
    });
  });

  test.describe('API Error Handling', () => {
    test('should return proper error for malformed request', async ({ request }) => {
      const response = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/`
      );
      
      // Should return 404 or error
      expect(response.ok()).toBeFalsy();
    });

    test('should handle empty path parameter', async ({ request }) => {
      const response = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/${encodeURIComponent('')}`
      );
      
      expect(response.ok()).toBeFalsy();
    });
  });

  test.describe('API Response Format', () => {
    test('should return JSON content type', async ({ request }) => {
      const path = 'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All';
      const encodedPath = encodeURIComponent(path);
      
      const response = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/${encodedPath}`
      );
      
      expect(response.headers()['content-type']).toContain('application/json');
    });

    test('should return valid JSON that can be parsed', async ({ request }) => {
      const path = 'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All';
      const encodedPath = encodeURIComponent(path);
      
      const response = await request.get(
        `${BASE_URL}/api/worldviewmetadata/description/${encodedPath}`
      );
      
      const text = await response.text();
      
      // Should not throw when parsing
      expect(() => JSON.parse(text)).not.toThrow();
      
      const data = JSON.parse(text);
      expect(data).toBeDefined();
      expect(typeof data).toBe('object');
    });
  });
});

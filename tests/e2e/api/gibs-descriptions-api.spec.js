/**
 * @file gibs-descriptions-api.spec.js
 * @description Tests for GibsDescriptions backend API endpoints
 */

const { test, expect } = require('@playwright/test');
const { loginAsAdmin } = require('../../helpers/auth');

test.describe('GibsDescriptions Backend API', () => {
  const BASE_URL = process.env.TEST_URL || 'http://localhost:18888';
  
  // Setup test mission with worldviewPath layers
  test.beforeAll(async () => {
    const pgPromise = require('pg-promise');
    const { readFileSync } = require('fs');
    const { resolve } = require('path');
    
    const pgp = pgPromise();
    const db = pgp({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASS || '',
      database: 'mmgis-test',
    });
    
    try {
      // Load config from fixture
      const configPath = resolve(process.cwd(), 'tests/fixtures/gibs-descriptions-test-config.json');
      const gibsConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      
      // Insert test mission
      await db.none(
        `INSERT INTO configs (mission, config) 
         VALUES ($1, $2) 
         ON CONFLICT (mission) DO UPDATE SET config = $2`,
        ['GibsDescriptions-Test', JSON.stringify(gibsConfig)]
      );
      
      // Trigger refresh to populate cache
      const { loginAsAdmin } = require('../../helpers/auth');
      const { request } = require('@playwright/test');
      const apiRequest = await request.newContext();
      await loginAsAdmin(apiRequest, BASE_URL);
      
      await apiRequest.post(`${BASE_URL}/api/gibsdescriptions/refresh`);
      
      // Wait for cache to populate
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      await apiRequest.dispose();
    } catch (err) {
      console.error('Failed to setup GibsDescriptions test mission:', err.message);
    } finally {
      await db.$pool.end();
    }
    
    pgp.end();
  });

  test.describe('POST /api/gibsdescriptions/batch', () => {
    test('should return valid response structure for batch request', async ({ request }) => {
      const paths = [
        'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All',
        'modis/terra/MODIS_Terra_Thermal_Anomalies_All'
      ];
      
      const response = await request.post(
        `${BASE_URL}/api/gibsdescriptions/batch`,
        {
          data: { paths }
        }
      );
      
      expect(response.ok()).toBeTruthy();
      expect(response.status()).toBe(200);
      
      const data = await response.json();
      
      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('results');
      expect(typeof data.results).toBe('object');
    });

    test('should handle single path request', async ({ request }) => {
      const paths = ['modis/aqua/MODIS_Aqua_Thermal_Anomalies_All'];
      
      const response = await request.post(
        `${BASE_URL}/api/gibsdescriptions/batch`,
        {
          data: { paths }
        }
      );
      
      const data = await response.json();
      
      expect(data.success).toBe(true);
      expect(data.results).toHaveProperty(paths[0]);
    });

    test('should return results for each requested path', async ({ request }) => {
      const paths = [
        'modis/aqua/MODIS_Aqua_Thermal_Anomalies_All',
        'modis/terra/MODIS_Terra_Thermal_Anomalies_All',
        'viirs/snpp/VIIRS_SNPP_Thermal_Anomalies_375m_All'
      ];
      
      const response = await request.post(
        `${BASE_URL}/api/gibsdescriptions/batch`,
        {
          data: { paths }
        }
      );
      
      const data = await response.json();
      
      expect(data.success).toBe(true);
      
      paths.forEach(path => {
        expect(data.results).toHaveProperty(path);
        expect(data.results[path]).toHaveProperty('success');
      });
    });

    test('should handle empty paths array', async ({ request }) => {
      const response = await request.post(
        `${BASE_URL}/api/gibsdescriptions/batch`,
        {
          data: { paths: [] }
        }
      );
      
      const data = await response.json();
      
      expect(data.success).toBe(true);
      expect(data.results).toEqual({});
    });

    test('should handle invalid path gracefully', async ({ request }) => {
      const paths = ['invalid/path/does_not_exist'];
      
      const response = await request.post(
        `${BASE_URL}/api/gibsdescriptions/batch`,
        {
          data: { paths }
        }
      );
      
      const data = await response.json();
      
      expect(data.success).toBe(true);
      expect(data.results).toHaveProperty(paths[0]);
      expect(data.results[paths[0]]).toHaveProperty('success');
    });

    test('should return JSON content type', async ({ request }) => {
      const paths = ['modis/aqua/MODIS_Aqua_Thermal_Anomalies_All'];
      
      const response = await request.post(
        `${BASE_URL}/api/gibsdescriptions/batch`,
        {
          data: { paths }
        }
      );
      
      expect(response.headers()['content-type']).toContain('application/json');
    });

    test('should handle missing paths parameter', async ({ request }) => {
      const response = await request.post(
        `${BASE_URL}/api/gibsdescriptions/batch`,
        {
          data: {}
        }
      );
      
      expect(response.status()).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
    });

    test('should handle malformed request body', async ({ request }) => {
      const response = await request.post(
        `${BASE_URL}/api/gibsdescriptions/batch`,
        {
          data: { paths: 'not-an-array' }
        }
      );
      
      expect(response.status()).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
    });
  });

  test.describe('GET /api/gibsdescriptions/stats (Admin Only)', () => {
    test('should return stats structure when authenticated as admin', async ({ request }) => {
      await loginAsAdmin(request);
      
      const response = await request.get(
        `${BASE_URL}/api/gibsdescriptions/stats`
      );
      
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('cached');
      expect(data.data).toHaveProperty('inFlight');
      expect(data.data).toHaveProperty('failed');
      expect(typeof data.data.cached).toBe('number');
      expect(typeof data.data.inFlight).toBe('number');
      expect(typeof data.data.failed).toBe('number');
    });

    test('should reject non-admin requests', async ({ request }) => {
      const response = await request.get(
        `${BASE_URL}/api/gibsdescriptions/stats`
      );
      
      // MMGIS ensureAdmin() returns JSON error
      expect(response.status()).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('failure');
      expect(data.message).toContain('Unauthorized');
    });
  });

  test.describe('GET /api/gibsdescriptions/list (Admin Only)', () => {
    test('should return list structure when authenticated as admin', async ({ request }) => {
      await loginAsAdmin(request);
      
      const response = await request.get(
        `${BASE_URL}/api/gibsdescriptions/list`
      );
      
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      
      expect(data.success).toBe(true);
      expect(data.paths).toBeDefined();
      expect(Array.isArray(data.paths)).toBe(true);
    });

    test('should reject non-admin requests', async ({ request }) => {
      const response = await request.get(
        `${BASE_URL}/api/gibsdescriptions/list`
      );
      
      // MMGIS ensureAdmin() returns JSON error
      expect(response.status()).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('failure');
      expect(data.message).toContain('Unauthorized');
    });
  });

  test.describe('POST /api/gibsdescriptions/refresh (Admin Only)', () => {
    test('should accept refresh request from admin', async ({ request }) => {
      await loginAsAdmin(request);
      
      const response = await request.post(
        `${BASE_URL}/api/gibsdescriptions/refresh`
      );
      
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      
      expect(data.success).toBe(true);
      expect(data.message).toBeDefined();
    });

    test('should reject non-admin refresh requests', async ({ request }) => {
      const response = await request.post(
        `${BASE_URL}/api/gibsdescriptions/refresh`
      );
      
      // MMGIS ensureAdmin() returns JSON error
      expect(response.status()).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('failure');
      expect(data.message).toContain('Unauthorized');
    });
  });
});

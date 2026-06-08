import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client.js';

/**
 * Tests for CMR (Common Metadata Repository) API integration.
 *
 * Tests the backend endpoint that queries NASA's CMR API to fetch
 * collection metadata (ID, short name, version, title, summary, DOI).
 *
 * These tests require admin authentication since the CMR endpoint
 * is protected by the ensureAdmin middleware.
 */

test.describe('CMR API', () => {
  // Run serially: tests share the same admin account session
  test.describe.configure({ mode: 'serial' });

  test('GET /api/cmr/collection/:conceptId returns valid CMR metadata for SMAP', async ({ request }) => {
    const api = await ApiClient.authenticated(request, {
      username: 'test_admin',
      password: 'TestAdmin1!'
    });

    const res = await api.getCMRCollection('C3480440870-NSIDC_CPRD');
    const data = await res.json();

    expect(res.ok()).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data.id).toBe('C3480440870-NSIDC_CPRD');
    expect(data.data.shortName).toBe('SPL4SMGP');
    expect(data.data.versionId).toBe('008');
    expect(data.data.title).toBeTruthy();
    expect(data.data.summary).toBeTruthy();
  });

  test('GET /api/cmr/collection/:conceptId returns valid CMR metadata for MODIS Aqua', async ({ request }) => {
    const api = await ApiClient.authenticated(request, {
      username: 'test_admin',
      password: 'TestAdmin1!'
    });

    const res = await api.getCMRCollection('C2565794060-LPCLOUD');
    const data = await res.json();

    expect(res.ok()).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data.id).toBe('C2565794060-LPCLOUD');
    expect(data.data.shortName).toBe('MYD14A2');
    expect(data.data.title).toBe('MODIS/Aqua Thermal Anomalies/Fire 8-Day L3 Global 1km SIN Grid V061');
    expect(data.data.summary).toBeTruthy();
  });

  test('GET /api/cmr/collection/:conceptId returns valid CMR metadata for MODIS Terra', async ({ request }) => {
    const api = await ApiClient.authenticated(request, {
      username: 'test_admin',
      password: 'TestAdmin1!'
    });

    const res = await api.getCMRCollection('C2565791018-LPCLOUD');
    const data = await res.json();

    expect(res.ok()).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data.id).toBe('C2565791018-LPCLOUD');
    expect(data.data.shortName).toBe('MOD14A2');
    expect(data.data.title).toBe('MODIS/Terra Thermal Anomalies/Fire 8-Day L3 Global 1km SIN Grid V061');
    expect(data.data.summary).toBeTruthy();
  });

  test('GET /api/cmr/collection/:conceptId returns valid CMR metadata for VIIRS SNPP', async ({ request }) => {
    const api = await ApiClient.authenticated(request, {
      username: 'test_admin',
      password: 'TestAdmin1!'
    });

    const res = await api.getCMRCollection('C2545314536-LPCLOUD');
    const data = await res.json();

    expect(res.ok()).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data.id).toBe('C2545314536-LPCLOUD');
    expect(data.data.shortName).toBe('VNP14');
    expect(data.data.title).toBe('VIIRS/NPP Thermal Anomalies/Fire 6-Min L2 Swath 750m V002');
    expect(data.data.summary).toBeTruthy();
  });

  test('GET /api/cmr/collection/:conceptId returns valid CMR metadata for VIIRS NOAA-20', async ({ request }) => {
    const api = await ApiClient.authenticated(request, {
      username: 'test_admin',
      password: 'TestAdmin1!'
    });

    const res = await api.getCMRCollection('C2545310874-LPCLOUD');
    const data = await res.json();

    expect(res.ok()).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data.id).toBe('C2545310874-LPCLOUD');
    expect(data.data.shortName).toBe('VJ114A1');
    expect(data.data.title).toBe('VIIRS/JPSS1 Thermal Anomalies and Fire Daily L3 Global 1km SIN Grid V002');
    expect(data.data.summary).toBeTruthy();
  });

  test('GET /api/cmr/collection/:conceptId returns valid CMR metadata for VIIRS NOAA-21', async ({ request }) => {
    const api = await ApiClient.authenticated(request, {
      username: 'test_admin',
      password: 'TestAdmin1!'
    });

    const res = await api.getCMRCollection('C2830534683-LPCLOUD');
    const data = await res.json();

    expect(res.ok()).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data.id).toBe('C2830534683-LPCLOUD');
    expect(data.data.shortName).toBe('VJ214A1');
    expect(data.data.title).toBe('VIIRS/JPSS2 Thermal Anomalies and Fire Daily L3 Global 1km SIN Grid V002');
    expect(data.data.summary).toBeTruthy();
  });
});
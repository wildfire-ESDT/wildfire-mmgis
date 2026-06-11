/*****************************************************************************
 * GIBS Layer Description Cache
 * 
 * Manages in-memory cache of GIBS layer descriptions from NASA Worldview GitHub.
 *****************************************************************************/

const Config = require("../../../Backend/Config/models/config");

const DEBUG = true;

const WORLDVIEW_BASE_URL = "https://raw.githubusercontent.com/nasa-gibs/worldview/main/config/default/common/config/metadata/layers";
const FETCH_TIMEOUT_MS = 15000;
const FETCH_CONCURRENCY = 5;
const MISSION_FILTER = process.env.GIBS_MISSION_FILTER; // Optional: filter to specific mission (e.g., "Wildfire")

// State
const descriptions = new Map();
const failedCache = new Map();
const inFlightRequests = new Map();
let syncAllInFlight = null;
let lastError = null;

// --- Validation ----

function isValidPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 256) {
    return false;
  }
  // Only allow safe characters
  if (!/^[a-zA-Z0-9_\-\/]+$/.test(path)) {
    return false;
  }
  // Prevent path traversal
  if (path.includes('..')) {
    return false;
  }
  // No absolute paths
  if (path.startsWith('/')) {
    return false;
  }
  return true;
}

// --- Fetch with Timeout ---

async function fetchWithTimeout(url, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  
  try {
    const response = await fetch(url, {
      signal: ctrl.signal,
      headers: { 
        'User-Agent': 'MMGIS-GibsDescriptions'
      }
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// --- Concurrency Pool ---

async function pool(items, limit, worker) {
  const results = [];
  let index = 0;
  
  const runners = new Array(Math.min(limit, items.length || 0))
    .fill(0)
    .map(async () => {
      while (index < items.length) {
        const idx = index++;
        results[idx] = await worker(items[idx], idx);
      }
    });
  
  await Promise.all(runners);
  return results;
}

// --- Path Extraction ---

function extractPaths(config) {
  const paths = new Set();
  
  function walk(node, depth) {
    if (node == null || depth > 64) return;
    
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, depth + 1);
      }
      return;
    }
    
    if (typeof node === 'object') {
      // Look for worldviewPath field
      if (typeof node.worldviewPath === 'string') {
        paths.add(node.worldviewPath);
      }
      // Recurse into all properties
      for (const key in node) {
        walk(node[key], depth + 1);
      }
    }
  }
  
  walk(config, 0);
  return paths;
}

// --- Description Fetching ---

async function fetchDescription(path) {
  if (!isValidPath(path)) {
    if (DEBUG) console.log(`GibsDescriptions: Invalid path: "${path}"`);
    return null;
  }
  // Some robutness doesn't hurt.
  if (failedCache.has(path)) {
    const failedAt = failedCache.get(path);
    if (Date.now() - failedAt < 5 * 60 * 1000) {
      if (DEBUG) console.log(`GibsDescriptions: Skipping recently failed path: ${path}`);
      return null;
    }
  }
  // We don't want to fetch the same path multiple times
  if (inFlightRequests.has(path)) {
    return await inFlightRequests.get(path);
  }
  
  const url = `${WORLDVIEW_BASE_URL}/${path}.md`;
  
  const fetchPromise = (async () => {
    try {
      const response = await fetchWithTimeout(url);
      
      if (!response.ok) {
        failedCache.set(path, Date.now());
        if (DEBUG) console.log(`GibsDescriptions: HTTP ${response.status} for ${path}`);
        return null;
      }
      
      const markdown = await response.text();
      // Removes trailing whitespace so we get nice looknig descriptions.
      const cleaned = markdown.trim()
      
      const entry = {
        markdown: cleaned,
        path: path,
        fetchedAt: Date.now()
      };
      
      descriptions.set(path, entry);
      failedCache.delete(path);
      
      return entry;
    } catch (error) {
      failedCache.set(path, Date.now());
      console.error(`GibsDescriptions: Failed to fetch "${path}": ${error.message}`);
      return descriptions.get(path) || null; // Keep existing entry on failure
    } finally {
      inFlightRequests.delete(path);
    }
  })();
  
  inFlightRequests.set(path, fetchPromise);
  return await fetchPromise;
}

// --- Sync Operations ---

async function syncPaths(paths, { force = false } = {}) {
  const validPaths = [...new Set(paths)].filter(isValidPath);
  const missing = force ? validPaths : validPaths.filter(p => !descriptions.has(p));
  
  if (missing.length === 0) {
    return {
      requested: validPaths.length,
      attempted: 0,
      fetched: 0,
      cached: descriptions.size
    };
  }
  
  let fetched = 0;
  
  await pool(missing, FETCH_CONCURRENCY, async (path) => {
    const before = descriptions.get(path);
    const after = await fetchDescription(path);
    if (after && after !== before) {
      fetched++;
    }
  });
  
  return {
    requested: validPaths.length,
    attempted: missing.length,
    fetched,
    cached: descriptions.size
  };
}

async function syncAll({ force = false } = {}) {
  if (syncAllInFlight) {
    return syncAllInFlight;
  }
  
  syncAllInFlight = (async () => {
    try {
      if (DEBUG) console.log('GibsDescriptions: Starting full sync...');
      
      let configs = await Config.findAll({
        attributes: ['config', 'mission', 'version']
      });
      
      // If set in ENV, filter to specific mission (e.g., "Wildfire")
      if (MISSION_FILTER) {
        configs = configs.filter(c => c.mission === MISSION_FILTER);
        if (DEBUG) console.log(`GibsDescriptions: Filtering to mission "${MISSION_FILTER}"`);
      }
      
      // Group by mission, keep only latest version
      const latestConfigs = {};
      configs.forEach(configRecord => {
        const mission = configRecord.mission;
        const version = configRecord.version;
        
        if (!latestConfigs[mission] || latestConfigs[mission].version < version) {
          latestConfigs[mission] = configRecord;
        }
      });
      
      // Extract all referenced worldviewPaths
      const referenced = new Set();
      Object.values(latestConfigs).forEach(configRecord => {
        const config = configRecord.config;
        if (config) {
          for (const path of extractPaths(config)) {
            referenced.add(path);
          }
        }
      });
      
      if (DEBUG) console.log(`GibsDescriptions: Found ${referenced.size} referenced paths`);
      
      // Fetch missing descriptions (or all if an admin triggers a refresh)
      const result = await syncPaths([...referenced], { force });
      
      // Prune descriptions no longer referenced by any config.
      let pruned = 0;
      for (const key of descriptions.keys()) {
        if (!referenced.has(key)) {
          descriptions.delete(key);
          pruned++;
        }
      }
      
      lastError = null;
      
      if (DEBUG) {
        console.log(
          `GibsDescriptions: Sync complete - ${referenced.size} referenced, ` +
          `${result.fetched} fetched, ${pruned} pruned, ${descriptions.size} cached`
        );
      }
      
      return { ...result, pruned };
    } catch (error) {
      lastError = String(error && error.message ? error.message : error);
      console.error('GibsDescriptions: syncAll failed:', lastError);
      return null;
    } finally {
      syncAllInFlight = null;
    }
  })();
  
  return syncAllInFlight;
}

// --- Public Read Accessors ---

function get(path) {
  if (!isValidPath(path)) return null;
  return descriptions.get(path) || null;
}

function stats() {
  return {
    cached: descriptions.size,
    inFlight: inFlightRequests.size,
    failed: failedCache.size,
    lastError
  };
}

function listPaths() {
  return [...descriptions.keys()];
}

module.exports = {
  // Sync operations
  syncAll,
  syncPaths,
  
  // Read operations
  get,
  stats,
  listPaths,
  
  // Exported for tests
  extractPaths,
  isValidPath
};

/*****************************************************************************
 * WorldviewMetadata Routes
 * 
 * Fetches layer descriptions from NASA Worldview's GitHub repository.
 * Descriptions are cached in memory and auto-refresh on config changes.
 *****************************************************************************/
const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const { rateLimit } = require('express-rate-limit');

const DEBUG = true; // Set to true to enable debug logging

const WORLDVIEW_BASE_URL = "https://raw.githubusercontent.com/nasa-gibs/worldview/main/config/default/common/config/metadata/layers";

// In-memory cache for descriptions
const descriptionCache = new Map();
// Track in-flight requests to prevent duplicate fetches
const inFlightRequests = new Map();
// Track failed requests to avoid retry storms
const failedCache = new Map();

// Rate limiter for batch endpoint (60 req/min per IP)
const batchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 batch requests per minute per IP
  message: { success: false, message: 'Rate limit exceeded.' }
});

async function fetchWorldviewDescription(worldviewPath) {
  // Check if recently failed (don't retry for 5 minutes)
  if (failedCache.has(worldviewPath)) {
    const failedAt = failedCache.get(worldviewPath);
    if (Date.now() - failedAt < 5 * 60 * 1000) {
      if (DEBUG) console.log(`WorldviewMetadata: Skipping recently failed path: ${worldviewPath}`);
      return null;
    }
  }
  
  // Check if already fetching
  if (inFlightRequests.has(worldviewPath)) {
    return await inFlightRequests.get(worldviewPath);
  }
  
  const worldviewUrl = `${WORLDVIEW_BASE_URL}/${worldviewPath}.md`;
  
  // Create promise and store it
  const fetchPromise = (async () => {
    try {
      const response = await fetch(worldviewUrl);
      
      if (!response.ok) {
        failedCache.set(worldviewPath, Date.now());
        return null;
      }
      
      const markdown = await response.text();
      const description = markdown.trim().replace(/!\[.*?\]\(.*?\)/g, '');
      
      // Remove from failed cache if it was there
      failedCache.delete(worldviewPath);
      
      return description;
    } catch (error) {
      console.error(`Failed to fetch worldview description for ${worldviewPath}:`, error.message);
      failedCache.set(worldviewPath, Date.now());
      return null;
    } finally {
      // Clean up in-flight request
      inFlightRequests.delete(worldviewPath);
    }
  })();
  
  inFlightRequests.set(worldviewPath, fetchPromise);
  return await fetchPromise;
}

// Validate worldview path format
function isValidWorldviewPath(path) {
  // Only allow alphanumeric, hyphens, underscores, and forward slashes
  if (!/^[a-zA-Z0-9_\-\/]+$/.test(path)) {
    return false;
  }
  
  // Prevent path traversal
  if (path.includes('..')) {
    return false;
  }
  
  // Reasonable length limit
  if (path.length > 200) {
    return false;
  }
  
  return true;
}

// POST /api/worldviewmetadata/descriptions/batch
// Get multiple descriptions in one request (rate limited to 60/min per IP)
router.post("/descriptions/batch", batchLimiter, express.json(), async (req, res) => {
  const { paths } = req.body;
  
  if (!Array.isArray(paths)) {
    return res.status(400).json({
      success: false,
      message: "paths must be an array"
    });
  }
  
  if (paths.length > 200) {
    return res.status(400).json({
      success: false,
      message: "Maximum 200 paths per batch request"
    });
  }
  
  const results = {};
  
  for (const path of paths) {
    // Validate each path
    if (!isValidWorldviewPath(path)) {
      results[path] = {
        success: false,
        message: "Invalid path format"
      };
      continue;
    }
    
    // Check cache
    if (descriptionCache.has(path)) {
      results[path] = {
        success: true,
        data: {
          summary: descriptionCache.get(path),
          source: "worldview-cached",
          path: path
        }
      };
    } else {
      results[path] = {
        success: false,
        message: "Not in cache"
      };
    }
  }
  
  res.json({
    success: true,
    results: results
  });
});

// GET /api/worldviewmetadata/cache/stats
// Public endpoint - no auth required (read-only)
router.get("/cache/stats", (req, res) => {
  res.json({
    success: true,
    data: {
      cached: descriptionCache.size,
      inFlight: inFlightRequests.size,
      failed: failedCache.size
    }
  });
});

module.exports = router;
module.exports.descriptionCache = descriptionCache;
module.exports.fetchWorldviewDescription = fetchWorldviewDescription;
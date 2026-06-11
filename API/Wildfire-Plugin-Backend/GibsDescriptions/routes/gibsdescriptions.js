/*****************************************************************************
 * GIBS Descriptions Routes
 * 
 * API endpoints for reading cached GIBS layer descriptions.
 * 
 * Public routes (no authentication required):
 *   POST /batch     - Get multiple descriptions (cache-only, no GitHub fetch)
 * 
 * Admin routes (ensureAdmin):
 *   GET  /stats     - Cache statistics
 *   GET  /list      - List all cached paths
 *   POST /refresh   - Force full cache rebuild (fetches from GitHub)
 * 
 * The batch endpoint is safe to expose publicly because:
 * - Cache-only (no outbound fetches to GitHub)
 * - Read-only (no data modification)
 * - Rate limited by global MMGIS limiter (20k/5min)
 * - Descriptions are public NASA data from Worldview GitHub
 * 
 * Stats and list are admin-only to prevent information disclosure.
 *****************************************************************************/

const express = require("express");
const gibs = require("../processes/gibsCache");

const router = express.Router();

router.post("/batch", express.json(), async (req, res) => {
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
    const entry = gibs.get(path);
    
    if (entry) {
      results[path] = {
        success: true,
        data: {
          summary: entry.markdown,
          source: "gibs-cached",
          path: path,
          fetchedAt: entry.fetchedAt
        }
      };
    } else {
      results[path] = {
        success: false,
        message: "Not in cache"
      };
    }
  }
  
  return res.json({
    success: true,
    results: results
  });
});

const adminRouter = express.Router();

adminRouter.get("/stats", (req, res) => {
  return res.json({
    success: true,
    data: gibs.stats()
  });
});

adminRouter.get("/list", (req, res) => {
  return res.json({
    success: true,
    paths: gibs.listPaths()
  });
});

adminRouter.post("/refresh", async (req, res) => {
  console.log('GibsDescriptions: Manual refresh requested by admin');
  
  gibs.syncAll({ force: true })
    .catch(err => console.error('GibsDescriptions: Manual refresh failed:', err));
  
  return res.json({
    success: true,
    message: "Refresh started",
    stats: gibs.stats()
  });
});

module.exports = { router, adminRouter };

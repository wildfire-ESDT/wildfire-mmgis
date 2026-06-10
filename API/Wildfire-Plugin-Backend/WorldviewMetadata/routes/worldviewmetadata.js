/*****************************************************************************
 * WorldviewMetadata Routes
 * 
 * Fetches layer descriptions from NASA Worldview's GitHub repository.
 * Descriptions are cached in memory on server start.
 *****************************************************************************/
const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");

const WORLDVIEW_BASE_URL = "https://raw.githubusercontent.com/nasa-gibs/worldview/main/config/default/common/config/metadata/layers";

// In-memory cache for descriptions
const descriptionCache = new Map();
// Track in-flight requests to prevent duplicate fetches
const inFlightRequests = new Map();

async function fetchWorldviewDescription(worldviewPath) {
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
        return null;
      }
      
      const markdown = await response.text();
      const description = markdown.trim().replace(/!\[.*?\]\(.*?\)/g, '');
      return description;
    } catch (error) {
      console.error(`Failed to fetch worldview description for ${worldviewPath}:`, error.message);
      return null;
    } finally {
      // Clean up in-flight request
      inFlightRequests.delete(worldviewPath);
    }
  })();
  
  inFlightRequests.set(worldviewPath, fetchPromise);
  return await fetchPromise;
}

router.get("/description/:encodedPath", async (req, res) => {
  const encodedPath = req.params.encodedPath;
  
  if (!encodedPath) {
    return res.status(400).json({ 
      success: false, 
      message: "encodedPath parameter is required"
    });
  }
  
  const worldviewPath = decodeURIComponent(encodedPath);
  
  // Check cache first
  if (descriptionCache.has(worldviewPath)) {
    console.log(`WorldviewMetadata: Cache HIT for ${worldviewPath}`);
    return res.json({
      success: true,
      data: {
        summary: descriptionCache.get(worldviewPath),
        source: "worldview-cached",
        path: worldviewPath
      }
    });
  }
  
  // Check if already fetching (race condition handling)
  if (inFlightRequests.has(worldviewPath)) {
    console.log(`WorldviewMetadata: Waiting for in-flight request: ${worldviewPath}`);
    const description = await inFlightRequests.get(worldviewPath);
    
    if (description) {
      return res.json({
        success: true,
        data: {
          summary: description,
          source: "worldview-cached",
          path: worldviewPath
        }
      });
    } else {
      return res.status(404).json({
        success: false, 
        message: `Worldview description not found for ${worldviewPath}`
      });
    }
  }
  
  console.log(`WorldviewMetadata: Cache MISS - Fetching from GitHub: ${worldviewPath}`);
  
  // Fallback: fetch on-demand if not in cache
  const description = await fetchWorldviewDescription(worldviewPath);
  
  if (description) {
    descriptionCache.set(worldviewPath, description);
    console.log(`WorldviewMetadata: Fetched and cached ${worldviewPath}`);
    return res.json({
      success: true,
      data: {
        summary: description,
        source: "worldview",
        path: worldviewPath
      }
    });
  } else {
    console.log(`WorldviewMetadata: Not found in GitHub: ${worldviewPath}`);
    return res.status(404).json({
      success: false, 
      message: `Worldview description not found for ${worldviewPath}`
    });
  }
});

module.exports = router;
module.exports.descriptionCache = descriptionCache;
module.exports.fetchWorldviewDescription = fetchWorldviewDescription;
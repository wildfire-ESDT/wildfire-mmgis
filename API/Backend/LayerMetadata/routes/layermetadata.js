/***********************************************************
 * JavaScript syntax format: ES5/ES6 - ECMAScript 2015
 * Loading all required dependencies, libraries and packages
 * 
 * Fetches layer descriptions from NASA Worldview's GitHub repository
 * 
 * Endpoint accepts a worldviewPath parameter which is the relative path
 * to the metadata file in Worldview's repository
 * Example: modis/aqua/MODIS_Aqua_Thermal_Anomalies_All
 **********************************************************/
const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");

const WORLDVIEW_BASE_URL = "https://raw.githubusercontent.com/nasa-gibs/worldview/main/config/default/common/config/metadata/layers";

router.get("/description/:encodedPath", (req, res) => {
  const encodedPath = req.params.encodedPath;
  
  if (!encodedPath) {
    return res.status(400).json({ 
      success: false, 
      message: "encodedPath parameter is required" 
    });
  }
  
  // Decode the URL-encoded path
  const worldviewPath = decodeURIComponent(encodedPath);
  
  // Construct the full URL to the Worldview metadata file
  const worldviewUrl = `${WORLDVIEW_BASE_URL}/${worldviewPath}.md`;
  
  fetch(worldviewUrl)
    .then((response) => {
      if (!response.ok) {
        return res.status(response.status).json({ 
          success: false, 
          message: `Worldview GitHub returned ${response.status} for ${worldviewUrl}` 
        });
      }
      return response.text();
    })
    .then((markdown) => {
      // Return the markdown description
      return res.json({
        success: true,
        data: {
          summary: markdown.trim(),
          source: "worldview",
          path: worldviewPath
        }
      });
    })
    .catch((error) => {
      res.status(500).json({ 
        success: false, 
        message: error.message || "Error fetching description from Worldview GitHub" 
      });
    });
});

module.exports = router;
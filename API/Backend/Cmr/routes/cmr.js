/***********************************************************
 * JavaScript syntax format: ES5/ES6 - ECMAScript 2015
 * Loading all required dependencies, libraries and packages
 **********************************************************/
const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");

function extractDOI(links) {
  if (!links || !Array.isArray(links)) return null;
  
  const doiLink = links.find(link => 
    link.rel && link.rel.includes("metadata") && 
    link.hreflang === "en-US" &&
    link.href.includes("doi.org")
  );
  
  return doiLink ? doiLink.href : null;
}

router.get("/collection/:conceptId", (req, res) => {
  const conceptId = req.params.conceptId;
  
  const cmrUrl = `https://cmr.earthdata.nasa.gov/search/collections.json?concept_id=${conceptId}`;
  
  fetch(cmrUrl)
    .then((response) => {
      if (!response.ok) {
        return res.status(response.status).json({ 
          success: false, 
          message: `CMR API returned ${response.status}` 
        });
      }
      return response.json();
    })
    .then((data) => {
      if (data.feed && data.feed.entry && data.feed.entry[0]) {
        const collection = data.feed.entry[0];
        
        return res.json({
          success: true,
          data: {
            id: collection.id,
            shortName: collection.short_name,
            versionId: collection.version_id,
            title: collection.title,
            summary: collection.summary,
            doi: extractDOI(collection.links)
          }
        });
      }
      
      return res.status(404).json({ success: false, message: "Collection not found" });
    })
    .catch((error) => {
      res.status(500).json({ success: false, message: error.message || "Error contacting CMR API" });
    });
});

module.exports = router;
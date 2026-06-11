/*****************************************************************************
 * GIBS Descriptions Plugin Setup
 * 
 * Fetches GIBS layer descriptions from NASA Worldview GitHub repository.
 * 
 * Features:
 * - In-memory cache shared across all users
 * - Diff-sync: only fetches new descriptions, prunes deleted ones
 * - Concurrency control: fetches 5 descriptions at once
 * - Timeout protection: 15 second timeout per fetch
 * - WebSocket auto-refresh: updates cache when configs change
 * - Manual refresh: admin-only endpoint to force rebuild
 * 
 * Config field: worldviewPath (e.g., "modis/aqua/MODIS_Aqua")
 *****************************************************************************/

const routes = require("./routes/gibsdescriptions");
const gibs = require("./processes/gibsCache");
const WebSocket = require('isomorphic-ws');

const DEBUG = false;

let setup = {
  // Once the app initializes: mount routes
  onceInit: (s) => {
    const base = s.ROOT_PATH + "/api/gibsdescriptions";
    
    // Public routes: no authentication required (cache reads only, no GitHub I/O)
    // Safe to expose publicly because:
    // - Cache-only (no outbound fetches)
    // - Read-only (no data modification)
    // - Rate limited by global MMGIS limiter (20k/5min)
    // - Descriptions are public NASA data
    s.app.use(
      base,
      s.checkHeadersCodeInjection,
      s.setContentType,
      routes.router
    );
    
    // Admin routes: admin-only (can trigger GitHub fetches)
    s.app.use(
      base,
      s.ensureAdmin(),
      s.checkHeadersCodeInjection,
      s.setContentType,
      routes.adminRouter
    );
  },
  
  // Once the server starts: connect to WebSocket for auto-refresh
  onceStarted: (s) => {
    if (process.env.ENABLE_MMGIS_WEBSOCKETS === "true") {
      const port = parseInt(process.env.PORT || "8888", 10);
      const protocol = process.env.HTTPS == "true" ? "wss" : "ws";
      const path = `${protocol}://127.0.0.1:${port}${process.env.WEBSOCKET_ROOT_PATH || process.env.ROOT_PATH || ""}/`;
      
      try {
        const ws = new WebSocket(path);
        
        ws.on('message', async (data) => {
          try {
            const message = JSON.parse(data);
            
            if (message.body?.config === true) {
              if (DEBUG) console.log('GibsDescriptions: Config changed via WebSocket, syncing cache...');
              await gibs.syncAll();
            }
          } catch (err) {
          }
        });
        
        ws.on('error', (err) => {
          console.error('GibsDescriptions: WebSocket error:', err.message);
        });
        
        if (DEBUG) console.log('GibsDescriptions: Connected to WebSocket for auto-refresh');
      } catch (err) {
        console.error('GibsDescriptions: Failed to connect to WebSocket:', err.message);
      }
    }
  },
  
  // Once all tables sync: do initial cache build
  // Fire-and-forget: never block server startup on GitHub
  onceSynced: (s) => {
    gibs.syncAll()
      .catch(err => console.error('GibsDescriptions: Initial sync failed:', err));
  },
};

module.exports = setup;

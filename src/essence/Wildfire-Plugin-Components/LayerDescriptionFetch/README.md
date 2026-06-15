# LayerDescriptionFetch

On page load, fetches markdown descriptions for all layers that have a `descriptionMarkdownUrl` field set in their configuration. Fetched content overwrites `layer.description` in memory. If a fetch fails, the existing `description` from the config is used as a fallback.

All fetches run concurrently via `Promise.all` and rely on the browser's HTTP cache to avoid redundant network requests on repeat visits.

## Setup

The server auto-discovers this plugin via the `config.json` in this directory on startup. The plugin directory must live under `src/essence/Wildfire-Plugin-Components/` (or another `*Plugin-Components*` directory) for the server to find it.

To enable it for a mission, add the following to the `components` array in the mission `config.json`:

```json
{
  "name": "LayerDescriptionFetch",
  "js": "LayerDescriptionFetch",
  "on": true,
  "variables": {}
}
```

## Configure Page Integration

The `descriptionMarkdownUrl` field is added to the layer metaconfig (`configure/src/metaconfigs/layer-tile-config.json`) so it appears in the Configure page under each layer's Description section. A sync icon button next to the field fetches the markdown from the URL and populates the `description` field below it. Saving the config stores the fetched description as the offline fallback.

## Layer Setup

In the Configure page, set the `descriptionMarkdownUrl` field on any layer to a valid HTTPS URL pointing to a `.md` file. Click the sync icon to preview and store the description. The stored `description` serves as the offline fallback if the URL is unreachable at runtime.

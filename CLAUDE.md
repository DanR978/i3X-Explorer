# i3X Explorer Project

## Overview

i3X Explorer is a cross-platform desktop application for browsing and monitoring I3X (Industrial Information Interface eXchange) API servers. Similar to MQTT Explorer but for the I3X protocol.

**Stack:** Electron + React + TypeScript + Vite + Tailwind CSS

## Project Structure

```
i3x-explorer/
├── electron/                # Electron main process
│   ├── main.ts             # App entry, window management
│   └── preload.cjs         # Context bridge for IPC (CommonJS, loaded by Electron)
├── src/                    # React renderer
│   ├── main.tsx            # React entry
│   ├── App.tsx             # Root component
│   ├── api/                # I3X API client
│   │   ├── client.ts       # HTTP client (fetch-based)
│   │   ├── types.ts        # TypeScript interfaces
│   │   └── subscription.ts # SSE subscription handler
│   ├── components/         # UI components
│   │   ├── layout/         # Toolbar, Sidebar, MainPanel, StatusBar
│   │   ├── main/           # Home shell, element detail, tabs, breadcrumb
│   │   ├── graph/          # Relationships tab: DirectRelationships (list), RelationshipGraph (depth-N map)
│   │   ├── tree/           # TreeView for hierarchy browsing
│   │   ├── details/        # Namespace/ObjectType detail, ValueDisplay, ElementStatus
│   │   ├── connection/     # ConnectionDialog
│   │   └── subscriptions/  # SubscriptionTransport, SubscriptionsDrawer/View, TrendView
│   ├── stores/             # Zustand state management
│   │   ├── connection.ts   # Server connection state
│   │   ├── explorer.ts     # Tree/selection state
│   │   └── subscriptions.ts# Active subscriptions & live values
│   └── styles/             # Tailwind CSS
├── build/                  # Build resources (icons, entitlements)
├── scripts/                # Build helper scripts
├── release/                # Built installers (not in git)
├── electron-builder.json   # Packaging configuration
├── package.json
├── vite.config.ts
└── tailwind.config.js
```

## Development

```bash
# Prerequisites: Node.js 18+ (project has .nvmrc file)
nvm use

# Install dependencies
npm install

# Run in development mode (with hot reload)
npm run dev

# Type checking (covers src/ AND electron/ + vite configs, two tsc projects)
npm run typecheck

# Lint (ESLint 9 flat config, eslint.config.js; exhaustive-deps is an error)
npm run lint

# Unit tests (vitest, standalone vitest.config.ts; *.test.ts alongside sources)
npm test
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, test, and a `build:vite` smoke on every push and PR.

## Building Installers

**Important:** Use Node.js 18+ before building. The project includes an `.nvmrc` file.

```bash
# First, switch to the correct Node version
nvm use 20  # or: nvm use (if .nvmrc is configured)

# Generate icons (uses build/icon-1024.png by default)
./scripts/generate-icons.sh

# Build for all platforms (best way, recommended for releases)
./scripts/build-all.sh [mac|win|linux|web|all]

# Platform-specific builds
npm run build:all          # All
npm run build:mac          # macOS (Intel + Apple Silicon)
npm run build:mac:x64      # macOS Intel only
npm run build:mac:arm64    # macOS Apple Silicon only
npm run build:win          # Windows (x64 + x86 + portable)
npm run build:linux        # Linux (AppImage + tar.gz)
npm run build:web          # Web (static files → dist-web/, zip → release/{version}/)
```

### macOS Notarization

For notarized macOS builds (required to avoid "app is damaged" on Apple Silicon downloads), create `scripts/set-apple-vars.sh` (git-ignored) with:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"  # from appleid.apple.com
export APPLE_TEAM_ID="XXXXXXXXXX"                          # from developer.apple.com/account
```

Also requires a **Developer ID Application** certificate (not "Mac Installer Distribution") in the keychain — create via Xcode → Settings → Accounts → Manage Certificates.

`build-all.sh` sources this file automatically. If absent or vars unset, the build completes unsigned with a warning. Notarization logic lives in `scripts/notarize.cjs` (afterSign hook).

### Windows Signing

Windows signing uses **Azure Trusted Signing** (Microsoft-managed CA, ~$10/month). It fully suppresses the SmartScreen "Unknown publisher" warning. Signing must be done on a Windows machine — `signtool.exe` (a Windows-only binary) does the Authenticode embedding; there is no viable cross-platform path for this step.

**To sign a Windows build**, run on a Windows box:
```powershell
.\scripts\build-sign-win.ps1
```

The script builds the installer, auto-downloads the Azure Trusted Signing dlib from NuGet on first run (cached in `scripts\.azure-signing\`, git-ignored), then signs and verifies all `.exe` files.

The dlib version is pinned in `$DlibVersion` near the top of the script. Microsoft releases updates periodically — if SmartScreen warnings reappear on a previously-clean build, bump this value to the latest on [NuGet](https://www.nuget.org/packages/Microsoft.Trusted.Signing.Client). The script automatically detects a version mismatch, wipes the cache, and re-downloads.

Credentials go in `scripts\set-azure-vars.ps1` (git-ignored; template at `scripts\set-azure-vars.example.ps1`):
```powershell
$env:AZURE_TENANT_ID                = "..."   # Entra ID → Overview → Tenant ID
$env:AZURE_CLIENT_ID                = "..."   # Entra ID → App registrations → your app → Application (client) ID
$env:AZURE_CLIENT_SECRET            = "..."   # same app → Certificates & secrets → Client secrets → Value
$env:AZURE_TRUSTED_SIGNING_ENDPOINT = "..."   # Trusted Signing account → Overview → URI
$env:AZURE_TRUSTED_SIGNING_ACCOUNT  = "..."   # Trusted Signing account → Overview → Name
$env:AZURE_TRUSTED_SIGNING_PROFILE  = "..."   # Trusted Signing account → Certificate profiles → profile name
```

The app registration needs the **Trusted Signing Certificate Profile Signer** role assigned on the signing account (Azure portal → signing account → Access control (IAM)).

Full setup walkthrough: see `WINDOWS-SIGNING.md`.

**Output:** `release/{version}/`

| Platform | Artifacts |
|----------|-----------|
| macOS | `.dmg`, `.zip` (x64 & arm64) |
| Windows | `.exe` installer, portable `.exe` |
| Linux | `.AppImage`, `.tar.gz` (x64 & arm64) |
| Web | `-web.zip` (extract to any static web server) |

### Linux AppImage Compatibility

The Linux build uses a post-pack hook (`scripts/afterPackLinux.cjs`) that wraps the Electron binary with a small shell script. This is necessary because:

- **SUID sandbox**: AppImages mount squashfs as a regular user, so `chrome-sandbox` loses its SUID bit. The wrapper injects `--no-sandbox` so Chromium doesn't abort.
- **Wayland**: The wrapper sets `ELECTRON_OZONE_PLATFORM_HINT=auto` so Electron uses the native Wayland backend when `WAYLAND_DISPLAY` is present, rather than defaulting to XWayland (which GNOME on Wayland often fails to display).

**GPU / VM environments**: `electron/main.ts` calls `app.disableHardwareAcceleration()` on Linux to avoid VA-API initialization failures on systems without working GPU drivers (e.g. VMware SVGA II). `ready-to-show` depends on the GPU compositor for first-paint and won't fire when hardware acceleration is disabled, so a `did-finish-load` fallback is used to show the window instead.

**inotify watches**: If the app hangs silently on a Linux machine with many file-watching tools running (VS Code, JetBrains, Dropbox), the system inotify limit may be exhausted. Fix with:
```bash
sudo sysctl -w fs.inotify.max_user_watches=524288
sudo sysctl -w fs.inotify.max_user_instances=512
```

### Icon Generation

The `scripts/generate-icons.sh` script generates platform-specific icons:
- Uses `build/icon-1024.png` as the source by default
- Generates `.ico` (Windows), `.icns` (macOS), and various `.png` sizes (Linux)
- Requires ImageMagick (`brew install imagemagick`)
- Run before building to ensure icons are up to date

## Features

- Connect to I3X servers (default: https://api.i3x.dev/v1)
- Ignore certificate errors checkbox in connection dialog (Electron only) — for self-signed / dev servers; persisted across restarts
- Browse hierarchical tree: Namespaces → ObjectTypes → Objects
- **The entire sidebar tree is virtualized** — every folder (Namespaces, Objects, Hierarchy) flattens into one windowed list, so only rows near the viewport are mounted no matter how many are visible; tens of thousands of objects (or children under one parent) stay responsive
- Huge child lists are **paged**: a parent with more than ~200 children shows the first page plus a "Show N more / show all" row (the flat Objects folder is exempt — browsing everything is its point)
- **Sticky ancestor header**: scrolling deep inside a big expansion pins the nearest ancestors at the top of the tree (VS Code-style); click a pinned row to jump back to it
- All UI icons are **inline SVGs** (`src/components/common/icons.tsx`) — no emojis anywhere, so icons render identically on every platform and honor the theme
- Expand compositional objects to see children
- Tree auto-refresh: expanding a branch re-fetches from the server (full-catalog refetches are coalesced/throttled on large sets); 30s background poll refreshes all expanded branches
- View object details, metadata, and current values
- Current Value pane has a **Parsed / Raw** toggle — Raw shows the untouched HTTP response body; for composition objects the component rows middle-truncate the elementId and round numeric values, with full id/value/timestamp on hover
- Copy-to-clipboard floating icon on every JSON pane (object data, schema, raw value, etc.)
- Home shell shows a **statistical model overview** built to be a launchpad, not a poster: largest containers and entry points (both clickable), objects by type (click to open the type), a hierarchy depth histogram, and a warning strip that appears only when the catalog has problems. Not a whole-model graph: at catalog scale that is an unreadable hairball
- Relationships tab puts **the direct-relationship list and a depth-N tree in one full-width panel** (Fusion 360 style: browser list on the left, tree on the right). The list shows every direct relationship (hierarchy and non-hierarchy together); the tree walks out to a configurable depth (pills for 1 and 2, plus a "+" that reveals one deeper hop per click, default 1), drawn left-to-right with the root in the middle, parents in columns to the left and children to the right (the column is the generation, not the hop count), and every node on its own row so labels never overlap. A **Tree / Rings toggle** in the header switches between this tree and the older radial map (rings = hops); the tree is the default. Hover a list row to spotlight its node on the map, or drag a row onto the map to focus it there without navigating away. A **header search box** filters the list as you type and autocompletes over it; picking a match zooms the map to that node and spotlights it (a locator, not a navigation)
- **Subtree tab** (next to History) — the same left-to-right tree, but dedicated to deep nesting: the whole panel, descendants only (no parent leaf, no non-hierarchy fan-out off the root), its own depth setting (default 3) so drilling deep here doesn't drag the Relationships map along
- Bottom status bar: connection state + API version, server URL, object/namespace counts, subscription count (click to toggle the subscriptions drawer), and Developer tools
- Subscribe to objects for real-time updates (polling or SSE); subscriptions auto-recover transparently on server-side expiry (HTTP 404/410)
- Trend chart for numeric subscription values
- **Keyboard-first tree** (ARIA tree pattern): ↑/↓ move, → expands (or steps to first child), ← collapses (or jumps to parent), Home/End, Enter/Space select and toggle, and type-ahead — type letters to jump to the next matching row
- **Right-click context menu** on every tree row (also Shift+F10 / Menu key on the focused row, and on sticky-header rows). Actions adapt to the row: objects get Open / Open Relationships / Open Subtree / Open History (deep-links the detail tab), Expand all + Collapse subtree (Hierarchy view, capped at 1,000 branches), cross-view Reveal in Hierarchy ⇄ Reveal in Objects, and Copy name / element ID / object JSON / **subtree JSON** (nested `{…object, children: […]}`, count shown in the item). Types add Copy type JSON / instances JSON; namespaces Copy URI / types JSON; folders Copy namespaces / all objects / **whole hierarchy JSON**; "Show more" rows get their paging actions
- Search/filter tree nodes (inline sidebar filter); the filter matches against a prebuilt lowercase index (built once per catalog fetch) and runs deferred, so typing never stutters on huge catalogs; while filtering, the three root folders show live match-count pills in the accent color
- Tree visuals: VS Code-style indent guides at every depth (the selected node's subtree guide is accented), counts as rounded pills, newly expanded children ease in (disabled under reduced motion), hovering a row reveals a copy-element-ID action (copy-URI on namespaces), and rows span the sidebar's full width edge-to-edge (collapse-all and reveal-selection live in the right-click menu)
- Long tree labels truncate with an ellipsis (full name in the tooltip), so count pills stay pinned at the panel's right edge at any sidebar width — widening the sidebar reveals more of each name
- Collapse/expand the tree (sidebar) panel via the panel-toggle button at the left of the toolbar
- Global object search modal (toolbar Search button or ⌘K / Ctrl+K) — searches all objects by name or elementId, shows breadcrumb path, navigates to and expands the match in the tree (Hierarchy preferred, Objects flat as fallback)
- Light/dark theme toggle (persists across restarts; falls back to OS preference)
- Web deployment: `dist-web/` can be served as a static site; `config.json` pre-populates the server URL and recent connections list on first visit

## Key Resources

- **API Documentation**: https://api.i3x.dev/v1/docs (OpenAPI spec at /openapi.json)
- **RFC Specification**: https://github.com/cesmii/API/blob/main/RFC%20for%20Contextualized%20Manufacturing%20Information%20API.md
- **Reference Implementation**: ~/Projects/API/demo (Python FastAPI server + test client)

## I3X API Concepts

### Core Entities

| Entity | Description |
|--------|-------------|
| **Namespace** | Logical scope organizing related types/instances (identified by URI) |
| **ObjectType** | Schema definition for objects (JSON Schema) |
| **ObjectInstance** | Actual data point with elementId, typeId, parentId, relationships |
| **RelationshipType** | Defines how objects relate (HasParent, HasChildren, HasComponent) |
| **ElementId** | Platform-specific persistent unique identifier for any entity |

### Data Model

**VQT (Value-Quality-Timestamp)** — Standard envelope for all values:
```json
{
  "value": <data>,
  "quality": "Good" | "GoodNoData" | "Bad",
  "timestamp": "<RFC 3339>"
}
```

**Composition** — Objects with `isComposition: true` contain nested children traversable via `maxDepth`:
- `maxDepth=0`: Infinite recursion
- `maxDepth=1`: No recursion (default)
- `maxDepth=N`: Recurse N levels through HasComponent

## API Endpoints

### Explore (Discovery)
- `GET /namespaces` — List all namespaces
- `GET /objecttypes?namespaceUri=` — List object types
- `POST /objecttypes/query` — Query types by elementId(s)
- `GET /relationshiptypes?namespaceUri=` — List relationship types
- `POST /relationshiptypes/query` — Query relationships by elementId(s)
- `GET /objects?typeId=&includeMetadata=` — List object instances
- `POST /objects/list` — Query objects by elementId(s)
- `POST /objects/related` — Get related objects by relationship type

### Query (Values)
- `POST /objects/value` — Get last known values (supports maxDepth)
- `POST /objects/history` — Get historical values (startTime, endTime, maxDepth)

### Update (Write)
- `PUT /objects/{elementId}/value` — Update current value
- `PUT /objects/{elementId}/history` — Update historical values

### Subscribe (Real-time)
- `POST /subscriptions` — Create subscription
- `GET /subscriptions` — List all subscriptions
- `GET /subscriptions/{id}` — Get subscription details
- `DELETE /subscriptions/{id}` — Delete subscription
- `POST /subscriptions/{id}/register` — Register monitored items (elementIds, maxDepth)
- `POST /subscriptions/{id}/unregister` — Remove monitored items
- `GET /subscriptions/{id}/stream` — SSE stream (QoS0)
- `POST /subscriptions/{id}/sync` — Poll queued updates (QoS2)

## Request Patterns

### Single vs Batch
Most endpoints accept either single `elementId` or array `elementIds`:
```json
{"elementId": "single-id"}
// or
{"elementIds": ["id1", "id2", "id3"]}
```

### Batch Response Format
Value endpoints return keyed responses for batch requests:
```json
{
  "elementId1": {"data": [{"value": 123, "quality": "GOOD", "timestamp": "..."}]},
  "elementId2": {"data": [{"value": 456, "quality": "GOOD", "timestamp": "..."}]}
}
```

## Reference Implementation (~/Projects/API/demo)

### Server (FastAPI)
```
server/
├── app.py              # Main app, lifecycle, config loading
├── models.py           # Pydantic models (RFC-compliant)
├── config.json         # Current config (cnc-mock data source)
├── routers/
│   ├── namespaces.py   # RFC 4.1.1
│   ├── typeDefinitions.py  # RFC 4.1.2-4.1.5
│   ├── objects.py      # RFC 4.1.5-4.2.2
│   └── subscriptions.py    # RFC 4.2.3
└── data_sources/
    ├── data_interface.py   # Abstract I3XDataSource
    ├── factory.py          # Data source factory
    ├── manager.py          # Multi-source routing
    ├── mock/               # Generic manufacturing mock
    ├── cnc_mock/           # CNC machine mock (CESMII profile)
    └── mqtt/               # Real MQTT broker integration
```

### Data Source Interface
Key methods any data source must implement:
- `get_namespaces()`, `get_object_types()`, `get_relationship_types()`
- `get_instances()`, `get_instance_by_id()`, `get_related_instances()`
- `get_instance_value()`, `get_instance_history()`
- `update_instance_value()`, `update_instance_history()`
- `start(callback)`, `stop()` — Lifecycle with update callbacks

### Running the Demo
```bash
# Server (port 8080)
cd ~/Projects/API/demo/server && python app.py

# Client (interactive CLI)
cd ~/Projects/API/demo/client && python test_client.py

# Swagger UI
open http://localhost:8080/docs
```

## Design Principles (from RFC)

1. **Abstraction over implementation** — Unified interface regardless of backend
2. **Platform independence** — Works on OPC UA, MQTT, historians, cloud
3. **Separation of concerns** — Explore vs Query vs Update vs Subscribe
4. **Application portability** — Apps work across different platforms unchanged

## Authentication

- Minimum: API key
- Optional: JWT, OAuth
- Production: Encrypted transport (HTTPS) required

## Common Patterns

### Subscription Flow
1. `POST /subscriptions` → Get subscriptionId
2. `POST /subscriptions/{id}/register` → Add elementIds to monitor
3. Either:
   - `GET /subscriptions/{id}/stream` → SSE for real-time (QoS0)
   - `POST /subscriptions/{id}/sync` → Poll for updates (QoS2)
4. `DELETE /subscriptions/{id}` → Cleanup

### Hierarchical Browsing
1. `GET /namespaces` → Find namespace URI
2. `GET /objecttypes?namespaceUri=` → Find type definitions
3. `GET /objects?typeId=` → Find instances of type
4. `POST /objects/related` → Navigate relationships
5. `POST /objects/value` with maxDepth → Get nested values

## Implementation Notes

### API Response Format
POST endpoints for values return **keyed responses** where each elementId maps to its data:
```json
{
  "elementId1": {"data": [{"value": 123, "quality": "GOOD", "timestamp": "2024-01-01T00:00:00Z"}]},
  "elementId2": {"data": [{"value": 456, "quality": "GOOD", "timestamp": "2024-01-01T00:00:00Z"}]}
}
```
The client extracts values by looking up `response[elementId].data[0]`.

### Tree Navigation Structure
The explorer uses two top-level folders:
- **Namespaces** → ObjectTypes → Objects (hierarchical by type)
- **Objects** → Flat list of all objects (lazy-loaded)

### Relationship Types for Tree vs Graph
- **Tree children**: Only show objects where `relationshipType === "HasComponent"` AND `isComposition === true` AND `parentId === currentObject.elementId`
- **Graph relationships**: All other relationships shown in RelationshipGraph component
- Without these filters, cycles cause infinite loops/hangs

### Multi-version Support
The client handles three spec generations transparently. `ApiVersion = 'v0' | 'v1-beta' | 'v1'` is detected at connect time and drives all branching in `src/api/client.ts`.

**Detection** — `detectVersion()` probes `GET /info`:
- No `/info` (or non-2xx) → `'v0'`
- `/info` OK, `result.specVersion` (or `version`/`apiVersion`) parses to ≥ 1.0 → `'v1'`
- `/info` OK but no recognisable version field → `'v1-beta'`

The toolbar badge shows **v0** (yellow), **v1 Beta** (blue), or **v1** (green).

**Wire-format differences handled by the client:**

| Concern | v0 (Alpha) | v1-beta (Beta) | v1 (Release) |
|---------|-----------|----------------|--------------|
| Response envelope | bare array/object | `{success, result}` | `{success, result}` |
| Bulk results | keyed `{elementId: {data:[...]}}` | `{results:[{elementId,result}]}` | same as Beta |
| Error body | `{error:{code,message}}` | `{problemDetail:{title,status,detail}}` | `{responseDetail:{title,status,detail}}` |
| Subscription endpoints | `/{id}/register`, `DELETE /{id}` | `/register` + id in body, `POST /delete` | same as Beta |
| Metadata extensions field | — | `extendedAttributes` | `schemaExtensions` |
| `/sync` partial response | — | — | HTTP 206 = queue overflow, logs warning |

`isV1()` (private helper) returns true for both `'v1-beta'` and `'v1'` — all v1 wire-format branching goes through it so Beta and Release share the same code paths. The `extendedAttributes` → `schemaExtensions` rename is normalised in `normalizeV1Object()`: both field names are accepted and always surfaced as `schemaExtensions` on `ObjectInstance`.

### SSE vs Polling
- **SSE (QoS0)** is the default — real-time streaming via `GET /subscriptions/{id}/stream`
- **Polling (QoS2)** available as fallback — uses `POST /subscriptions/{id}/sync`
- Both use the same keyed response format

### SSE/Sync Response Format
Both SSE and sync endpoints return arrays of keyed objects:
```
data: [{"elementId": {"data": [{"value": 123, "quality": "GOOD", "timestamp": "..."}]}}]

data: [{"elementId": {"data": [{"value": 456, "quality": "GOOD", "timestamp": "..."}]}}]

```
SSE format requirements:
1. `data: ` prefix
2. Two newlines (`\n\n`) after each message
3. `Content-Type: text/event-stream` header

### CORS Configuration
The Electron app sets `webSecurity: false` in `BrowserWindow`, which disables CORS enforcement in the renderer entirely. This is appropriate for a trusted desktop app and avoids preflight failures against servers with incomplete CORS headers. All HTTP requests are made directly from the renderer process (visible in DevTools Network tab).

For server-side reference only — if building a web-based client, configure CORS in **either** the reverse proxy (nginx) **or** the application (FastAPI), **not both**. Duplicate headers cause browsers to reject responses.

**FastAPI (recommended):**
```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**nginx (if not using FastAPI CORS):**
```nginx
location / {
    add_header 'Access-Control-Allow-Origin' '*' always;
    add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, DELETE, OPTIONS' always;
    add_header 'Access-Control-Allow-Headers' 'Content-Type, Authorization' always;

    if ($request_method = 'OPTIONS') {
        return 204;
    }

    # SSE settings
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;
    proxy_http_version 1.1;
    proxy_set_header Connection '';

    proxy_pass http://localhost:8080;
}
```

### Tree Refresh
- Expanding any branch re-fetches from the server (no stale cache)
- Hierarchy nodes (`hier:` prefix) re-fetch `allObjects` on expand — important for MQTT adapters that discover objects dynamically as topics arrive. These full-catalog refetches are coalesced/throttled (`refreshAllObjects` in `TreeView.tsx`, `ALL_OBJECTS_REFETCH_TTL_MS`): concurrent expands share one in-flight request and a fresh fetch is skipped if one ran within the window, so rapidly expanding many nodes on a large catalog doesn't trigger a full refetch per click. Opening the Objects/Hierarchy folder and the background poll force a fresh fetch, so freshness is preserved.
- A 30-second background poll refreshes all currently-expanded branches while connected (controlled by `BACKGROUND_POLL_ENABLED` in `TreeView.tsx`)
- `allObjects` is indexed by `parentId` into `childrenByParent` in the store when set, so the hierarchy view resolves each node's children with an O(1) map lookup instead of scanning the full object list per node. `objectTypes` is likewise indexed into `typeIndex` (shared by every node for icon bucketing). Tree rows use narrow store selectors so a single row's select doesn't re-render the whole tree.
- The tree is split into focused modules under `src/components/tree/`: `treeData.ts` (non-JSX shared logic — `buildTreeRows`, `resolveCompositionFlags`, `refreshAllObjects`, `hasCompositionChildren`, `getObjectLabel`, `isScalarSchemaType`, folder-id/`MAX_TREE_DEPTH` constants), `TreeNode.tsx` (the row renderers: `TreeNode`, `TreeMoreNode`, `TreeRowIcon`), and `TreeView.tsx` (the shell: virtualizer, sticky header, keyboard navigation, background refresh). Dependencies point one way into `treeData`/`TreeNode`, so there is no import cycle.
- **The whole tree is one flattened, virtualized list.** `buildTreeRows` (pure, memoized) walks all three folders — Namespaces → types → objects, the flat Objects forest, and the Hierarchy parent/child walk — applying expansion, filtering (with ancestor keep-alive), per-parent paging, and cycle/depth guards in a single pass, and emits one ordered `TreeRow[]` where each row carries its `parentIndex`. `TreeView` windows that array with a single `@tanstack/react-virtual` virtualizer against the tree scroll container. Nothing renders recursively: a hierarchy node with 20k children costs the same DOM as one with 2. Rows render in normal flow with top/bottom spacer padding (not absolute positioning) so hover, selection, and count pills behave like plain DOM; row height is measured once from the first mounted row. Rows are exactly the panel width (no horizontal scroll, no width measurement): labels are `flex-1 min-w-0 truncate` with the full name in a `title` tooltip. Reveal-selected is pure index math (`scrollToIndex`), no DOM probing. Expansion state lives in the store, so expanded rows survive being scrolled out of the window.
- **Huge child lists are paged** (`CHILD_PAGE_SIZE`/`CHILD_PAGE_SLACK` in `stores/explorer.ts`, reveal state in `childPageLimits`): past ~200 children a parent emits a "Show N more · N hidden · show all" row instead of dumping everything. Virtualization makes rendering cheap regardless — the cap is for the *reader*, so one parent's 20k children don't bury its siblings. Collapsing a parent resets its paging. The flat Objects folder's top level is deliberately exempt. **The selection path is also paging-exempt**: `buildTreeRows` takes `selectedId` and force-emits any paged-out row on the path to it (after the "Show more" row), so reveal-from-search and Back/Forward always find the selected row even at position 1,200 of a paged list.
- **Sticky ancestor header** (in `TreeView.tsx`): while scrolled deep inside one parent's children, up to `MAX_STICKY_ROWS` nearest ancestors stay pinned at the top of the viewport (computed from `parentIndex` chains with a small fixed-point iteration so the header accounts for its own height). Clicking a pinned row jumps back so the target lands just below the remaining pinned rows. The overlay is positioned outside the scroll content, above the windowed rows.
- **Composition chevrons resolve lazily for the visible window.** `hasCompositionChildren` shows a chevron optimistically for any unresolved `isComposition` object; `TreeView` then resolves the real qualifying-child count for the `obj:` rows currently in view (small debounced `resolveCompositionFlags` batch), so a composition object whose components are all leaves loses its (dead) chevron without the user clicking. The whole catalog is never resolved in one batch (that batch is slow/unreliable at 58k and left chevrons wrong). Expanding an object also writes its real child count back to the cache, so a click self-corrects the chevron as a backstop.
- **Tree icons are SVGs** from `src/components/common/icons.tsx`: distinct shapes for the three root folders (layers / grid / org-tree), globe = namespace (blue), document = object type (green), folder = FolderType (amber), cube = branch object (slate), activity trace = scalar "variable" leaf (violet, `--i3x-violet`). The leaf test is the shared `isScalarSchemaType` (schema.type scalar per the Implementation Guide), also used by the search modal so both surfaces always agree.
- **Keyboard navigation** lives in `TreeView.handleKeyDown` (roving focus on the container via `aria-activedescendant`, `focusedIndex` state, `tree-row-{index}` DOM ids). Mouse and keyboard share one activation path: `activateRow` / `expandRow` / `loadChildrenFor` in `treeData.ts` hold the select/toggle/fetch behavior, so a click and Enter are literally the same code. Type-ahead scans labels wrapping from the focused row (`findTypeAhead`).
- **Filter is index-backed and deferred**: `setAllObjects` prebuilds `searchIndex` (elementId → lowercased `name id namespaceUri` blob) so per-keystroke matching is one `.includes()` per object instead of three `toLowerCase()` calls; objects fetched outside `allObjects` fall back inline. `TreeView` filters on `useDeferredValue(searchQuery)` so the input stays responsive while the rebuild lags a frame behind. Folder rows carry `filtered: true` while a filter is active and show match counts (accent-colored pills).
- **Indent guides** (`IndentGuides` in `TreeNode.tsx`) are absolutely-positioned 1px columns over each row's left padding, so they connect across rows; the guide under the selected node is accented for its descendants (`activeGuideFor` walks `parentIndex` chains of mounted rows only). **Expansion animation**: `TreeView` tracks the most recently expanded node id; its direct children get `.tree-row-enter` (staggered, 400ms window) — scroll-driven mounts never animate, and reduced-motion disables it.
- **Context menu**: `common/ContextMenu.tsx` is the generic panel (fixed-position, viewport-clamped after an invisible measuring frame, arrow/Enter/Esc keyboard support, takes focus while open and the tree refocuses on close); `tree/treeMenu.tsx` builds the entries per row kind. Counts in item labels are surveyed at open time (iterative `surveySubtree` walk), but heavy payloads — nested subtree JSON — are built only when the action is clicked. Tab deep-links go through `pendingDetailTab` in the explorer store: the menu sets it, then selects; `ObjectDetailView` seeds its tab state from it on mount (and via an effect for same-element requests) and clears it. Bulk expand ("Expand all") is Hierarchy-only by design — composition nodes fetch children per expand, and bulk-expanding them would fire a request storm. The menu closes on tree scroll (rows shift under it).

### Theme System
- Colors are defined as CSS custom properties (space-separated RGB channels) in `src/styles/index.css`
- Light theme is the default (`:root`); dark theme activates via `@media (prefers-color-scheme: dark)` or `[data-theme="dark"]` on `<html>`
- The toolbar sun/moon button sets `document.documentElement.dataset.theme` and persists the choice to `localStorage`
- Tailwind tokens use `rgb(var(--i3x-...) / <alpha-value>)` format so opacity modifiers (`/20`, `/50`) continue to work
- SVG chart components (TrendView, HistoryTab, RelationshipGraph, ModelOverview) use `rgb(var(--i3x-...))` strings rather than raw hex

### Trend View
- Stores up to 60 data points per elementId
- Only displays for numeric values
- Updates in real-time during active subscriptions

### Global Object Search
- Component: `src/components/search/SearchModal.tsx`
- Triggered by 🔍 toolbar button or ⌘K / Ctrl+K (disabled when not connected)
- Searches `allObjects` by `displayName` or `elementId` (case-insensitive substring); fetches from server if store is empty
- Results capped at 50; sorted hierarchy-first, then alphabetical
- **Tree preference**: an object is shown with a "Hierarchy" badge if it is a hierarchical root or has a non-empty `parentId` (not `/`); otherwise "Objects" badge
- **Navigation** on result select: batch-expands `folder:hierarchical` + every `hier:{ancestorId}` up the `parentId` chain, then calls `selectItem` with the `hier:{elementId}` id. Falls back to expanding `folder:objects` and selecting `obj:{elementId}` for non-hierarchy objects
- Ancestor expansion uses `useExplorerStore.setState({ expandedNodes })` in one write to avoid multiple re-renders

### Model Overview (`src/components/main/ModelOverview.tsx` + `modelStats.ts`)
**There is deliberately no whole-model graph.** The Home shell used to draw one (force-directed SVG, then a GPU/cosmos.gl variant). At the scale this app browses — catalogs of tens of thousands of objects — a node-link map of everything is a hairball: it looks like structure but you cannot read one actionable fact off it. Both were removed, along with the `@cosmos.gl/graph` dependency. A graph earns its place only when it is *rooted* somewhere and *bounded* by depth, which is what the Relationships tab does.

The overview is statistical instead, and derived **entirely from the store — no requests, no caps, no sampling** (100k objects computes in ~70ms).

**Every row is a way IN.** At 100k objects the counts alone are wallpaper — "100,000 objects" tells you nothing you can act on. So the panel is built to be a launchpad, and nothing on it is a dead end:
- **Largest containers** — the objects holding the most direct children. On a big model this is where the structure actually is; click one to open it. This, not the tree, is where you start
- **Entry points** — the roots, clickable. A model with thousands of roots is *flat*, not hierarchical, which you want to know before hunting for a tree that isn't there
- **Objects by type** — each bar opens that type (`selectType` in `navigation.ts`)
- **Worth knowing** — a warning strip that renders *only when something is wrong* (orphans / untyped objects / declared types with no instances). A permanent "0 issues" panel trains people to ignore the space it occupies

Implementation notes:
- `modelStats.ts` is pure (`computeModelStats(objects, objectTypes, namespaceCount)`). `topBy()` does a **partial selection** for the top-8 lists — sorting a 100k array to read eight rows is O(n log n) for nothing
- **A root is an object you cannot navigate UP from**: no `parentId`, *or* a `parentId` naming something outside the catalog (an orphan). Counting only the former would contradict the depth histogram, which has to place orphans at level 0 for want of anywhere else to put them — the card would read "1 root" above a Root bar of 2. Orphans are still tallied separately and surfaced under *Worth knowing*
- `computeDepths` memoises each object's level and carries an in-progress set: some servers emit `parentId` cycles, which would otherwise spin forever
- **Everything here is `parentId`-derived**, because those are the only edges knowable without a per-object round trip. That caveat lives behind an `InfoHint`, not in body copy
- Charts follow the `dataviz` skill: **one hue for every bar** (a value-ramp on nominal categories would double-encode length as hue) and no colour-only encoding

### InfoHint (`src/components/main/InfoHint.tsx`)
The "?" marker next to anything that isn't self-explanatory: hover for a one-line tooltip, click for a dismissible popup with the full explanation (Esc / outside-click to close).

**Explanations do not go in body copy.** A paragraph under a chart is read once, by nobody, and it pushes the actual content down the page. Caveats, definitions and "how is this counted" go behind an `InfoHint` instead — used on Containment links, Entry points, Hierarchy shape, and each issue in the *Worth knowing* strip.

### Chevron (`src/components/common/Chevron.tsx`)
The **one** disclosure marker in the app. There used to be three — `›`/`⌄` in the tree (two different glyphs at two different optical baselines, so the mark visibly *jumped* when a node opened), a `▶` in the Overview tab, and a third in the relationships list. A drawn chevron **rotates** rather than swaps, so open/closed is one shape in two positions.

It is driven two ways, because the app toggles disclosures both ways:
- `<Chevron open={isOpen} />` — React state (tree rows, relationship groups)
- `<details className="group"><summary><Chevron /></summary>` — the browser, via `group-open:rotate-90` (Overview tab's Object Data)

`group-open:rotate-90` is inert outside a `group`, so one component serves both without a variant flag. Note the `<summary>` must stay `display:flex` — that is what suppresses the browser's own native marker triangle.

Breadcrumb and search-result path separators also use `›`, but those are separators, not disclosure markers, and are left alone.

### Relationships Tab (one panel: list + depth-N tree)
The list and the tree share a single card, laid out like a Fusion 360 workspace: the browser list (every direct relationship) on the left, the tree (the depth-N walk) on the right. The tab spans the full window width; the other detail tabs stay capped at 960px. The list answers *what is this connected to* (every direct relationship, hierarchy and non-hierarchy, in one place). The tree answers *what is it connected to through those*, which is only a real question past the first hop, so it walks out to a configurable depth.

**Two views, toggled.** The same ego graph is drawn either as a left-to-right tree (default) or the radial rings map. A `Tree / Rings` `SegmentedControl` in the header sets `relationshipView` in the store (persists across selections). The split is by file: `TreeGraph.tsx` + `treeLayout.ts` and `RadialGraph.tsx` + `radialLayout.ts` are each self-contained (own walk, pan/zoom, hover, drop); `RelationshipGraph.tsx` is a thin switcher that renders one based on the store, and `dragType.ts` holds the shared `ELEMENT_DRAG_TYPE` so nothing imports across the two. Toggling remounts the chosen view, which re-walks the graph.

**Why the tree is the default.** A radial layout has two failure modes it can't shake: it reserves a full circle while real data uses a narrow wedge (so a sparse graph sits small and off-centre in empty space), and a deep chain stacks parent/child labels at the same angle (so names overlap no matter how they're sized). The tree fixes both structurally — each generation is a column, **every node gets its own row**, so a label always has space and the drawing grows to fit; a 100-node depth-2 walk becomes a tall, scrollable, readable tree instead of a hairball. The radial view stays available for a compact spatial sense of where things sit.

- **`egoGraph.ts`** is the data layer. `expandEgoGraph()` walks BFS from a root over `POST /objects/related` (no type filter, so all relationship kinds come back). One round trip per hop: the v1 client takes a whole frontier via `getRelatedObjectsBatch`; v0 has no batch form and falls back to a throttled fan-out (`V0_CONCURRENCY`). There are **no node or fan-out caps**: the walk renders everything reachable within the chosen depth. Depth is the only bound, so a deep custom walk on a dense model can be heavy
- **The walk only ever descends past the root.** The root fans out to all its direct relationships (parent, children, other links), but level 2+ follows **child edges only** (`bucketOf === 'child'`) — the parent shown one level up is never expanded, so there are no grandparents and no siblings. It's a `parent → self → children → grandchildren → …` view; to go further up, root the map on the parent and drill down. Both views (tree and radial) share this walk, so both obey it
- `directNeighbors()` unions the server's related objects with the compositional parent/children **already in the store**, because servers differ in what `/objects/related` reports. The API entry wins on conflict: it carries the true `sourceRelationship`, where the store can only infer `HasParent`/`HasComponent` from `parentId`. Both the list and the walk go through it, so they can never disagree
- **Edges are deduped by pair + relationship *family*** (`edgeKey`). `HasComponent(A→B)` and `ComponentOf(B→A)` are one physical edge seen from both ends; without the collapse, every hierarchy edge gets drawn twice in two different colors once the walk reaches its far end. The survivor is the one discovered from the shallower node, so an edge always reads outward from the root
- **`treeLayout.ts`** is pure and deterministic. It lays the BFS tree (each node's `via` is its parent) left-to-right. The column (x) is the **generation**, not the hop count: a node's column is its parent's ± 1 by the *direction* of the edge it was reached through — `egoGraph` records that on each node as `viaBucket`, and a `'parent'` edge steps left (upstream), everything else steps right (downstream). So parents land in columns before their children instead of sharing a hop column. A leaf takes the next row (`ROW_HEIGHT`); a node centres on its **downstream** children so it lines up with them rather than an upstream parent. Recursion is bounded by depth (≤ `MAX_RELATIONSHIP_DEPTH`). It returns node/edge positions, the `columns` present (for the guides), and the content bbox. Cross-links (non-tree edges) are flagged `tree:false` and drawn as dashed curves; tree edges are solid-ish S-curves in the bucket color
- **`TreeGraph` fits the whole tree on load.** It builds the `viewBox` from the tree's bounding box so every node is visible top-to-bottom, centred, at any depth (a `MIN_VIEW` floor keeps a tiny tree from being blown up; there's no maximum, so a tall tree shrinks to fit rather than being clipped — zoom/pan to read it). Labels and nodes are in diagram units and scale with the map; because each node owns a row, they never collide at any scale, so there's no semantic-zoom/decluttering machinery. Long names clip to `MAX_LABEL_CHARS`; the hover card carries the full name
- **Depth lives in the explorer store** (`relationshipDepth`, 1–10, default 1), not in the tab, since `MainPanel` re-keys the detail view per element. The picker (`DepthControl`, shared from `main/tabs/DepthControl.tsx`) shows a pill per hop from 1 up to `relationshipDepthShown` (also in the store, so revealed pills survive switching elements for the session), plus a "+" that reveals one deeper pill per click up to `MAX_RELATIONSHIP_DEPTH`
- **Subtree tab** (`main/tabs/SubtreeTab.tsx`, after History): the same `TreeGraph` with `descendantsOnly`, which makes `expandEgoGraph` follow child edges from the very first hop — the pure subtree beneath the element, no parent leaf and no side links. Full-panel (no list beside it), rooted on the selected element only. Depth is its own store field (`subtreeDepth`, default `DEFAULT_SUBTREE_DEPTH` = 3) so it doesn't fight the Relationships depth; the two pickers share `relationshipDepthShown`. `TreeGraph.onFocusElement` is optional — the Subtree tab omits it (no drag source there), which disables the drop target entirely
- **The panel fills the detail area's height** and grows/shrinks with the window, down to a `min-h-[30rem]` floor (below that the detail area scrolls); the tree pane has a `min-w` floor too
- **Hover a list row to spotlight its node on the tree** (`externalHoverId`): the tree highlights it exactly as a real hover does, and the active node gets a focus ring so it is easy to find. A real hover on the tree wins; a row whose node isn't drawn is ignored
- **Header search** (`RelationshipSearch.tsx`, next to the Tree/Rings toggle): one input, two jobs. The text is a live filter on the relationship list (rows match on name/elementId/typeId; a group whose *type* matches keeps all its rows; the count line switches to "X of Y match"). It is also a combobox over the list's neighbors (reported up via `DirectRelationships.onNeighbors`); picking a suggestion spotlights that node (same `externalHoverId` channel, held until the text changes) and issues a `LocateRequest` (`locator.ts` — elementId + monotonic token) that the active view answers by centring and zooming on the node. Each graph keeps a handled-token ref, so a request fires once — but late if the walk is still loading, and never against a re-rooted map (root change clears spotlight + request). A picked element that isn't drawn (e.g. the map is re-rooted elsewhere) is silently ignored, like `externalHoverId`
- **Drag a row from the list onto the tree** to re-root it on that element *without navigating*: the detail view around it stays put. The drop payload is the `ELEMENT_DRAG_TYPE` MIME carrying an elementId, resolved against `objectIndex`; the ◎ button on each row does the same thing with the whole object in hand, and is the keyboard path. Clicking a tree node navigates (as on the overview map)

### Main Content Panel (`MainPanel` → `HomeView` / `ObjectDetailView`)
- Two top-level states, driven purely by `selectedItem`: nothing selected → `HomeView` (the statistical `ModelOverview`); an object selected → `ObjectDetailView` (breadcrumb, title row, and the Overview · Relationships · History tabs). Namespace/object-type selections reuse `SimpleDetailView`, the same header frame without tabs
- **Navigation contract** (`src/components/main/navigation.ts`): `selectElement(elementId)` resolves the object from `allObjects` (store-only — never fetches), expands the ancestor path in one `setState`, then calls `selectItem`; `showHome()` is `selectItem(null)`. The panel never imports the tree — both sides share `selectItem`, so selection stays in sync. The toolbar's brand and Home button also call `selectItem(null)`
- **There is no Subscriptions tab.** Subscriptions are global state, not a property of the selected element, so they live in `SubscriptionsDrawer` above the status bar. Subscribing to an element opens the drawer
- `MainPanel` re-keys `ObjectDetailView` on `elementId` so per-element view state (active tab, loaded value, history range) doesn't bleed across selections
- **Breadcrumb** folds the middle of deep chains: `collapseCrumbs()` (exported, pure) keeps the outermost and nearest ancestor and hides the rest behind a "…" button that expands in place. A new selection re-collapses it
- **Identity card** shows exactly five fields (Element ID, Type ID, Parent ID, Namespace URI, Source Type ID) plus Composition/Extended flags. Source Type ID always renders, showing `—` when absent
- **Responsive**: the title row wraps its actions, the tab strip scrolls horizontally, action labels and the "Object Instance" kind collapse to icons/hide below `sm`, and the toolbar hides the app title, the Search label and the connect error as the window narrows. Status-bar segments drop out at `sm`/`md`

### Status Facets (`ElementStatus` / `ValueDisplay`)
- A code like `GoodNoData` conflates two orthogonal facets, so `parseStatusCode()` splits them: **quality** (the prefix → Good/Uncertain/Bad/unknown) is carried by COLOR; **data presence** (code doesn't match `/NoData/`) is carried by SHAPE — solid neutral dot vs hollow neutral ring
- `<StatusFacets code variant="labeled" | "compact" | "dot" />` is the single renderer: `labeled` in Current Value, `compact` in the Subscriptions Quality column, `dot` in the dense composition-component rows. Dots are `aria-hidden` with an `sr-only` sentence, since colour and shape carry the meaning
- **Parsed / Raw value toggle**: a segmented control in the Current Value card header (state `valueView` in `ObjectDetailView`). Raw renders `value.rawResponse` (the untouched HTTP body) via `JsonViewer`. `client.getValue` retains that body on `LastKnownValue.rawResponse` for both v1 and v0; the batch `getValues` does **not** (only the single-object detail pane needs it)
- **Component rows** (composition values): the elementId is middle-truncated with a two-span flex trick (head ellipsizes, last `COMPONENT_ID_TAIL` chars stay pinned); numeric values are rounded via `formatComponentValueShort` (`toPrecision(6)` → `Number()` to strip trailing zeros, keeps exponential form). Full id / full-precision value / full timestamp are all in `title` tooltips
- **Copy-to-clipboard**: `CopyButton` (`src/components/details/CopyButton.tsx`) is a floating corner icon embedded in `JsonViewer`, so every JSON pane gets it for free. Uses `navigator.clipboard`, `stopPropagation` (so it doesn't trigger the collapsed-view expand), and fails silently in insecure contexts

### Sidebar Collapse & Tree Label Truncation
- **Collapse**: `sidebarCollapsed` + `toggleSidebar()` live in the explorer store; the panel-toggle button is at the left of the `Toolbar`. `Sidebar` returns `null` when collapsed but stays mounted, so its drag-`width` state is preserved and restored on expand
- **No horizontal scroll**: the tree body scrolls vertically only (`overflow-x-hidden`); rows are exactly the panel width, labels truncate with an ellipsis (`flex-1 min-w-0 truncate`, full name in the `title` tooltip), so count pills and the copy action stay visible at the right edge at any sidebar width. Dragging the sidebar wider reveals more of each name. The filter input is a fixed header above the scroll body so it neither stretches nor scrolls away

### Subscription Transport
- `SubscriptionTransportProvider` (`src/components/subscriptions/SubscriptionTransport.tsx`) owns the SSE/polling refs and stays mounted for the life of the app, wrapping everything in `App.tsx`. The transport used to live inside the subscriptions panel, so collapsing that panel killed the stream. Now `SubscriptionsDrawer` is purely presentational: closing it hides the UI and the stream keeps running
- Consumers get `startStream` / `stopStream` / `deleteSubscription` / `usePolling` / `streamUnsupported` via `useSubscriptionTransport()`
- The provider reads the subscriptions store through `getState()` rather than hook selectors — subscribing would re-render the whole app on every live value

### Subscription Recovery
- `src/api/subscription.ts` exports `HttpStatusError` (carries `.status: number`) and `isSubscriptionGoneError(error)` helper
- HTTP 404/410 on the SSE stream calls `onError` directly instead of entering the reconnect loop — retrying a gone subscription always fails
- The recovery logic lives in `src/components/subscriptions/recovery.ts` (`performRecovery`, unit-tested); `SubscriptionTransportProvider.handleRecovery` is a thin wrapper that supplies the transports and the shared `RecoveryHarness` ref
- `performRecovery` is re-entrancy-guarded, stops BOTH transports first (a still-running poller 404-ing was the concurrent-recovery source), captures monitored items before mutating the store, then delete → create → re-register → `startStream` in a bounded retry loop
- Capped at 3 attempts; the budget refunds on data delivery (`handleDataUpdate`) and on a successful recovery — but only when the previous success is >30s old, so a server that insta-expires each new subscription still converges to the cap instead of cycling forever
- SSE reconnects are cancellable: `SSESubscription` stores its reconnect timer and sets a `disposed` flag on `disconnect()`, so deleting a subscription can't leave a zombie timer that re-fetches (and re-recovers) it
- Polling uses a self-rescheduling `setTimeout` chain (never `setInterval`), so a sync slower than the interval can't stack concurrent requests
- Polling path errors from `client.sync()` use string-prefix matching as fallback (those errors come from `client.ts`, not `subscription.ts`)

### Subscribe Error Handling
- `ObjectDetailView.handleSubscribe` shows an inline error under the title row if `registerMonitoredItems` throws; the button is disabled and relabelled "Subscribing…" during the async call. On success it starts the stream (unless one is already live on the subscription — `startStream` is not idempotent) and opens the subscriptions drawer
- If a subscription was freshly created by `createSubscription` but `registerMonitoredItems` then fails, the new subscription is removed from the store and a best-effort `deleteSubscription` is fired to avoid leaving an empty orphan on the server
- The error message clears automatically when the user navigates to a different object

### Ignore Certificate Errors (Electron only)
- Checkbox in the connection dialog, hidden in web mode (`window.electronAPI` guard)
- Stored as `ignoreCertErrors: boolean` in the connection store (persisted to localStorage)
- On save: calls `window.electronAPI.setIgnoreCertErrors(flag)` → IPC send → module-level flag in `electron/main.ts`
- On app startup: `App.tsx` syncs the persisted value to the main process via the same IPC call so the setting survives restarts
- Main process registers `app.on('certificate-error', ...)` at startup; when the flag is set it calls `event.preventDefault(); callback(true)` to bypass the error

### Web Build
- Config: `vite.web.config.ts` — must use `base: './'` so all asset paths in `index.html` are document-relative, allowing deployment to any subdirectory path
- The `index.html` source uses relative (no leading `/`) hrefs for favicon and icons for the same reason
- Runtime server config: `src/main.tsx` fetches `./config.json` on startup; if no `localStorage` state exists yet, `serverUrl` and `recentUrls` from that file are applied as defaults
- On a git-synced server, put overrides in `config.local.json` at the repo root — `scripts/deploy-web.sh` copies it to `dist-web/config.json` after each build
- `scripts/deploy-web.sh` runs `git pull` then `npm ci` then `npm run build:web` then optionally reloads nginx; triggered by `sudo systemctl restart i3x-explorer-web`
- Live deployment: https://explorer.i3x.dev (nginx serving `dist-web/` from the cloned repo at `/home/cesmii/repos/i3X-Explorer`)

### SVG Tooltips in Electron
- Electron's Chromium suppresses native SVG `<title>` tooltips — they never appear
- Use a React state + HTML overlay approach instead: track `{ label, x, y }` state, set it on `onMouseEnter` of each SVG `<g>` node, update position on `onMouseMove` of the wrapper div, clear on `onMouseLeave`, render as an absolutely-positioned `<div>` with `pointerEvents: none`

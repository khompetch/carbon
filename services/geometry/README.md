# Geometry Service

Stateless Python/FastAPI service that converts STEP files into a meshopt-compressed
GLB plus a `graph.json` assembly tree with stable node IDs. Consumed by the Inngest
convert pipeline and `packages/viewer`.

The wire contracts (request/response shapes, `graph.json` schema, stable nodeId
derivation) are defined in
[`docs/specs/animated-work-instructions-contracts.md`](../../docs/specs/animated-work-instructions-contracts.md).
Do not change them here without updating that document and its consumers.

## API

- `GET /health` → `{ "ok": true, "version": "0.1.0" }` (unauthenticated, for load balancers)
- `POST /convert` → downloads the STEP from a signed GET URL, converts, PUTs the GLB
  (`model/gltf-binary`) and `graph.json` (`application/json`) to signed URLs, and
  returns `{ ok, partCount, unit, stats }` synchronously. Errors return
  `{ ok: false, error, code }` with code in `READ_FAILED | TESSELLATION_FAILED |
  UPLOAD_FAILED | INVALID_INPUT`.

Options: `linearDeflection` (default 0.1), `angularDeflection` (default 0.5), and
`compress` (default true; set false to skip the meshopt pass).

Per-part tessellation failures never abort a run: the part gets a bounding-box proxy
mesh and a note in `stats.warnings`. Only an unreadable STEP fails the request.

## Auth

`Authorization: Bearer <GEOMETRY_SERVICE_API_KEY>` on `/convert`.

| Env var | Behavior |
| --- | --- |
| `GEOMETRY_SERVICE_API_KEY` | Shared secret. When set, every `/convert` request must present it as a bearer token. |
| `GEOMETRY_DEV_MODE` | Only consulted when the API key is **unset**: `true` allows unauthenticated requests (local dev); anything else rejects all requests with 401 (secure default). |

## Local development

Requires Python 3.11+ (the Docker image uses 3.12). The `cadquery-ocp` wheel is
~70 MB.

```bash
cd services/geometry
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'

GEOMETRY_DEV_MODE=true .venv/bin/uvicorn app.main:app --reload --port 8000
```

The meshopt compression pass shells out to `gltf-transform` (Node 20+):

```bash
npm install -g @gltf-transform/cli@4.4.0
```

Without it the service logs a warning and serves uncompressed GLBs.

### Tests

```bash
.venv/bin/pytest
```

STEP fixtures are generated programmatically (no binary files in the repo) by
`tests/fixtures/make_fixtures.py`. API/auth tests run even without `cadquery-ocp`;
conversion tests skip when it is missing, and compression tests skip when
`gltf-transform` is not on PATH.

## Docker

```bash
docker build -t carbon-geometry .
docker run -p 8000:8000 -e GEOMETRY_SERVICE_API_KEY=dev-secret carbon-geometry
```

The image is multi-stage: Python deps are wheel-installed in a builder stage, and
Node 20 + `@gltf-transform/cli` are copied into the runtime stage for the
compression pass. (A docker-compose entry is added in a later task; this service
has no entry in the repo root compose files yet.)

## Implementation notes

- STEP is read via `STEPCAFControl_Reader` into an XCAF document and the assembly
  tree is walked through `XCAFDoc_ShapeTool` (names, per-instance transforms,
  colors via `XCAFDoc_ColorTool`).
- Geometry is normalized to **mm** (`xstep.cascade.unit = MM`); the source unit is
  read best-effort from the STEP header and recorded as `sourceUnit`.
- The GLB is written directly with `pygltflib` from the same tessellated tree as
  `graph.json` (not `RWGltf_CafWriter`), guaranteeing a 1:1 node mapping so each
  glTF node's `extras.nodeId` provably matches the graph. Identical parts share one
  glTF mesh.

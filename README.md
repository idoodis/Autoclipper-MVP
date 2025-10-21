# AutoClipper Service Layer

AutoClipper converts long-form videos into branded, captioned vertical clips. The project now includes a minimal multi-tenant HTTP API, a background worker loop, persistent state on disk, and tests that exercise the platform end to end.

## Highlights

- **Multi-tenant API** – Provision tenants with an admin token and submit clip jobs via per-tenant API keys.
- **Persistent state** – JSON-backed state file keeps track of tenants and job history. Output assets are written per job under `storage/jobs/`.
- **Background worker** – Polling worker downloads remote media, runs the clip pipeline, and records completion or failure metadata.
- **Configurable clips** – Override watermark text and duration limits per job while reusing the robust FFmpeg + Python toolchain.
- **Automated tests** – Vitest suite covers the REST API contract and the original clip smoke test.
- **Deployment ready basics** – `.env` configuration, Makefile targets, and storage directory structure make it simple to run on a VM or container.

## Setup

```bash
make setup
cp .env.example .env
```

Edit `.env` to set a strong `ADMIN_TOKEN`. The defaults store state under `./storage/`.

## Running the stack

Start the HTTP API:

```bash
make api
```

In another terminal run the worker loop:

```bash
make worker
```

### Create a tenant

```bash
curl -X POST http://localhost:3000/v1/tenants \
  -H "content-type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"name":"Demo Creator"}'
```

Save the `apiKey` from the response.

### Queue a job

```bash
curl -X POST http://localhost:3000/v1/jobs \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"sourceUri":"samples/vod.mp4","watermarkText":"Demo"}'
```

Poll for status:

```bash
curl -H "x-api-key: $API_KEY" http://localhost:3000/v1/jobs
```

Outputs land in `storage/jobs/<jobId>/` (clip, captions, timeline JSON).

## Testing

```bash
make test
```

This runs the Vitest suite, including API integration tests and the original FFmpeg smoke test.

## CLI usage

The CLI continues to work for local experiments:

```bash
npm run clip -- --vod samples/vod.mp4 --out out --watermark-text "Demo" --max-duration 45
```

## Configuration

Environment variables (see `.env.example`):

- `PORT` – HTTP port (default `3000`).
- `ADMIN_TOKEN` – Shared secret used to create tenants.
- `STATE_FILE` – Path to the JSON state file.
- `STORAGE_ROOT` – Root directory where job outputs live.
- `WORKER_POLL_MS` – Worker polling interval in milliseconds.

## Architecture Overview

- `apps/api/server.mjs` – Minimal Node HTTP server implementing the REST API.
- `apps/worker/queueWorker.mjs` – Polling worker that executes clip jobs sequentially.
- `packages/state/index.mjs` – Tiny persistence layer built on atomic JSON file writes.
- `apps/worker/src/clip.mjs` – Core clip pipeline orchestrating Python and FFmpeg helpers.


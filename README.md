# AutoClipper Service Layer

AutoClipper converts long-form videos into branded, captioned vertical clips. The project now includes a minimal multi-tenant HTTP API, a background worker loop, persistent state on disk, and tests that exercise the platform end to end.

## Highlights

- **Multi-tenant API** – Provision tenants with an admin token and submit clip jobs via per-tenant API keys.
- **Persistent state** – SQLite-backed state database tracks tenants, job history, and delivery manifests with crash-safe WAL journaling. Output assets are written per job under `storage/jobs/`.
- **Background worker** – Concurrent worker pool downloads remote media with validation, retries failed jobs with exponential backoff, and records completion or failure metadata.
- **Configurable clips** – Override watermark text and duration limits per job while reusing the robust FFmpeg + Python toolchain.
- **Automated tests** – Vitest suite covers the REST API contract and the original clip smoke test.
- **Creator dashboard** – A session-based web app for onboarding users, uploading videos, and monitoring clip jobs without exposing raw API keys.
- **Smarter highlights** – Python `highlight_rank.py` combines energy, pacing, and caption language to prioritize the most engaging segments before clipping.
- **Captions everywhere** – Energy-aware fallback captions describe the action even when `faster-whisper` is unavailable.
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

### Launch the creator dashboard

The dashboard wraps the API with user authentication, handles uploads, and surfaces job results.

```bash
make dashboard
```

By default it listens on [http://localhost:4000](http://localhost:4000) and proxies requests to the API running on port 3000.

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

### Use the web app

1. Visit `http://localhost:4000`.
2. Register a creator account. The dashboard provisions a tenant behind the scenes using the `ADMIN_TOKEN` from `.env`.
3. Upload a video file **or** paste an external URL, customize watermark text/duration, and queue a job.
4. Track progress from the jobs table and download the generated clip, captions, or timeline when complete.

Uploaded assets are stored under `storage/uploads/` and job outputs continue to live under `storage/jobs/<jobId>/`.

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
- `STATE_FILE` – Path to the SQLite state database (default `storage/state.db`).
- `DISTRIBUTION_TARGETS` – JSON array or path describing where completed clips should be copied or uploaded (filesystem or presigned targets).
- `STORAGE_ROOT` – Root directory where job outputs live.
- `WORKER_POLL_MS` – Worker polling interval in milliseconds.
- `WORKER_CONCURRENCY` – Number of concurrent worker loops to spawn.
- `WORKER_MAX_RETRIES` – Maximum retry attempts per job (not counting the initial try).
- `WORKER_RETRY_BASE_MS` – Base delay for exponential backoff between retries.
- `WORKER_IDLE_BACKOFF_MS` – Backoff delay when the queue is empty.
- `WORKER_DOWNLOAD_MAX_BYTES` – Hard cap for remote downloads in bytes.
- `WORKER_DOWNLOAD_TIMEOUT_MS` – Timeout for remote downloads in milliseconds.
- `DASHBOARD_PORT` – Port for the creator dashboard (default `4000`).
- `API_BASE_URL` – Base URL the dashboard uses to reach the API (default `http://localhost:3000`).
- `DASHBOARD_STATE_FILE` – Path for storing dashboard user accounts (default `storage/dashboard-users.json`).
- `UPLOAD_ROOT` – Directory for uploaded source videos (default `storage/uploads`).
- `SESSION_SECRET` – Secret used to sign dashboard session cookies.
- `SESSION_STORE_FILE` – Persistent path for dashboard session storage (default `storage/dashboard-sessions.json`).

## Architecture Overview

- `apps/api/server.mjs` – Minimal Node HTTP server implementing the REST API.
- `apps/worker/queueWorker.mjs` – Concurrent worker that executes clip jobs with retries and download safeguards.
- `packages/state/index.mjs` – SQLite persistence layer managing tenants, job queueing, and delivery manifests.
- `packages/distribution/index.mjs` – Distribution engine that mirrors finished assets to local folders or presigned upload targets.
- `packages/storage/jsonStore.mjs` – Shared JSON store helper that provides locking, backups, and crash-safe writes.
- `packages/session/index.mjs` – Persistent session store used by the dashboard.
- `apps/worker/src/clip.mjs` – Core clip pipeline orchestrating Python and FFmpeg helpers, including highlight ranking.


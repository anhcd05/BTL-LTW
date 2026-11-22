# InfoSound Reco demo (isolated) — RETIRED 22/11/2026

> **Historical only.** On the user's decision there is now ONE deployment: `infosound-local` (https://localhost:3443).
> The `infosound-demo` stack, its volumes, the `:reco` images and `.runtime-private/reco-demo` were removed, so
> `start-demo.ps1`/`seed-demo.ps1`/`status-demo.ps1`/`stop-demo.ps1` no longer apply. The synthetic data now lives in the
> main DB (marked `@demo.infosound.local`, removable with `seed --reset-only --i-know-this-is-demo`). Current state:
> `../reports/REAL_STACK_RUN-20261122.md`. `update-lockfile.ps1` is still useful (regenerates the lockfile in Linux).

The isolated environment for the "Gợi ý nhạc bằng AI" feature: Compose project **`infosound-demo`**, images
`infosound/*:reco`, named volumes `infosound-demo_*`, and private runtime files in
`../.runtime-private/reco-demo/{runtime.env,secrets/,generated/}`. All data here is synthetic (see DESIGN.md §0/§7).
None of these scripts stops, rebuilds, retags or migrates the real `infosound-local` stack, and none touches its volumes or images.

Run everything from PowerShell at the repository root (`int1434\`), with Docker Desktop running Linux containers.

| Script | What it does |
|---|---|
| `start-demo.ps1 [-StandardPorts] [-NoBuild]` | Writes the demo runtime. Builds `:reco` images from an **LF snapshot** of the working tree (the CRLF checkout breaks the locale hash and bash). Generates fresh demo secrets on first run, reusing only the project CA and localhost certificates. Sets OAuth/SMTP to `{}`. Renders nginx for the demo origins. Then runs init-data, then postgres/redis/storage, then migrations, then the storage buckets, then all services, then `nginx -t`. |
| `seed-demo.ps1 [-Steps seed,embed,train,evaluate]` | Runs the batch CLI (`/repo/recommendation-ai/batch/dist/cli.js <step>`) in the demo `tools` container with `RECO_DEMO=1`, the owner DB URL and S3 keys. Reports go to `recommendation-ai/reports/`. |
| `status-demo.ps1` | Shows container health, the applied migrations, the buckets, and HTTPS checks made with the project CA trusted. |
| `update-lockfile.ps1` | Regenerates `infosound/pnpm-lock.yaml` with pnpm 10.34.9 inside a Linux container from the LF snapshot (never host pnpm). |
| `stop-demo.ps1 [-RemoveVolumes]` | Stops the demo only. `-RemoveVolumes` also deletes the `infosound-demo_*` volumes. |

Ports:
- Default (alternate) mode, which can run alongside the real stack: app/API at <https://localhost:4443>, media at `https://localhost:10943`, HTTP redirect at 28081.
- `-StandardPorts` mode: <https://localhost:3443> and media at `:9443`. The script refuses to start in this mode while `infosound-local` is running.

Only the demo API has `RECO_EXPLAIN_ENABLED=true`. Email, OAuth and Gemini moderation are off.

## Development (both stacks side by side)
```powershell
.\recommendation-ai\demo\start-demo.ps1          # build :reco + start on 4443/10943
.\recommendation-ai\demo\seed-demo.ps1           # seed -> embed -> train -> evaluate
.\recommendation-ai\demo\status-demo.ps1
.\recommendation-ai\demo\stop-demo.ps1
```

## Presentation day (exact steps)
1. Make sure Docker Desktop is running (`docker --context desktop-linux info`).
2. **You** stop the real stack. Its data and volumes are kept:
   `.\infosound\scripts\stop-local.ps1`
3. Start the demo on the standard ports. The images are already built, so this is fast:
   `.\recommendation-ai\demo\start-demo.ps1 -StandardPorts -NoBuild`
   Add `-NoBuild` only if the `:reco` images were built from the final code; otherwise leave it off.
4. If the demo volumes are fresh, seed and train:
   `.\recommendation-ai\demo\seed-demo.ps1`
5. Check: `.\recommendation-ai\demo\status-demo.ps1`. Every container should be healthy, the migrations applied, the four buckets present, and the HTTPS checks should return HTTP 200.
6. Open <https://localhost:3443>. The browser must trust the project CA, the same as for the real stack.
7. Afterwards: `.\recommendation-ai\demo\stop-demo.ps1`, then `.\infosound\scripts\start-local.ps1` to bring the real stack back.
   To go back to the alternate ports later, run `start-demo.ps1` without the switch (add `-NoBuild` if you like).

Switching between modes rewrites only `runtime.env` and `generated/nginx.conf`. Secrets and volumes stay. Synthetic seeding never targets the real DB: the batch guard needs `RECO_DEMO=1` **and** a DB host that contains "demo". The demo URLs use the host `infosound-demo-postgres`, an alias that exists only on the demo network.

## Model
The tools image bakes `Xenova/multilingual-e5-small` at HF commit `761b726dd34fb83930e26aab4e9ac3899aa1fa78` into
`/opt/reco-models/Xenova/multilingual-e5-small/`. The files are config, tokenizer and `onnx/model_quantized.onnx`, and each one is sha256-checked by BuildKit `ADD --checksum`.
The image sets `RECO_MODEL_DIR=/opt/reco-models` and `RECO_MODEL_DTYPE=q8`. ffmpeg is present in the tools image.

## Clean removal
`stop-demo.ps1 -RemoveVolumes`, then `docker image rm infosound/{api,audio-worker,background-worker,tools,web,gateway,postgres}:reco`,
then delete `..\.runtime-private\reco-demo\`.

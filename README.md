# FlowForge — Visual Workflow Automation (ALGOTHON'26 · ALG-AUTO-01)

Drag-and-drop workflow builder **plus a real execution engine**. Build a graph of triggers → actions → conditions → transforms,
press **Run**, and watch every node execute live with real data flowing through it.

```
frontend/   Next.js + React Flow editor (design system from the v0 mock-up, wired to the real API)
backend/    Python engine + FastAPI (DAG scheduler, 17 node types, SQLite, SSE/WebSocket, scheduler, NL→workflow)
```

## Run it (two terminals)
```bash
# 1) backend  → http://localhost:8000/docs
cd backend && pip install -r requirements.txt
FLOWFORGE_ALLOW_PRIVATE=1 uvicorn flowforge.api:app --port 8000

# 2) frontend → http://localhost:3000
cd frontend && pnpm install        # or npm install
echo "NEXT_PUBLIC_API_URL=http://localhost:8000" > .env.local
pnpm dev
```
Optional: `ANTHROPIC_API_KEY` (AI step + Claude-powered NL generation; offline fallback otherwise), `FLOWFORGE_SMTP_HOST` (real email; otherwise emails land in **Outbox**),
`FLOWFORGE_API_KEY` (protect the API; set the same key in the UI under Settings).
`FLOWFORGE_ALLOW_PRIVATE=1` only lets HTTP nodes call localhost for demos; the SSRF guard is ON without it.

## What the UI does
| Area | Features |
|---|---|
| **Editor** | node library generated from `GET /nodes`, drag-and-drop or click-to-add, schema-driven inspector (strings, expressions, JSON, selects, toggles), retries/backoff/timeout per node, labelled true/false/switch handles, red **error route** handle, undo/redo, auto-layout, minimap, autosave, Ctrl+S / Ctrl+Z / Ctrl+Enter / Ctrl+K |
| **Live run** | SSE stream drives the canvas: running pulse, success/duration chips, retry badges, failed shake, skipped branches dimmed, animated active edges; bottom drawer with **Logs · Data (node input/output) · Timeline waterfall · Payload** |
| **AI bar** | plain-English → validated graph, nodes animate onto the canvas |
| **Workflows / Templates** | cards with live graph previews, run/duplicate/export/delete, activate (schedules), 4 runnable templates |
| **Runs** | filterable history, **replay scrubber** (watch the execution unfold node by node), **Resume from failure**, replay, dry-replay, cancel |
| **Outbox & data** | emails produced by workflows and records saved by Data Store nodes |
| **Extras** | dry-run mode, webhook URL copy, validation badges on nodes, dark mode, command palette, responsive layout |

## 3-minute demo script
1. **Templates → Order router → Use template.** Open the *Payload* tab, press **Run now**: webhook → total calc → condition → *email* and *save* run **in parallel** → merge; the "standard order" branch is dimmed (skipped). Click a node → **Data** tab shows its exact input/output; **Timeline** shows the parallel bars.
2. Change `qty` to 1 in Payload, run again: the other branch fires, high-value branch is skipped. Toggle **Dry run** and run: no email is created (check Outbox before/after).
3. **Retries:** select an HTTP node, set URL `http://localhost:8000/mock/flaky/demo1?fail_first=2`, Retries 3 → run: amber *retry* badges, RETRY lines in Logs, then success (use a fresh key per demo).
4. **Error route:** use `…/mock/flaky/demo2?fail_first=99` with Retries 0 on the *Resilient API* template: run continues down the red **error** edge to the fallback node.
5. **Resume from failure:** in the AI bar type `Call http://localhost:8000/mock/flaky/r1?fail_first=1 then log it` → Run (fails) → **Runs** → open the run → **Resume from failure**: finished nodes are reused, only the failed one re-executes.
6. **Natural language:** type *"When a webhook arrives, if amount is greater than 100 send an email to boss@corp.com, otherwise log it"* and watch the graph build itself.
7. **Runs → drag the replay slider** to scrub through a finished execution. Activate the *Scheduled digest* template to show cron runs.

## Verification status (be honest with judges)
* **Verified here:** backend engine and API *handler logic*: 21 automated tests pass (`cd backend && python -m unittest discover -s tests -t .`): data passing, branching/merge, parallelism, retries, error routes, resume, cancel (incl. sub-workflow propagation), dry-run, idempotency, sandbox, NL generator, webhook/SSE/timeline/resume handlers.
* **Typechecked only:** frontend passes `tsc --strict` against stubbed library typings (sandbox had no network, so `npm install`/`next build` was **not** run, and FastAPI/React Flow were never executed here). `next.config.mjs` keeps `ignoreBuildErrors: true` so a stray library-typing mismatch cannot block a deploy; run `pnpm typecheck` once locally.
* First real run may need small fixes (CSS polish, a library API detail). Checklist: run backend → `./backend/demo.sh`, then walk the demo script above once before presenting.

## Deploy
* **Backend** (Render/Railway/Fly): use `backend/Dockerfile`, mount a volume at `/data` (SQLite), set `FLOWFORGE_CORS=https://<your-vercel-domain>`. On a public host leave `FLOWFORGE_ALLOW_PRIVATE` unset and demo HTTP/retry steps against a public URL such as `https://httpbin.org/status/503`.
* **Frontend** (Vercel): root directory `frontend`, env `NEXT_PUBLIC_API_URL=https://<backend-host>` (also changeable at runtime in Settings).

## Known limits
Single-process engine with SQLite (swap for Postgres + queue to scale out); loops via sub-workflow `for_each` rather than cyclic graphs; SSRF guard doesn't fully stop DNS rebinding; no per-user auth beyond the optional API key.
AI disclosure: built with AI assistance (Claude); runtime AI is optional and only used when `ANTHROPIC_API_KEY` is set.

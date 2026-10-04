"""FastAPI surface. Run:  uvicorn flowforge.api:app --port 8000   (docs at /docs)"""
import asyncio, hmac, json, os
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import Body, Depends, FastAPI, HTTPException, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.requests import HTTPConnection

from . import nl
from .engine import Engine, WorkflowError, shape_manual_payload
from .graph import auto_layout, validate_graph
from .nodes import REGISTRY, catalog
from .scheduler import Scheduler
from .store import Store
from .templates import TEMPLATES

API_KEY = os.getenv("FLOWFORGE_API_KEY")
_OPEN = ("/hooks/", "/health", "/mock/", "/docs", "/openapi.json", "/redoc")


def auth(conn: HTTPConnection):
    if not API_KEY or conn.url.path.startswith(_OPEN): return
    k = conn.headers.get("x-api-key") or conn.query_params.get("api_key")
    if not k or not hmac.compare_digest(k, API_KEY): raise HTTPException(401, "invalid or missing API key")


class Hub:
    """In-process pub/sub so SSE / WebSocket clients get run events live."""
    def __init__(self): self.subs = defaultdict(list)

    def publish(self, ev):
        for q in list(self.subs.get(ev["run_id"], [])): q.put_nowait(ev)

    def subscribe(self, rid):
        q = asyncio.Queue(); self.subs[rid].append(q); return q

    def unsubscribe(self, rid, q):
        if q in self.subs.get(rid, []): self.subs[rid].remove(q)
        if not self.subs.get(rid): self.subs.pop(rid, None)


hub = Hub()
store = Store(os.getenv("FLOWFORGE_DB", "flowforge.db"))
engine = Engine(store, on_event=hub.publish, max_parallel=int(os.getenv("FLOWFORGE_MAX_PARALLEL", "8")),
                run_timeout=int(os.getenv("FLOWFORGE_RUN_TIMEOUT", "300")))
scheduler = Scheduler(store, engine)


@asynccontextmanager
async def lifespan(app):
    n = store.mark_interrupted()
    if n: print(f"[flowforge] marked {n} interrupted run(s) as failed (resumable)")
    scheduler.start()
    yield
    scheduler.stop()


app = FastAPI(title="FlowForge — visual workflow automation engine", version="1.0", lifespan=lifespan, dependencies=[Depends(auth)])
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("FLOWFORGE_CORS", "*").split(","), allow_methods=["*"], allow_headers=["*"],
                   expose_headers=["*"])


@app.exception_handler(WorkflowError)
async def _wf_err(request, exc): return JSONResponse({"detail": "invalid workflow", "errors": exc.errors}, status_code=422)


def pub(wf):
    wf = dict(wf)
    wf["webhook_path"] = f"/hooks/{wf['id']}/{wf['webhook_token']}"
    wf["validation"] = validate_graph(wf["graph"], REGISTRY)
    return wf


def need(wid):
    wf = store.get_workflow(wid)
    if not wf: raise HTTPException(404, "workflow not found")
    return wf


# ───────────────────────────── meta
@app.get("/health")
async def health(): return {"ok": True, "nodes": len(REGISTRY)}


@app.get("/nodes", summary="Node catalog: palette + config forms for the editor")
async def nodes(): return catalog()


@app.get("/stats")
async def stats(): return store.stats()


@app.post("/validate")
async def validate(body: dict = Body(...)): return validate_graph(body.get("graph", body), REGISTRY)


@app.post("/nodes/test", summary="Run a single node in isolation (editor 'test step')")
async def test_node(body: dict = Body(...)):
    try: return await engine.test_node(body["type"], body.get("config", {}), body.get("input"), body.get("trigger"), body.get("dry_run", True))
    except Exception as e: raise HTTPException(422, str(e))


# ───────────────────────────── workflows
@app.post("/workflows", status_code=201)
async def create_workflow(body: dict = Body(...)):
    g = auto_layout(body.get("graph") or {"nodes": body.get("nodes", []), "edges": body.get("edges", [])}) if (body.get("graph") or body.get("nodes")) else {"nodes": [], "edges": []}
    return pub(store.create_workflow(body.get("name") or "Untitled workflow", g, body.get("description", "")))


@app.get("/workflows")
async def list_workflows(): return [pub(w) for w in store.list_workflows()]


@app.get("/workflows/{wid}")
async def get_workflow(wid: str): return pub(need(wid))


@app.put("/workflows/{wid}")
async def update_workflow(wid: str, body: dict = Body(...)):
    need(wid)
    return pub(store.update_workflow(wid, **{k: v for k, v in body.items() if k in ("name", "description", "graph", "active")}))


@app.post("/workflows/{wid}/activate")
async def activate(wid: str, body: dict = Body(default={"active": True})):
    need(wid); return pub(store.update_workflow(wid, active=bool(body.get("active", True))))


@app.delete("/workflows/{wid}", status_code=204)
async def delete_workflow(wid: str):
    if not store.delete_workflow(wid): raise HTTPException(404, "workflow not found")


@app.post("/workflows/{wid}/duplicate", status_code=201)
async def duplicate(wid: str):
    w = need(wid); return pub(store.create_workflow(w["name"] + " (copy)", w["graph"], w["description"]))


@app.get("/workflows/{wid}/export")
async def export(wid: str):
    w = need(wid)
    return JSONResponse({"name": w["name"], "description": w["description"], "graph": w["graph"]},
                        headers={"Content-Disposition": f'attachment; filename="{w["name"][:40]}.flowforge.json"'})


@app.post("/workflows/{wid}/run", summary="Run a workflow. wait=true blocks until finished; dry_run=true skips side-effects")
async def run_workflow(wid: str, body: dict = Body(default={})):
    wf = need(wid)
    kw = dict(trigger_type="manual", dry_run=bool(body.get("dry_run")), idempotency_key=body.get("idempotency_key"))
    payload = shape_manual_payload(wf["graph"], body.get("payload", {}))
    if body.get("wait"): return await engine.run(wf, payload, **kw)
    rid, dup = await engine.start(wf, payload, **kw)
    return JSONResponse({"run_id": rid, "deduplicated": dup, "stream": f"/runs/{rid}/stream"}, status_code=202)


@app.api_route("/hooks/{wid}/{token}", methods=["GET", "POST", "PUT", "PATCH"], summary="Public webhook entry point")
async def webhook(wid: str, token: str, request: Request, wait: bool = False):
    wf = store.get_workflow(wid)
    if not wf or not hmac.compare_digest(token, wf["webhook_token"]): raise HTTPException(404, "unknown webhook")
    raw = await request.body()
    if len(raw) > 1_000_000: raise HTTPException(413, "payload too large")
    try: parsed = json.loads(raw) if raw else {}
    except ValueError: parsed = raw.decode("utf-8", "replace")
    payload = {"body": parsed, "method": request.method, "query": dict(request.query_params),
               "headers": {k: v for k, v in request.headers.items() if k.lower() not in ("authorization", "cookie", "x-api-key")}}
    kw = dict(trigger_type="webhook", idempotency_key=request.headers.get("idempotency-key"))
    if wait: return await engine.run(wf, payload, **kw)
    rid, dup = await engine.start(wf, payload, **kw)
    return JSONResponse({"run_id": rid, "deduplicated": dup, "stream": f"/runs/{rid}/stream"}, status_code=202)


# ───────────────────────────── runs
@app.get("/runs")
async def list_runs(workflow_id: str | None = None, limit: int = 50): return store.list_runs(workflow_id, limit)


@app.get("/runs/{rid}", summary="Full run incl. per-node input/output (powers run replay / data inspector)")
async def get_run(rid: str):
    r = store.get_run(rid)
    if not r: raise HTTPException(404, "run not found")
    return r


@app.get("/runs/{rid}/events")
async def run_events(rid: str, after: int = 0): return store.events(rid, after)


def _ms(ts): return datetime.fromisoformat(ts).timestamp() * 1000


@app.get("/runs/{rid}/timeline", summary="Waterfall data: per-node start offset & duration (ms)")
async def timeline(rid: str):
    evs = store.events(rid)
    if not evs: raise HTTPException(404, "run not found")
    t0, bars = _ms(evs[0]["ts"]), {}
    for e in evs:
        n = e["node_id"]
        if e["type"] == "node_started": bars[n] = {"node_id": n, "start_ms": round(_ms(e["ts"]) - t0), "label": e["data"].get("label")}
        elif e["type"] in ("node_succeeded", "node_failed") and n in bars:
            bars[n].update(end_ms=round(_ms(e["ts"]) - t0), status="success" if e["type"] == "node_succeeded" else "failed", attempts=e["data"].get("attempts"))
    return {"total_ms": round(_ms(evs[-1]["ts"]) - t0), "bars": sorted(bars.values(), key=lambda b: b["start_ms"])}


async def _stream(rid):
    q = hub.subscribe(rid)
    try:
        last, finished = 0, False
        for ev in store.events(rid):
            last, finished = ev["id"], ev["type"] == "run_finished"; yield ev
        while not finished:
            try: ev = await asyncio.wait_for(q.get(), 15)
            except asyncio.TimeoutError: yield None; continue
            if ev["id"] <= last: continue
            last, finished = ev["id"], ev["type"] == "run_finished"; yield ev
    finally: hub.unsubscribe(rid, q)


@app.get("/runs/{rid}/stream", summary="Server-Sent Events: live node status + logs")
async def stream(rid: str):
    if not store.get_run(rid, with_graph=False): raise HTTPException(404, "run not found")

    async def gen():
        async for ev in _stream(rid):
            yield ": ping\n\n" if ev is None else f"id: {ev['id']}\nevent: {ev['type']}\ndata: {json.dumps(ev, default=str)}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.websocket("/ws/runs/{rid}")
async def ws_run(ws: WebSocket, rid: str):
    await ws.accept()
    try:
        async for ev in _stream(rid):
            if ev is not None: await ws.send_json(ev)
        await ws.close()
    except Exception: pass


@app.post("/runs/{rid}/cancel")
async def cancel(rid: str):
    if not engine.cancel(rid): raise HTTPException(409, "run is not running")
    return {"cancelled": True}


@app.post("/runs/{rid}/resume", summary="Re-run a failed run, reusing every node that already succeeded")
async def resume(rid: str):
    try: new, _ = await engine.resume(rid)
    except KeyError: raise HTTPException(404, "run not found")
    return JSONResponse({"run_id": new, "resumed_from": rid, "stream": f"/runs/{new}/stream"}, status_code=202)


@app.post("/runs/{rid}/replay", summary="Run the same snapshot + payload again from scratch")
async def replay(rid: str, body: dict = Body(default={})):
    r = store.get_run(rid)
    if not r: raise HTTPException(404, "run not found")
    wf = {"id": r["workflow_id"], "version": r["workflow_version"], "graph": r["graph"]}
    new, _ = await engine.start(wf, r["trigger"], trigger_type=r["trigger_type"], dry_run=bool(body.get("dry_run", r["dry_run"])))
    return JSONResponse({"run_id": new, "stream": f"/runs/{new}/stream"}, status_code=202)


# ───────────────────────────── AI, templates, data
@app.post("/ai/generate", summary="Describe a workflow in plain English -> validated graph")
async def ai_generate(body: dict = Body(...)):
    if not str(body.get("prompt", "")).strip(): raise HTTPException(422, "prompt required")
    res = await nl.generate(body["prompt"])
    if body.get("save"): res["workflow"] = pub(store.create_workflow(res["name"], res["graph"]))
    return res


@app.get("/templates")
async def templates(): return [{"id": k, **v} for k, v in TEMPLATES.items()]


@app.post("/templates/{tid}/instantiate", status_code=201)
async def instantiate(tid: str):
    t = TEMPLATES.get(tid)
    if not t: raise HTTPException(404, "template not found")
    return pub(store.create_workflow(t["name"], json.loads(json.dumps(t["graph"])), t["description"]))


@app.get("/outbox", summary="Emails produced by Send Email nodes when SMTP is not configured")
async def outbox(): return store.outbox()


@app.get("/records/{collection}")
async def records(collection: str): return store.rec_list(collection)


# ───────────────────────────── built-in mock endpoints (demo retries without internet)
_FLAKY = {}
if os.getenv("FLOWFORGE_ENABLE_MOCK", "1") == "1":
    @app.get("/mock/flaky/{key}", summary="Fails the first N calls with 503, then succeeds (retry demo)")
    async def flaky(key: str, fail_first: int = 2):
        _FLAKY[key] = _FLAKY.get(key, 0) + 1
        if _FLAKY[key] <= fail_first: raise HTTPException(503, f"temporarily unavailable (call {_FLAKY[key]})")
        return {"ok": True, "calls": _FLAKY[key], "items": [{"sku": "A", "price": 40}, {"sku": "B", "price": 75}, {"sku": "C", "price": 120}]}

    @app.api_route("/mock/echo", methods=["GET", "POST"])
    async def echo(request: Request):
        raw = await request.body()
        return {"method": request.method, "body": json.loads(raw) if raw else None}

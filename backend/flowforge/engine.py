"""Execution engine: DAG scheduler with branch routing, parallelism, retries, timeouts,
error routing, resume-from-failure, dry-run, idempotency, cancellation and live events."""
import asyncio, json, random, time
from collections import defaultdict

from .expr import render
from .graph import get_config, get_label, get_settings, slug, topo_order, validate_graph
from .nodes import REGISTRY, NodeError, Out
from .store import dumps, uid


class WorkflowError(Exception):
    def __init__(self, errors):
        super().__init__("; ".join(errors)); self.errors = errors


def shape_manual_payload(graph, payload):
    """A manual run of a webhook-only workflow behaves like a webhook call: payload becomes trigger.body."""
    types = {n["type"] for n in graph.get("nodes", []) if str(n.get("type", "")).startswith("trigger.")}
    if types == {"trigger.webhook"} and not (isinstance(payload, dict) and "body" in payload):
        return {"body": payload, "method": "POST", "query": {}, "headers": {}}
    return payload


class RunState:
    def __init__(self, rid, wf_id, graph, trigger, dry_run, depth, max_parallel, timeout):
        self.id, self.wf_id, self.graph, self.trigger = rid, wf_id, graph, trigger
        self.dry_run, self.depth, self.timeout = dry_run, depth, timeout
        self.vars, self.view, self.status = {}, {}, {}
        self.sem = asyncio.Semaphore(max_parallel)
        self.t0 = time.time()


class Ctx:
    """What a node implementation sees."""
    def __init__(self, engine, rs, node_id, inputs, inp):
        self.engine, self.rs, self.node_id, self.inputs, self.input = engine, rs, node_id, inputs, inp
        self.store, self.run_id, self.workflow_id = engine.store, rs.id, rs.wf_id
        self.dry_run, self.depth, self.vars = rs.dry_run, rs.depth, rs.vars

    def env(self):
        return {"trigger": self.rs.trigger, "input": self.input, "inputs": self.inputs, "nodes": self.rs.view,
                "vars": self.rs.vars, "run": {"id": self.rs.id, "dry_run": self.rs.dry_run}}

    def log(self, msg, level="info"):
        self.engine.emit(self.rs.id, "log", self.node_id, level=level, message=str(msg)[:2000])


def _preview(v, n=400):
    s = dumps(v)
    return s if len(s) <= n else s[:n] + "…"


class Engine:
    def __init__(self, store, on_event=None, max_parallel=8, run_timeout=300):
        self.store, self.on_event, self.max_parallel, self.run_timeout = store, on_event, max_parallel, run_timeout
        self.tasks = {}

    # ---------------------------------------------------------------- events
    def emit(self, rid, typ, node_id=None, **data):
        ev = self.store.add_event(rid, typ, node_id, **data)
        if self.on_event:
            try: self.on_event(ev)
            except Exception: pass
        return ev

    # ---------------------------------------------------------------- public API
    async def start(self, wf, trigger=None, *, trigger_type="manual", dry_run=False, idempotency_key=None,
                    resume_states=None, resumed_from=None, depth=0, parent_run_id=None):
        """Create the run record and launch it in the background. Returns (run_id, deduplicated)."""
        if idempotency_key:
            ex = self.store.run_by_key(wf["id"], idempotency_key)
            if ex: return ex["id"], True
        v = validate_graph(wf["graph"], REGISTRY)
        if not v["valid"]: raise WorkflowError(v["errors"])
        rid = uid()
        self.store.create_run(rid, wf["id"], wf.get("version", 1), trigger_type, trigger if trigger is not None else {},
                              wf["graph"], dry_run, resumed_from, parent_run_id, idempotency_key)
        rs = RunState(rid, wf["id"], wf["graph"], trigger if trigger is not None else {}, dry_run, depth, self.max_parallel, self.run_timeout)
        self.emit(rid, "run_started", trigger_type=trigger_type, dry_run=dry_run, resumed_from=resumed_from)
        self.tasks[rid] = asyncio.create_task(self._runner(rs, trigger_type, resume_states or {}))
        return rid, False

    async def run(self, wf, trigger=None, *, propagate_cancel=False, **kw):
        """Start and await a run. With propagate_cancel (used by sub-workflows) cancelling the caller cancels the run."""
        rid, dup = await self.start(wf, trigger, **kw)
        t = self.tasks.get(rid)
        if t:
            try: await asyncio.shield(t)
            except asyncio.CancelledError:
                if propagate_cancel: t.cancel()
                raise
        return self.store.get_run(rid)

    async def resume(self, run_id):
        prev = self.store.get_run(run_id)
        if not prev: raise KeyError(run_id)
        if prev["status"] == "success": raise WorkflowError(["run already succeeded; nothing to resume"])
        if prev["status"] == "running": raise WorkflowError(["run is still running"])
        states = {nid: {"output": n["output"], "handles": n["handles"]} for nid, n in prev["nodes"].items() if n["status"] == "success"}
        wf = {"id": prev["workflow_id"], "version": prev["workflow_version"], "graph": prev["graph"]}
        return await self.start(wf, prev["trigger"], trigger_type=prev["trigger_type"], dry_run=prev["dry_run"],
                                resume_states=states, resumed_from=run_id)

    def cancel(self, run_id):
        t = self.tasks.get(run_id)
        if not t or t.done(): return False
        t.cancel(); return True

    async def test_node(self, type_, config, inp=None, trigger=None, dry_run=True):
        """Run one node in isolation (editor 'test step' button)."""
        spec = REGISTRY.get(type_)
        if not spec: raise WorkflowError([f"unknown node type '{type_}'"])
        rs = RunState("test", None, {"nodes": [], "edges": []}, trigger or {}, dry_run, 0, 1, 30)
        ctx = Ctx(self, rs, "test", {"in": inp}, inp)
        rcfg = {k: (v if k in spec["expr"] else render(v, ctx.env())) for k, v in config.items()}
        res = await spec["fn"](ctx, rcfg, inp)
        out, handles = (res.output, res.handles) if isinstance(res, Out) else (res, ["out"])
        return {"output": json.loads(dumps(out)), "handles": handles}

    # ---------------------------------------------------------------- internals
    async def _runner(self, rs, trigger_type, resume):
        try:
            status, err = await asyncio.wait_for(self._execute(rs, trigger_type, resume), rs.timeout)
        except asyncio.TimeoutError: status, err = "timed_out", f"run exceeded {rs.timeout}s"
        except asyncio.CancelledError: status, err = "cancelled", "cancelled by user"
        except Exception as e: status, err = "failed", f"internal error: {e!r}"
        try: self._finish(rs, status, err)
        finally: self.tasks.pop(rs.id, None)

    def _finish(self, rs, status, err):
        # sweep anything that never completed
        for nid, st in rs.status.items():
            if st in ("running", "queued", "pending"):
                self.store.save_node_run(rs.id, nid, "cancelled", 0, None, None, None, "run ended before this node ran")
        g = rs.graph
        has_out = {e["source"] for e in g.get("edges", [])}
        leaves = [n["id"] for n in g["nodes"] if n["id"] not in has_out and rs.status.get(n["id"]) == "success"]
        vals = {i: rs.view[i]["output"] for i in leaves if i in rs.view}
        output = None if not vals else (next(iter(vals.values())) if len(vals) == 1 else vals)
        dur = int((time.time() - rs.t0) * 1000)
        self.store.finish_run(rs.id, status, err, output, dur)
        self.emit(rs.id, "run_finished", status=status, error=err, duration_ms=dur)

    async def _execute(self, rs, trigger_type, resume):
        g = rs.graph
        nodes = {n["id"]: n for n in g["nodes"]}
        inc, out = defaultdict(list), defaultdict(list)
        for i, e in enumerate(g.get("edges", [])):
            e = {**e, "_i": i, "h": e.get("sourceHandle") or "out"}
            inc[e["target"]].append(e); out[e["source"]].append(e)
        order = topo_order(g)
        edge, outputs, handles_of, running = {}, {}, {}, {}
        rs.status = {nid: "pending" for nid in nodes}
        trig = [i for i in order if REGISTRY[nodes[i]["type"]]["trigger"]]
        chosen = [i for i in trig if nodes[i]["type"] == f"trigger.{trigger_type}"] or trig
        labels = {nid: slug(get_label(n)) for nid, n in nodes.items()}
        fatal = None

        def resolve(nid, hs):
            handles_of[nid] = hs
            for e in out[nid]: edge[e["_i"]] = e["h"] in hs

        def done(nid, output, hs, status="success"):
            rs.status[nid] = status
            rs.view[nid] = {"output": output, "status": status}
            a = labels[nid]
            if a and a not in nodes and a not in rs.view: rs.view[a] = rs.view[nid]
            outputs[nid] = output
            resolve(nid, hs)

        def skip(nid):
            rs.status[nid] = "skipped"
            resolve(nid, [])
            self.store.save_node_run(rs.id, nid, "skipped")
            self.emit(rs.id, "node_skipped", nid)

        def settle():
            ready, changed = [], True
            while changed:
                changed = False
                for nid in order:
                    if rs.status[nid] != "pending": continue
                    ins = inc[nid]
                    if any(edge.get(e["_i"]) is None for e in ins): continue
                    if REGISTRY[nodes[nid]["type"]]["trigger"]:
                        if nid in chosen: rs.status[nid] = "queued"; ready.append(nid)
                        else: skip(nid); changed = True
                    elif not any(edge[e["_i"]] for e in ins): skip(nid); changed = True
                    else: rs.status[nid] = "queued"; ready.append(nid)
            return ready

        try:
            while True:
                ready, reused = settle(), False
                to_run = []
                for nid in ready:
                    if nid in resume:
                        r = resume[nid]
                        done(nid, r["output"], r["handles"] or ["out"])
                        self.store.save_node_run(rs.id, nid, "success", 0, None, r["output"], r["handles"], None)
                        self.emit(rs.id, "node_reused", nid, output=_preview(r["output"])); reused = True
                    else: to_run.append(nid)
                if reused: continue
                for nid in to_run:
                    active = [e for e in inc[nid] if edge[e["_i"]]]
                    inputs = {e["source"]: outputs[e["source"]] for e in active}
                    inp = rs.trigger if not inc[nid] else (next(iter(inputs.values())) if len(inputs) == 1 else dict(inputs))
                    t = asyncio.create_task(self._run_node(rs, nid, nodes[nid], inputs, inp))
                    running[t] = nid
                if not running: break
                fin, _ = await asyncio.wait(running, return_when=asyncio.FIRST_COMPLETED)
                for t in fin:
                    nid = running.pop(t); r = t.result()
                    if r["status"] == "success": done(nid, r["output"], r["handles"])
                    elif any(e["h"] == "error" for e in out[nid]):
                        done(nid, {"error": r["error"], "node": nid}, ["error"], status="failed")
                        self.emit(rs.id, "node_error_routed", nid, error=r["error"])
                    else:
                        rs.status[nid] = "failed"
                        fatal = fatal or f"node '{get_label(nodes[nid])}' ({nid}) failed: {r['error']}"
                if fatal: break
        finally:
            for t in running: t.cancel()
        if fatal: return "failed", fatal
        return "success", None

    async def _run_node(self, rs, nid, node, inputs, inp):
        spec = REGISTRY[node["type"]]
        cfg, st = get_config(node), get_settings(node)
        for f in spec["config"]:
            if f["name"] not in cfg and f.get("default") is not None: cfg = {**cfg, f["name"]: f["default"]}
        retries = max(0, min(int(st.get("retries", 0)), 5))
        backoff, timeout = float(st.get("backoff", 0.5)), min(float(st.get("timeout", 30)), 300)
        t0, attempts, err = time.time(), 0, None
        started = time.strftime("%Y-%m-%dT%H:%M:%S")
        async with rs.sem:
            rs.status[nid] = "running"
            self.store.save_node_run(rs.id, nid, "running", 0, inp, started=started)
            self.emit(rs.id, "node_started", nid, label=get_label(node), type=node["type"], input=_preview(inp))
            while True:
                attempts += 1
                ctx = Ctx(self, rs, nid, inputs, inp)
                try:
                    env = ctx.env()
                    rcfg = {k: (v if k in spec["expr"] else render(v, env)) for k, v in cfg.items()}
                    res = await asyncio.wait_for(spec["fn"](ctx, rcfg, inp), timeout)
                    output, hs = (res.output, res.handles) if isinstance(res, Out) else (res, ["out"])
                    blob = dumps(output)
                    if len(blob) > 1_000_000: raise NodeError("node output larger than 1 MB", permanent=True)
                    output = json.loads(blob)
                    dur = int((time.time() - t0) * 1000)
                    self.store.save_node_run(rs.id, nid, "success", attempts, inp, output, hs, None, started, time.strftime("%Y-%m-%dT%H:%M:%S"), dur)
                    self.emit(rs.id, "node_succeeded", nid, duration_ms=dur, attempts=attempts, handles=hs, output=_preview(output))
                    return {"status": "success", "output": output, "handles": hs}
                except asyncio.TimeoutError:
                    err = NodeError(f"timed out after {timeout:g}s")
                except Exception as e:
                    err = e
                if attempts > retries or getattr(err, "permanent", False): break
                delay = backoff * (2 ** (attempts - 1)) * (0.8 + 0.4 * random.random())
                self.emit(rs.id, "node_retry", nid, attempt=attempts, error=str(err), retry_in=round(delay, 2))
                await asyncio.sleep(delay)
            dur = int((time.time() - t0) * 1000)
            msg = str(err) or err.__class__.__name__
            self.store.save_node_run(rs.id, nid, "failed", attempts, inp, None, None, msg, started, time.strftime("%Y-%m-%dT%H:%M:%S"), dur)
            self.emit(rs.id, "node_failed", nid, error=msg, attempts=attempts, duration_ms=dur)
            return {"status": "failed", "error": msg}

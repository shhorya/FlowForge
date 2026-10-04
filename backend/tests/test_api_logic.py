"""Exercises the API handler functions directly (works with real FastAPI or the tiny stub below).
It verifies endpoint LOGIC (payload shaping, webhooks, streaming, resume, timeline...), not HTTP wiring."""
import asyncio, json, os, sys, types, unittest

os.environ["FLOWFORGE_DB"] = ":memory:"; os.environ["FLOWFORGE_ALLOW_PRIVATE"] = "1"
try:
    import fastapi  # noqa: F401
except ImportError:  # minimal stand-in so handler logic is testable without the dependency
    def _mod(name, **attrs):
        m = types.ModuleType(name); m.__dict__.update(attrs); sys.modules[name] = m; return m
    class _App:
        def __init__(self, *a, **k): pass
        def __getattr__(self, n):
            if n in ("get", "post", "put", "delete", "websocket", "exception_handler", "api_route"):
                return lambda *a, **k: (lambda f: f)
            return lambda *a, **k: None
    class HTTPException(Exception):
        def __init__(self, status_code, detail=None): self.status_code, self.detail = status_code, detail
    class _Resp:
        def __init__(self, content=None, status_code=200, headers=None, media_type=None): self.content, self.status_code, self.headers = content, status_code, headers or {}
    class _Stream(_Resp):
        def __init__(self, gen, media_type=None, headers=None): self.body_iterator, self.status_code, self.headers = gen, 200, headers or {}
    _mod("fastapi", Body=lambda *a, **k: None, Depends=lambda f: f, FastAPI=_App, HTTPException=HTTPException, Request=object, WebSocket=object)
    _mod("fastapi.middleware"); _mod("fastapi.middleware.cors", CORSMiddleware=object)
    _mod("fastapi.responses", JSONResponse=_Resp, StreamingResponse=_Stream)
    _mod("starlette"); _mod("starlette.requests", HTTPConnection=object)

from flowforge import api
from flowforge.templates import TEMPLATES


class FakeReq:
    def __init__(self, body=b"{}", headers=None, method="POST"):
        self._b, self.headers, self.method, self.query_params = body, headers or {}, method, {}
    async def body(self): return self._b


class ApiLogic(unittest.IsolatedAsyncioTestCase):
    async def test_end_to_end(self):
        wf = await api.instantiate("order-router")
        self.assertTrue(wf["webhook_path"].startswith("/hooks/")); self.assertTrue(wf["validation"]["valid"])
        # manual run of a webhook workflow: raw sample payload is wrapped into trigger.body
        r = await api.run_workflow(wf["id"], {"payload": TEMPLATES["order-router"]["sample_payload"], "wait": True})
        self.assertEqual(r["status"], "success", r["error"]); self.assertEqual(r["nodes"]["calc"]["output"]["total"], 148.5)
        # real webhook with idempotency key
        _, wid, token = wf["webhook_path"].rsplit("/", 2)[0], wf["id"], wf["webhook_path"].rsplit("/", 1)[1]
        req = lambda: FakeReq(json.dumps({"id": "W", "qty": 1, "price": 10, "email": "a@b.co"}).encode(), {"idempotency-key": "k1", "authorization": "secret"})
        res = await api.webhook(wid, token, req(), wait=True)
        self.assertEqual(res["status"], "success"); self.assertNotIn("authorization", res["trigger"]["headers"])
        again = await api.webhook(wid, token, req(), wait=False)
        self.assertTrue(json.loads(json.dumps(again.content))["deduplicated"])
        with self.assertRaises(api.HTTPException) as c: await api.webhook(wid, "wrong", req(), wait=False)
        self.assertEqual(c.exception.status_code, 404)
        # async run + SSE stream replays and terminates on run_finished
        acc = await api.run_workflow(wf["id"], {"payload": TEMPLATES["order-router"]["sample_payload"]})
        rid = acc.content["run_id"]; self.assertEqual(acc.status_code, 202)
        resp = await api.stream(rid); chunks = []
        async def drain():
            async for c in resp.body_iterator: chunks.append(c)
        await asyncio.wait_for(drain(), 10)
        text = "".join(chunks); self.assertIn("event: run_started", text); self.assertIn("event: run_finished", text)
        tl = await api.timeline(rid); self.assertTrue(tl["bars"]); self.assertGreaterEqual(tl["total_ms"], 0)
        evs = await api.run_events(rid, 0); self.assertEqual(evs[-1]["type"], "run_finished")

    async def test_resume_validate_ai_and_errors(self):
        flaky = {"nodes": [{"id": "t", "type": "trigger.manual"}, {"id": "h", "type": "action.http", "data": {"config": {"url": "http://127.0.0.1:1/x"}}}], "edges": [{"source": "t", "target": "h"}]}
        wf = await api.create_workflow({"name": "bad", "graph": flaky})
        r = await api.run_workflow(wf["id"], {"wait": True}); self.assertEqual(r["status"], "failed")
        acc = await api.resume(r["id"]); self.assertEqual(acc.status_code, 202)
        await asyncio.sleep(0.3)
        with self.assertRaises(api.HTTPException): await api.resume("nope")
        v = await api.validate({"graph": {"nodes": [], "edges": []}}); self.assertFalse(v["valid"])
        g = await api.ai_generate({"prompt": "When a webhook arrives, log it", "save": True}); self.assertTrue(g["validation"]["valid"]); self.assertIn("workflow", g)
        cat = await api.nodes(); self.assertGreaterEqual(len(cat), 17); self.assertTrue(any(c["type"] == "logic.switch" and c["handles"] == "dynamic" for c in cat))
        st = await api.stats(); self.assertGreaterEqual(st["runs"], 1)
        upd = await api.update_workflow(wf["id"], {"name": "renamed", "active": True}); self.assertTrue(upd["active"]); self.assertEqual(upd["name"], "renamed")
        await api.delete_workflow(wf["id"])
        with self.assertRaises(api.HTTPException): await api.get_workflow(wf["id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

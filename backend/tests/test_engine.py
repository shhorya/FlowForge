import asyncio, json, os, threading, time, unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

os.environ["FLOWFORGE_ALLOW_PRIVATE"] = "1"
from flowforge import nl
from flowforge.engine import Engine, WorkflowError
from flowforge.expr import ExprError, evaluate, render
from flowforge.graph import validate_graph
from flowforge.nodes import REGISTRY
from flowforge.scheduler import cron_match
from flowforge.store import Store
from flowforge.templates import E, N, TEMPLATES

HITS = {}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_GET(self):
        key = self.path.split("/")[-1]
        HITS[key] = HITS.get(key, 0) + 1
        if self.path.startswith("/flaky") and HITS[key] <= 2:
            self.send_response(503); self.end_headers(); self.wfile.write(b"busy"); return
        if self.path.startswith("/bad"):
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"hits": HITS[key], "items": [{"p": 5}, {"p": 15}, {"p": 25}]}).encode())


SRV = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=SRV.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{SRV.server_port}"


def wf(nodes, edges, store, name="t"):
    return store.create_workflow(name, {"nodes": nodes, "edges": edges})


class Expr(unittest.TestCase):
    def test_basics(self):
        env = {"input": {"a": 5, "items": [{"p": 2}, {"p": 3}], "name": "Ada"}, "trigger": {}}
        self.assertEqual(evaluate("input.a * 2 + 1", env), 11)
        self.assertEqual(evaluate("sum(i.p for i in input.items if i.p > 2)", env), 3)
        self.assertEqual(evaluate("input.missing.deep", env), None)
        self.assertEqual(evaluate("input.name.upper()", env), "ADA")
        self.assertEqual(render("Hi {{ input.name }}!", env), "Hi Ada!")
        self.assertEqual(render("{{ input.a }}", env), 5)

    def test_sandbox(self):
        for bad in ["__import__('os')", "input.__class__", "().__class__.__bases__", "open('x')", "input.name.format()", "2 ** 9999", "[x for x in range(3)]"]:
            with self.assertRaises(ExprError, msg=bad): evaluate(bad, {"input": {"name": "x"}})


class Flow(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.s = Store(":memory:"); self.e = Engine(self.s)

    async def test_data_passing_and_branching(self):
        w = self.s.create_workflow("o", TEMPLATES["order-router"]["graph"])
        r = await self.e.run(w, {"body": TEMPLATES["order-router"]["sample_payload"]}, trigger_type="webhook")
        self.assertEqual(r["status"], "success", r["error"])
        self.assertEqual(r["nodes"]["calc"]["output"]["total"], 148.5)
        self.assertEqual(r["nodes"]["small"]["status"], "skipped")
        self.assertEqual(r["nodes"]["join"]["status"], "success")
        self.assertEqual(len(self.s.outbox()), 1)
        self.assertEqual(len(self.s.rec_list("priority_orders")), 1)
        r2 = await self.e.run(w, {"body": {"id": "B", "qty": 1, "price": 5, "email": "x@y.io"}}, trigger_type="webhook")
        self.assertEqual((r2["nodes"]["small"]["status"], r2["nodes"]["mail"]["status"], r2["nodes"]["join"]["status"]), ("success", "skipped", "skipped"))
        self.assertEqual(r2["status"], "success")

    async def test_parallel_is_concurrent(self):
        w = wf([N("t", "trigger.manual"), N("a", "action.delay", {"seconds": 0.4}), N("b", "action.delay", {"seconds": 0.4}),
                N("c", "action.delay", {"seconds": 0.4}), N("m", "logic.merge", {"mode": "list"})],
               [E("t", "a"), E("t", "b"), E("t", "c"), E("a", "m"), E("b", "m"), E("c", "m")], self.s)
        t = time.time(); r = await self.e.run(w, {"x": 1}); d = time.time() - t
        self.assertEqual(r["status"], "success"); self.assertLess(d, 0.9); self.assertEqual(len(r["output"]), 3)

    async def test_retry_then_success(self):
        w = wf([N("t", "trigger.manual"), N("h", "action.http", {"url": f"{BASE}/flaky/k1"}, settings={"retries": 3, "backoff": 0.05})], [E("t", "h")], self.s)
        r = await self.e.run(w, {})
        self.assertEqual((r["status"], r["nodes"]["h"]["attempts"]), ("success", 3))
        self.assertEqual(sum(1 for ev in self.s.events(r["id"]) if ev["type"] == "node_retry"), 2)

    async def test_permanent_error_not_retried_and_fails_run(self):
        w = wf([N("t", "trigger.manual"), N("h", "action.http", {"url": f"{BASE}/bad/x"}, settings={"retries": 3, "backoff": 0.01}), N("z", "action.log", {"message": "never"})],
               [E("t", "h"), E("h", "z")], self.s)
        r = await self.e.run(w, {})
        self.assertEqual(r["status"], "failed"); self.assertEqual(r["nodes"]["h"]["attempts"], 1)
        self.assertEqual(r["nodes"]["z"]["status"], "cancelled")

    async def test_error_route(self):
        w = wf([N("t", "trigger.manual"), N("h", "action.http", {"url": f"{BASE}/bad/y"}), N("ok", "action.log", {"message": "ok"}),
                N("fb", "action.log", {"message": "caught {{ input.error }}"})], [E("t", "h"), E("h", "ok"), E("h", "fb", "error")], self.s)
        r = await self.e.run(w, {})
        self.assertEqual(r["status"], "success"); self.assertEqual(r["nodes"]["fb"]["status"], "success"); self.assertEqual(r["nodes"]["ok"]["status"], "skipped")

    async def test_resume_reuses_successful_nodes(self):
        HITS.pop("k2", None)
        w = wf([N("t", "trigger.manual"), N("ins", "action.db", {"operation": "insert", "collection": "c", "data": {"n": 1}}),
                N("h", "action.http", {"url": f"{BASE}/flaky/k2"})], [E("t", "ins"), E("ins", "h")], self.s)
        r1 = await self.e.run(w, {})
        self.assertEqual(r1["status"], "failed")
        HITS["k2"] = 5  # service recovers
        rid, _ = await self.e.resume(r1["id"]); await self.e.tasks[rid] if rid in self.e.tasks else None
        r2 = self.s.get_run(rid)
        self.assertEqual(r2["status"], "success"); self.assertEqual(r2["resumed_from"], r1["id"])
        self.assertEqual(len(self.s.rec_list("c")), 1)  # upstream side-effect NOT repeated
        self.assertTrue(any(ev["type"] == "node_reused" for ev in self.s.events(rid)))

    async def test_switch_and_dry_run_and_idempotency(self):
        w = wf([N("t", "trigger.manual"), N("sw", "logic.switch", {"cases": [{"handle": "a", "when": "input.v == 1"}, {"handle": "b", "when": "input.v == 2"}]}),
                N("ma", "action.email", {"to": "a@b.co", "subject": "s"}), N("mb", "action.log", {"message": "b"}), N("md", "action.log", {"message": "d"})],
               [E("t", "sw"), E("sw", "ma", "a"), E("sw", "mb", "b"), E("sw", "md", "default")], self.s)
        r = await self.e.run(w, {"v": 1}, dry_run=True)
        self.assertEqual((r["nodes"]["ma"]["status"], r["nodes"]["mb"]["status"]), ("success", "skipped"))
        self.assertEqual(len(self.s.outbox()), 0)
        r = await self.e.run(w, {"v": 9}); self.assertEqual(r["nodes"]["md"]["status"], "success")
        a, d1 = await self.e.start(w, {"v": 1}, idempotency_key="k"); b, d2 = await self.e.start(w, {"v": 1}, idempotency_key="k")
        self.assertEqual((a, d1, b, d2), (a, False, a, True)); await self.e.tasks[a]

    async def test_cancel_and_timeout(self):
        w = wf([N("t", "trigger.manual"), N("d", "action.delay", {"seconds": 10})], [E("t", "d")], self.s)
        rid, _ = await self.e.start(w, {}); await asyncio.sleep(0.2)
        task = self.e.tasks[rid]; self.assertTrue(self.e.cancel(rid)); await task
        self.assertEqual(self.s.get_run(rid)["status"], "cancelled")
        w2 = wf([N("t", "trigger.manual"), N("d", "action.delay", {"seconds": 5}, settings={"timeout": 0.2})], [E("t", "d")], self.s)
        r = await self.e.run(w2, {}); self.assertEqual(r["status"], "failed"); self.assertIn("timed out", r["error"])

    async def test_subworkflow_for_each(self):
        child = wf([N("t", "trigger.manual"), N("s", "transform.set", {"fields": {"double": "{{ input.p * 2 }}"}})], [E("t", "s")], self.s, "child")
        w = wf([N("t", "trigger.manual"), N("f", "action.subworkflow", {"workflow_id": child["id"], "for_each": "input.items"}),
                N("agg", "transform.aggregate", {"items": "input.results", "op": "sum", "field": "double"})], [E("t", "f"), E("f", "agg")], self.s)
        r = await self.e.run(w, {"items": [{"p": 1}, {"p": 2}, {"p": 3}]})
        self.assertEqual(r["status"], "success", r["error"]); self.assertEqual(r["output"]["result"], 12)

    async def test_http_transform_pipeline(self):
        w = wf([N("t", "trigger.manual"), N("h", "action.http", {"url": f"{BASE}/ok/z"}), N("f", "transform.filter", {"items": "input.body.items", "condition": "item.p > 10"}),
                N("a", "transform.aggregate", {"items": "input", "op": "avg", "field": "p"})], [E("t", "h"), E("h", "f"), E("f", "a")], self.s)
        r = await self.e.run(w, {}); self.assertEqual(r["output"]["result"], 20)

    async def test_nl_fallback_generates_runnable_flow(self):
        g = await nl.generate("When a webhook arrives, if amount is greater than 100 then send an email to boss@corp.com, otherwise log it")
        self.assertTrue(g["validation"]["valid"], g)
        w = self.s.create_workflow("nl", g["graph"])
        r = await self.e.run(w, {"body": {"amount": 250}}, trigger_type="webhook")
        self.assertEqual(r["status"], "success", r["error"]); self.assertEqual(len(self.s.outbox()), 1)

    async def test_node_test_mode(self):
        r = await self.e.test_node("transform.set", {"fields": {"x": "{{ input.a + 1 }}"}}, {"a": 1}); self.assertEqual(r["output"], {"x": 2})


class Validation(unittest.TestCase):
    def test_cycle_and_errors(self):
        g = {"nodes": [N("t", "trigger.manual"), N("a", "action.log", {"message": "x"}), N("b", "action.log", {"message": "y"})],
             "edges": [E("t", "a"), E("a", "b"), E("b", "a")]}
        v = validate_graph(g, REGISTRY); self.assertFalse(v["valid"]); self.assertTrue(any("cycle" in x for x in v["errors"]))
        v = validate_graph({"nodes": [N("a", "action.log", {})], "edges": []}, REGISTRY)
        self.assertTrue(any("trigger" in x for x in v["errors"])); self.assertTrue(any("required" in x for x in v["errors"]))
        v = validate_graph({"nodes": [N("t", "trigger.manual"), N("i", "logic.if", {"condition": "true"}), N("l", "action.log", {"message": "m"})],
                            "edges": [E("t", "i"), E("i", "l", "maybe")]}, REGISTRY)
        self.assertTrue(any("handle" in x for x in v["errors"]))

    def test_cron(self):
        d = datetime(2026, 10, 5, 9, 30, tzinfo=timezone.utc)  # Monday
        self.assertTrue(cron_match("30 9 * * 1", d)); self.assertTrue(cron_match("*/15 * * * *", d)); self.assertFalse(cron_match("0 9 * * *", d))

    def test_templates_valid(self):
        for k, t in TEMPLATES.items(): self.assertTrue(validate_graph(t["graph"], REGISTRY)["valid"], k)


if __name__ == "__main__":
    unittest.main(verbosity=2)


class Regression(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_propagates_to_subworkflow(self):
        s = Store(":memory:"); e = Engine(s)
        child = wf([N("t", "trigger.manual"), N("d", "action.delay", {"seconds": 10})], [E("t", "d")], s, "child")
        w = wf([N("t", "trigger.manual"), N("s", "action.subworkflow", {"workflow_id": child["id"]})], [E("t", "s")], s)
        rid, _ = await e.start(w, {}); await asyncio.sleep(0.3)
        kids = [r for r in s.list_runs() if r["workflow_id"] == child["id"]]
        self.assertEqual(len(kids), 1)
        task = e.tasks[rid]; e.cancel(rid); await task; await asyncio.sleep(0.25)
        self.assertEqual(s.get_run(kids[0]["id"])["status"], "cancelled")

    def test_manual_payload_shaping(self):
        from flowforge.engine import shape_manual_payload as sh
        hook = {"nodes": [{"type": "trigger.webhook"}, {"type": "action.log"}]}
        self.assertEqual(sh(hook, {"a": 1})["body"], {"a": 1})
        self.assertEqual(sh(hook, {"body": {"a": 1}}), {"body": {"a": 1}})
        self.assertEqual(sh({"nodes": [{"type": "trigger.manual"}]}, {"a": 1}), {"a": 1})

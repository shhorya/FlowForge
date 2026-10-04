"""Node library. Each node = spec (for the editor palette/forms) + async implementation."""
import asyncio, ipaddress, json, os, re, smtplib, socket
from dataclasses import dataclass
from email.message import EmailMessage
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from . import llm
from .expr import ExprError, evaluate

REGISTRY = {}


class NodeError(Exception):
    def __init__(self, msg, permanent=False):
        super().__init__(msg); self.permanent = permanent


@dataclass
class Out:
    output: object
    handles: list
    note: str = ""


def F(name, type="string", required=False, default=None, help="", options=None):
    return {"name": name, "type": type, "required": required, "default": default, "help": help, "options": options}


def node(type, label, category, desc, config=(), handles=("out",), expr=(), trigger=False, icon="box"):
    def deco(fn):
        REGISTRY[type] = {"type": type, "label": label, "category": category, "description": desc, "config": list(config),
                          "handles": handles, "expr": set(expr), "trigger": trigger, "icon": icon, "fn": fn}
        return fn
    return deco


def catalog():
    out = []
    for s in REGISTRY.values():
        d = {k: v for k, v in s.items() if k not in ("fn", "expr")}
        d["handles"] = "dynamic" if callable(s["handles"]) else list(s["handles"])
        d["expression_fields"] = sorted(s["expr"])
        d["handles_extra"] = ["error"] if not s["trigger"] else []
        out.append(d)
    return out


def _items(ctx, cfg, key="items"):
    v = evaluate(cfg.get(key) or "input", ctx.env())
    if v is None: return []
    if not isinstance(v, list): raise NodeError(f"'{key}' must evaluate to a list, got {type(v).__name__}", permanent=True)
    return v


# ───────────────────────── triggers
for _t, _l, _d, _cfg in [
    ("manual", "Manual Trigger", "Start the workflow by hand or via the API with a JSON payload.", []),
    ("webhook", "Webhook Trigger", "Starts on POST /hooks/{workflow_id}/{token}. Output: {body, headers, query}.", []),
    ("cron", "Schedule Trigger", "Starts on a cron schedule (5 fields) or every N seconds. Workflow must be active.",
     [F("cron", help="e.g. */5 * * * *"), F("every_seconds", "number", help="Alternative to cron, e.g. 10")]),
]:
    async def _trigger(ctx, cfg, inp): return inp
    node(f"trigger.{_t}", _l, "Triggers", _d, _cfg, trigger=True, icon="zap")(_trigger)


# ───────────────────────── actions
class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None


_OPENER = build_opener(_NoRedirect)


def _guard_url(url):
    p = urlparse(str(url))
    if p.scheme not in ("http", "https") or not p.hostname: raise NodeError("only absolute http/https URLs are allowed", permanent=True)
    if os.getenv("FLOWFORGE_ALLOW_PRIVATE") == "1": return
    try: infos = socket.getaddrinfo(p.hostname, p.port or 80)
    except socket.gaierror as e: raise NodeError(f"cannot resolve host: {e}")
    for i in infos:
        ip = ipaddress.ip_address(i[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise NodeError("SSRF guard: private/internal address blocked (set FLOWFORGE_ALLOW_PRIVATE=1 for local demos)", permanent=True)


def _http_sync(method, url, headers, body, timeout):
    h = {"User-Agent": "FlowForge/1.0", **(headers or {})}
    data = None
    if body is not None:
        if isinstance(body, (dict, list)): data = json.dumps(body).encode(); h.setdefault("Content-Type", "application/json")
        else: data = str(body).encode()
    try: resp = _OPENER.open(Request(url, data=data, method=method, headers=h), timeout=timeout)
    except HTTPError as e: resp = e
    try: text = resp.read(2_000_000).decode("utf-8", "replace")
    finally: resp.close()
    status = getattr(resp, "status", None) or resp.getcode()
    try: parsed = json.loads(text) if text.strip()[:1] in "{[" else text
    except ValueError: parsed = text
    return {"status": status, "ok": 200 <= status < 300, "headers": dict(resp.headers), "body": parsed}


@node("action.http", "HTTP Request", "Actions", "Call any REST API. Output: {status, ok, headers, body}. 5xx/timeouts are retried if retries are set.",
      [F("url", required=True), F("method", "select", default="GET", options=["GET", "POST", "PUT", "PATCH", "DELETE"]),
       F("headers", "json", default={}), F("body", "json"), F("timeout", "number", default=15),
       F("fail_on_error", "boolean", default=True, help="Fail the node on HTTP >= 400")], icon="globe")
async def http(ctx, cfg, inp):
    method = str(cfg.get("method") or "GET").upper()
    if ctx.dry_run and method != "GET":
        return {"dry_run": True, "would_call": f"{method} {cfg['url']}", "status": 200, "ok": True, "body": None}
    _guard_url(cfg["url"])
    r = await asyncio.to_thread(_http_sync, method, cfg["url"], cfg.get("headers"), cfg.get("body"), float(cfg.get("timeout") or 15))
    ctx.log(f"{method} {cfg['url']} -> {r['status']}")
    if cfg.get("fail_on_error", True) and r["status"] >= 400:
        raise NodeError(f"HTTP {r['status']}: {str(r['body'])[:200]}", permanent=r["status"] < 500 and r["status"] != 429)
    return r


_MAIL = re.compile(r"^[^@\s,]+@[^@\s,]+\.[^@\s,]+$")


def _smtp_send(to, subject, body):
    m = EmailMessage(); m["To"], m["Subject"] = to, subject
    m["From"] = os.getenv("FLOWFORGE_SMTP_FROM", "flowforge@localhost"); m.set_content(body)
    port = int(os.getenv("FLOWFORGE_SMTP_PORT", "587"))
    with smtplib.SMTP(os.environ["FLOWFORGE_SMTP_HOST"], port, timeout=20) as s:
        if port != 25: s.starttls()
        if os.getenv("FLOWFORGE_SMTP_USER"): s.login(os.environ["FLOWFORGE_SMTP_USER"], os.environ["FLOWFORGE_SMTP_PASS"])
        s.send_message(m)


@node("action.email", "Send Email", "Actions", "Sends via SMTP when FLOWFORGE_SMTP_HOST is set, otherwise writes to the local outbox (GET /outbox).",
      [F("to", required=True), F("subject", required=True), F("body", "text")], icon="mail")
async def email(ctx, cfg, inp):
    to, subj, body = str(cfg["to"]).strip(), str(cfg["subject"]), str(cfg.get("body") or "")
    if not _MAIL.match(to): raise NodeError(f"invalid recipient '{to}'", permanent=True)
    if ctx.dry_run: return {"dry_run": True, "to": to, "subject": subj}
    if os.getenv("FLOWFORGE_SMTP_HOST"):
        await asyncio.to_thread(_smtp_send, to, subj, body); via = "smtp"
    else:
        ctx.store.outbox_add(ctx.run_id, to, subj, body); via = "outbox"
    ctx.log(f"email to {to} via {via}")
    return {"to": to, "subject": subj, "via": via}


@node("action.db", "Data Store", "Actions", "Insert / query / count JSON records in a named collection (safe, no raw SQL).",
      [F("operation", "select", default="insert", options=["insert", "query", "count"]), F("collection", required=True),
       F("data", "json", help="Record to insert (defaults to the node input)"),
       F("where", "expression", help="Filter, e.g. record.amount > 100"), F("limit", "number", default=100)],
      expr=("where",), icon="database")
async def datastore(ctx, cfg, inp):
    op, coll = cfg.get("operation") or "insert", str(cfg["collection"])
    if op == "insert":
        data = cfg["data"] if cfg.get("data") not in (None, "") else inp
        if ctx.dry_run: return {"dry_run": True, "would_insert": data}
        return {"id": ctx.store.rec_insert(coll, data), "inserted": data}
    rows = [r["data"] for r in ctx.store.rec_list(coll, 5000)]
    if cfg.get("where"):
        rows = [r for r in rows if evaluate(cfg["where"], {**ctx.env(), "record": r})]
    rows = rows[: int(cfg.get("limit") or 100)]
    return {"count": len(rows)} if op == "count" else {"count": len(rows), "items": rows}


@node("action.log", "Log", "Actions", "Write a message to the run log; passes input through.", [F("message", "text", required=True)], icon="file-text")
async def log(ctx, cfg, inp):
    ctx.log(cfg["message"]); return inp


@node("action.delay", "Delay", "Actions", "Wait N seconds (max 30); passes input through.", [F("seconds", "number", required=True, default=1)], icon="clock")
async def delay(ctx, cfg, inp):
    if not ctx.dry_run: await asyncio.sleep(min(max(float(cfg["seconds"]), 0), 30))
    return inp


@node("action.ai", "AI Step (Claude)", "Actions", "Ask Claude to summarise/classify/extract. Falls back to a stub when no ANTHROPIC_API_KEY.",
      [F("prompt", "text", required=True), F("system", "text")], icon="sparkles")
async def ai(ctx, cfg, inp):
    if ctx.dry_run or not llm.available(): return {"text": f"[stub] {str(cfg['prompt'])[:200]}", "stub": True}
    text, model = await asyncio.to_thread(llm.complete_sync, str(cfg["prompt"]), str(cfg.get("system") or ""))
    return {"text": text, "model": model}


@node("action.subworkflow", "Run Sub-workflow", "Actions", "Run another saved workflow (reuse). With for_each it fans out over a list concurrently.",
      [F("workflow_id", required=True), F("payload", "json", help="Payload (defaults to input / each item)"),
       F("for_each", "expression", help="List expression, e.g. input.items"), F("concurrency", "number", default=4)],
      expr=("for_each",), icon="workflow")
async def subworkflow(ctx, cfg, inp):
    wf = ctx.store.get_workflow(cfg["workflow_id"])
    if not wf: raise NodeError(f"sub-workflow '{cfg['workflow_id']}' not found", permanent=True)
    if ctx.depth >= 5: raise NodeError("sub-workflow nesting too deep (max 5)", permanent=True)

    async def one(payload):
        r = await ctx.engine.run(wf, payload, trigger_type="subworkflow", dry_run=ctx.dry_run, depth=ctx.depth + 1, parent_run_id=ctx.run_id, propagate_cancel=True)
        if r["status"] != "success": raise NodeError(f"sub-workflow {r['id']} {r['status']}: {r['error']}")
        return r["output"]

    if cfg.get("for_each"):
        items = evaluate(cfg["for_each"], ctx.env()) or []
        sem = asyncio.Semaphore(max(1, min(int(cfg.get("concurrency") or 4), 16)))

        async def guarded(it):
            async with sem: return await one(cfg["payload"] if cfg.get("payload") not in (None, "") else it)
        return {"results": list(await asyncio.gather(*[guarded(i) for i in items])), "count": len(items)}
    return await one(cfg["payload"] if cfg.get("payload") not in (None, "") else inp)


# ───────────────────────── logic
@node("logic.if", "Condition (If/Else)", "Logic", "Routes to 'true' or 'false' branch. Input passes through.",
      [F("condition", "expression", required=True, help="e.g. trigger.body.amount > 100")], handles=("true", "false"), expr=("condition",), icon="git-branch")
async def if_(ctx, cfg, inp):
    ok = bool(evaluate(cfg["condition"], ctx.env()))
    ctx.log(f"condition `{cfg['condition']}` -> {ok}")
    return Out(inp, ["true" if ok else "false"])


def _switch_handles(cfg):
    return [c.get("handle") for c in (cfg.get("cases") or []) if c.get("handle")] + ["default"]


@node("logic.switch", "Switch", "Logic", "Multi-way routing: first matching case wins (or all with mode=all), else 'default'.",
      [F("cases", "json", required=True, help='[{"handle":"vip","when":"input.tier == \\"gold\\""}]'),
       F("mode", "select", default="first", options=["first", "all"])], handles=_switch_handles, expr=("cases",), icon="split")
async def switch(ctx, cfg, inp):
    hit = []
    for c in cfg["cases"]:
        if evaluate(c["when"], ctx.env()):
            hit.append(c["handle"])
            if cfg.get("mode", "first") == "first": break
    ctx.log(f"switch -> {hit or ['default']}")
    return Out(inp, hit or ["default"])


@node("logic.merge", "Merge", "Logic", "Waits for all active branches and combines their outputs (object = shallow merge, list = array).",
      [F("mode", "select", default="object", options=["object", "list", "keyed"])], icon="merge")
async def merge(ctx, cfg, inp):
    mode, vals = cfg.get("mode", "object"), ctx.inputs
    if mode == "list": return list(vals.values())
    if mode == "keyed": return dict(vals)
    merged = {}
    for v in vals.values():
        if isinstance(v, dict): merged.update(v)
    return merged


# ───────────────────────── data transformation
@node("transform.set", "Set Fields", "Data", "Build a new object from templates, e.g. {\"total\": \"{{ input.qty * input.price }}\"}.",
      [F("fields", "json", required=True), F("keep_input", "boolean", default=False), F("to_vars", "boolean", default=False, help="Also store in workflow vars")], icon="edit")
async def set_fields(ctx, cfg, inp):
    res = dict(inp) if cfg.get("keep_input") and isinstance(inp, dict) else {}
    res.update(cfg["fields"])
    if cfg.get("to_vars"): ctx.vars.update(cfg["fields"])
    return res


@node("transform.map", "Map List", "Data", "Apply an expression to each item (`item`, `index`).",
      [F("items", "expression", default="input"), F("expression", "expression", required=True, help='e.g. {"id": item.id, "total": item.qty * item.price}')],
      expr=("items", "expression"), icon="list")
async def map_(ctx, cfg, inp):
    env = ctx.env()
    return [evaluate(cfg["expression"], {**env, "item": it, "index": i}) for i, it in enumerate(_items(ctx, cfg))]


@node("transform.filter", "Filter List", "Data", "Keep items for which the condition is true.",
      [F("items", "expression", default="input"), F("condition", "expression", required=True, help="e.g. item.price > 10")],
      expr=("items", "condition"), icon="filter")
async def filter_(ctx, cfg, inp):
    env = ctx.env()
    return [it for i, it in enumerate(_items(ctx, cfg)) if evaluate(cfg["condition"], {**env, "item": it, "index": i})]


@node("transform.aggregate", "Aggregate", "Data", "count / sum / avg / min / max over a list (optionally of one field).",
      [F("items", "expression", default="input"), F("op", "select", required=True, default="count", options=["count", "sum", "avg", "min", "max"]), F("field")],
      expr=("items",), icon="sigma")
async def aggregate(ctx, cfg, inp):
    items, f = _items(ctx, cfg), cfg.get("field")
    vals = [(it.get(f) if isinstance(it, dict) else None) for it in items] if f else items
    nums = [v for v in vals if isinstance(v, (int, float)) and not isinstance(v, bool)]
    op = cfg["op"]
    if op == "count": r = len(items)
    elif not nums: r = None
    else: r = {"sum": sum(nums), "avg": sum(nums) / len(nums), "min": min(nums), "max": max(nums)}[op]
    return {"op": op, "field": f, "result": r, "count": len(items)}


@node("transform.json", "JSON Parse / Stringify", "Data", "Convert between JSON text and objects.",
      [F("mode", "select", default="parse", options=["parse", "stringify"]), F("value", "expression", default="input")], expr=("value",), icon="braces")
async def json_(ctx, cfg, inp):
    v = evaluate(cfg.get("value") or "input", ctx.env())
    if cfg.get("mode", "parse") == "stringify": return {"text": json.dumps(v, default=str)}
    try: return json.loads(v) if isinstance(v, str) else v
    except ValueError as e: raise NodeError(f"invalid JSON: {e}", permanent=True)

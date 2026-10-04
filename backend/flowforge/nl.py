"""Natural language -> workflow graph. Uses Claude when ANTHROPIC_API_KEY is set (with one self-repair
round driven by the validator), otherwise a deterministic rule-based fallback so the demo works offline."""
import asyncio, json, re

from . import llm
from .graph import auto_layout, validate_graph
from .nodes import REGISTRY


def _system():
    lines = []
    for s in REGISTRY.values():
        hs = "dynamic" if callable(s["handles"]) else ",".join(s["handles"])
        lines.append(f"- {s['type']}: {s['description']} config: {', '.join(f['name'] for f in s['config'])}; handles: {hs}")
    return ("You design automation workflows. Reply with ONLY a JSON object {\"name\":str,\"nodes\":[...],\"edges\":[...]}.\n"
            "node = {\"id\":str,\"type\":str,\"data\":{\"label\":str,\"config\":{...},\"settings\":{\"retries\":0-5}}}\n"
            "edge = {\"source\":id,\"target\":id,\"sourceHandle\":handle-or-omitted}. Exactly one trigger, no cycles.\n"
            "Expressions are Python-like using trigger, input, nodes.<id>.output, vars. Templates use {{ expr }}.\n"
            "logic.if condition is a bare expression (e.g. trigger.body.amount > 100). Node types:\n" + "\n".join(lines))


def _extract_json(text):
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b < 0: raise ValueError("no JSON object in model reply")
    return json.loads(text[a:b + 1])


def _finish(g, source, warnings):
    g.setdefault("edges", [])
    auto_layout(g)
    return {"name": g.pop("name", "Generated workflow"), "graph": g, "source": source, "warnings": warnings,
            "validation": validate_graph(g, REGISTRY)}


def _llm_generate(prompt):
    system, msgs, last = _system(), prompt, None
    for attempt in range(2):
        text, _ = llm.complete_sync(msgs, system, max_tokens=3000)
        g = _extract_json(text)
        v = validate_graph(g, REGISTRY)
        if v["valid"]: return _finish(g, "llm", v["warnings"])
        last = g
        msgs = f"{prompt}\n\nYour previous attempt had validation errors, fix them and return the full JSON again:\n" + "\n".join(v["errors"])
    return _finish(last, "llm", ["model output still had validation errors"])


# ------------------------------------------------------------------ offline fallback
_OPS = [("is greater than or equal to", ">="), ("is at least", ">="), ("is greater than", ">"), ("is more than", ">"),
        ("is over", ">"), ("exceeds", ">"), ("is less than or equal to", "<="), ("is at most", "<="),
        ("is less than", "<"), ("is under", "<"), ("is not equal to", "!="), ("is not", "!="), ("is equal to", "=="),
        ("equals", "=="), ("is", "==")]
_COND = re.compile(r"\b(?:if|when|whenever)\s+(?:the\s+|a\s+|an\s+)?(?:[\w]+\s+)*?\b([a-z_][\w\.]*)\s*(>=|<=|==|!=|>|<)\s*(\$?-?\d[\d\.]*|\"[^\"]*\"|'[^']*'|[a-z_]\w*)", re.I)


def _norm(t):
    for a, b in _OPS: t = re.sub(rf"\b{a}\b", f" {b} ", t, flags=re.I)
    return t


def _action(clause):
    c = clause.lower()
    em = re.search(r"[\w\.\-+]+@[\w\-]+\.[\w\.\-]+", clause)
    if re.search(r"\b(e-?mail|mail)\b", c):
        return "action.email", {"to": em.group(0) if em else "ops@example.com", "subject": "FlowForge notification",
                                "body": "{{ json(input) }}"}, "Send email", None if em else "no recipient found; used ops@example.com"
    url = re.search(r"https?://[^\s,]+", clause)
    if url:
        post = re.search(r"\b(post|send|push)\b", c) is not None
        return "action.http", {"url": url.group(0), "method": "POST" if post else "GET", **({"body": "{{ input }}"} if post else {})}, "HTTP request", None
    if re.search(r"\b(save|store|insert|record)\b", c): return "action.db", {"operation": "insert", "collection": "records"}, "Save record", None
    if re.search(r"\b(summari[sz]e|classify|analy[sz]e|extract)\b", c):
        return "action.ai", {"prompt": clause.strip() + ": {{ json(input) }}"}, "AI step", None
    m = re.search(r"\b(?:wait|delay|pause)\b\D*(\d+)\s*(second|minute)?", c)
    if m: return "action.delay", {"seconds": int(m.group(1)) * (60 if (m.group(2) or "").startswith("minute") else 1)}, "Delay", None
    if re.search(r"\b(log|print|note)\b", c): return "action.log", {"message": "{{ json(input) }}"}, "Log", None
    return None


def _fallback(prompt):
    text, warns = prompt.strip().rstrip("."), []
    low = text.lower()
    nodes, edges, n = [], [], [0]

    def add(type_, cfg, label):
        n[0] += 1; nid = f"n{n[0]}"
        nodes.append({"id": nid, "type": type_, "data": {"label": label, "config": cfg, "settings": {}}}); return nid

    if "webhook" in low: tid, kind = add("trigger.webhook", {}, "Webhook"), "webhook"
    elif (m := re.search(r"every\s+(\d+)\s*(second|minute|hour)", low)):
        k = int(m.group(1)) * {"second": 1, "minute": 60, "hour": 3600}[m.group(2)]
        tid, kind = add("trigger.cron", {"every_seconds": k}, "Schedule"), "cron"
    elif (m := re.search(r"every day at (\d{1,2})(?::(\d\d))?\s*(am|pm)?", low)):
        h = int(m.group(1)) % 12 + (12 if m.group(3) == "pm" else 0) if m.group(3) else int(m.group(1))
        tid, kind = add("trigger.cron", {"cron": f"{int(m.group(2) or 0)} {h} * * *"}, "Daily schedule"), "cron"
    else: tid, kind = add("trigger.manual", {}, "Manual start"), "manual"
    base = "trigger.body." if kind == "webhook" else "input."
    prev = (tid, None)

    def link(src, tgt):
        edges.append({"source": src[0], "target": tgt, **({"sourceHandle": src[1]} if src[1] else {})})

    clauses = [c for c in re.split(r"\b(?:then|and then|after that|next)\b|[;]|\.\s+", _norm(text), flags=re.I) if c and c.strip()]
    for clause in clauses:
        parts = re.split(r"\b(?:otherwise|else)\b", clause, maxsplit=1, flags=re.I)
        cm = _COND.search(parts[0])
        if cm:
            var, op, val = cm.groups()
            var = var if var.startswith(("trigger.", "input.")) else base + var
            val = val.lstrip("$") if re.match(r"\$?-?\d", val) else (val if val[0] in "\"'" else f'"{val}"')
            cid = add("logic.if", {"condition": f"{var} {op} {val}"}, f"If {var.split('.')[-1]} {op} {val}")
            link(prev, cid)
            true_act = _action(parts[0][cm.end():]) or _action(parts[0])
            if true_act:
                aid = add(true_act[0], true_act[1], true_act[2]); link((cid, "true"), aid)
                if true_act[3]: warns.append(true_act[3])
                prev = (aid, None)
            if len(parts) > 1 and (fa := _action(parts[1])):
                fid = add(fa[0], fa[1], fa[2]); link((cid, "false"), fid)
        elif (a := _action(clause)):
            aid = add(a[0], a[1], a[2]); link(prev, aid); prev = (aid, None)
            if a[3]: warns.append(a[3])
    if len(nodes) == 1: warns.append("could not understand any steps; try verbs like send email, call https://..., save, log")
    return _finish({"name": text[:60], "nodes": nodes, "edges": edges}, "heuristic", warns)


async def generate(prompt):
    if llm.available():
        try: return await asyncio.to_thread(_llm_generate, prompt)
        except Exception as e:
            r = _fallback(prompt); r["warnings"].append(f"LLM unavailable ({e!s:.120}); used offline generator"); return r
    r = _fallback(prompt); r["warnings"].append("no ANTHROPIC_API_KEY set; used the offline rule-based generator"); return r

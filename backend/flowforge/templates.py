"""Ready-made workflows shown in the 'Templates' gallery (one click to instantiate)."""


def N(id, type, cfg=None, label=None, x=0, y=0, settings=None):
    return {"id": id, "type": type, "position": {"x": x, "y": y},
            "data": {"label": label or id, "config": cfg or {}, "settings": settings or {}}}


def E(s, t, h=None):
    return {"source": s, "target": t, **({"sourceHandle": h} if h else {})}


TEMPLATES = {
    "order-router": {
        "name": "Order router (webhook → branch → parallel → merge)",
        "description": "Webhook receives an order, computes the total, high-value orders fan out in parallel (email + save) then merge.",
        "sample_payload": {"id": "A-1001", "qty": 3, "price": 49.5, "email": "buyer@example.com"},
        "graph": {"nodes": [
            N("hook", "trigger.webhook", {}, "Order webhook", 0, 120),
            N("calc", "transform.set", {"fields": {"order_id": "{{ trigger.body.id }}", "total": "{{ trigger.body.qty * trigger.body.price }}",
                                                   "customer": "{{ trigger.body.email }}"}}, "Calculate total", 260, 120),
            N("big", "logic.if", {"condition": "input.total >= 100"}, "Total ≥ 100?", 520, 120),
            N("mail", "action.email", {"to": "{{ input.customer }}", "subject": "Order {{ input.order_id }} is being prioritised",
                                       "body": "Thanks! Your total is {{ input.total }}."}, "Email customer", 780, 20),
            N("save", "action.db", {"operation": "insert", "collection": "priority_orders"}, "Save order", 780, 220),
            N("join", "logic.merge", {"mode": "keyed"}, "Join", 1040, 120),
            N("done", "action.log", {"message": "High-value order {{ nodes.calc.output.order_id }} processed"}, "Done", 1300, 120),
            N("small", "action.log", {"message": "Standard order {{ input.order_id }} (total {{ input.total }})"}, "Standard order", 780, 420)],
            "edges": [E("hook", "calc"), E("calc", "big"), E("big", "mail", "true"), E("big", "save", "true"), E("mail", "join"),
                      E("save", "join"), E("join", "done"), E("big", "small", "false")]}},
    "resilient-api": {
        "name": "Resilient API pipeline (retries + error route)",
        "description": "Fetch todos with retries/backoff, filter + aggregate, alert if any open. If the API stays down the error branch runs.",
        "sample_payload": {},
        "graph": {"nodes": [
            N("start", "trigger.manual", {}, "Start", 0, 100),
            N("fetch", "action.http", {"url": "https://jsonplaceholder.typicode.com/todos?_limit=20", "method": "GET"}, "Fetch todos", 260, 100,
              {"retries": 3, "backoff": 0.5, "timeout": 10}),
            N("open", "transform.filter", {"items": "input.body", "condition": "not item.completed"}, "Only open todos", 520, 20),
            N("count", "transform.aggregate", {"items": "input", "op": "count"}, "Count", 780, 20),
            N("gate", "logic.if", {"condition": "input.result > 0"}, "Any open?", 1040, 20),
            N("alert", "action.email", {"to": "ops@example.com", "subject": "{{ input.count }} open todos", "body": "Please review."}, "Alert", 1300, 0),
            N("fallback", "action.log", {"message": "API unavailable: {{ input.error }}"}, "Fallback", 520, 240)],
            "edges": [E("start", "fetch"), E("fetch", "open"), E("open", "count"), E("count", "gate"), E("gate", "alert", "true"), E("fetch", "fallback", "error")]}},
    "lead-triage": {
        "name": "Lead triage (switch + AI summary)",
        "description": "Route leads by score: hot → email + AI summary, warm → store, others → log.",
        "sample_payload": {"name": "Asha", "email": "asha@corp.com", "score": 87, "notes": "Wants enterprise plan next quarter"},
        "graph": {"nodes": [
            N("hook", "trigger.webhook", {}, "New lead", 0, 150),
            N("route", "logic.switch", {"cases": [{"handle": "hot", "when": "trigger.body.score >= 80"}, {"handle": "warm", "when": "trigger.body.score >= 50"}]}, "Route by score", 260, 150),
            N("sum", "action.ai", {"prompt": "Summarise this lead in one sentence: {{ json(trigger.body) }}"}, "AI summary", 520, 20),
            N("notify", "action.email", {"to": "sales@example.com", "subject": "HOT lead: {{ trigger.body.name }}", "body": "{{ input.text }}"}, "Notify sales", 780, 20),
            N("store", "action.db", {"operation": "insert", "collection": "warm_leads", "data": "{{ trigger.body }}"}, "Store warm", 520, 180),
            N("cold", "action.log", {"message": "Cold lead {{ trigger.body.name }}"}, "Cold", 520, 340)],
            "edges": [E("hook", "route"), E("route", "sum", "hot"), E("sum", "notify"), E("route", "store", "warm"), E("route", "cold", "default")]}},
    "scheduled-digest": {
        "name": "Scheduled digest (cron every 60s)",
        "description": "Activate it and it runs every minute: query stored orders, aggregate revenue, log the digest.",
        "sample_payload": {},
        "graph": {"nodes": [
            N("tick", "trigger.cron", {"every_seconds": 60}, "Every minute", 0, 80),
            N("q", "action.db", {"operation": "query", "collection": "priority_orders", "limit": 500}, "Load orders", 260, 80),
            N("sum", "transform.aggregate", {"items": "input.items", "op": "sum", "field": "total"}, "Revenue", 520, 80),
            N("out", "action.log", {"message": "Digest: revenue {{ input.result }} over {{ input.count }} orders"}, "Log digest", 780, 80)],
            "edges": [E("tick", "q"), E("q", "sum"), E("sum", "out")]}},
}

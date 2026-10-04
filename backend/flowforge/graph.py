"""Graph helpers: normalisation (React-Flow compatible), validation, auto-layout."""
import re
from collections import defaultdict, deque


def slug(s):
    return re.sub(r"\W+", "_", str(s or "").lower()).strip("_")


def get_config(n):
    return n.get("config") or (n.get("data") or {}).get("config") or {}


def get_settings(n):
    return n.get("settings") or (n.get("data") or {}).get("settings") or {}


def get_label(n):
    return n.get("label") or (n.get("data") or {}).get("label") or n.get("id")


def allowed_handles(spec, cfg):
    h = spec["handles"]
    return list(h(cfg) if callable(h) else h)


def validate_graph(g, reg):
    errs, warns = [], []
    nodes, edges = g.get("nodes") or [], g.get("edges") or []
    if not nodes: errs.append("workflow has no nodes")
    if len(nodes) > 200: errs.append("too many nodes (max 200)")
    if len(edges) > 600: errs.append("too many edges (max 600)")
    specs, cfgs = {}, {}
    for n in nodes:
        nid = n.get("id")
        if not nid or not isinstance(nid, str): errs.append("every node needs a string 'id'"); continue
        if nid in specs: errs.append(f"duplicate node id '{nid}'"); continue
        spec = reg.get(n.get("type"))
        specs[nid], cfgs[nid] = spec, get_config(n)
        if not spec: errs.append(f"[{nid}] unknown node type '{n.get('type')}'"); continue
        for f in spec["config"]:
            if f.get("required") and cfgs[nid].get(f["name"]) in (None, "", []):
                errs.append(f"[{nid}] missing required setting '{f['name']}'")
    inc, out = defaultdict(list), defaultdict(list)
    for e in edges:
        s, t = e.get("source"), e.get("target")
        if s not in specs or t not in specs: errs.append(f"edge {s}->{t} references a missing node"); continue
        if s == t: errs.append(f"[{s}] node is connected to itself"); continue
        h = e.get("sourceHandle") or "out"
        if specs[s] and h != "error" and h not in allowed_handles(specs[s], cfgs[s]):
            errs.append(f"[{s}] has no output handle '{h}' (valid: {allowed_handles(specs[s], cfgs[s])})")
        if specs[t] and specs[t]["trigger"]: errs.append(f"[{t}] triggers cannot have incoming connections")
        inc[t].append(s); out[s].append(t)
    triggers = [i for i, s in specs.items() if s and s["trigger"]]
    if nodes and not triggers: errs.append("workflow needs at least one trigger node")
    indeg = {i: len(inc[i]) for i in specs}
    q, seen = deque(i for i, d in indeg.items() if d == 0), 0
    while q:
        x = q.popleft(); seen += 1
        for y in out[x]:
            indeg[y] -= 1
            if indeg[y] == 0: q.append(y)
    if seen != len(specs): errs.append("workflow contains a cycle (loops are not allowed; use a sub-workflow with for_each)")
    reach, q = set(triggers), deque(triggers)
    while q:
        for y in out[q.popleft()]:
            if y not in reach: reach.add(y); q.append(y)
    for i in specs:
        if i not in reach: warns.append(f"[{i}] is not reachable from any trigger and will never run")
        if len(inc[i]) > 1 and specs[i] and specs[i]["type"] != "logic.merge":
            warns.append(f"[{i}] has several inputs; it will receive them keyed by source node id")
    return {"valid": not errs, "errors": errs, "warnings": warns}


def topo_order(g):
    nodes = [n["id"] for n in g["nodes"]]
    inc = defaultdict(int); out = defaultdict(list)
    for e in g.get("edges", []):
        inc[e["target"]] += 1; out[e["source"]].append(e["target"])
    q, order = deque(i for i in nodes if inc[i] == 0), []
    while q:
        x = q.popleft(); order.append(x)
        for y in out[x]:
            inc[y] -= 1
            if inc[y] == 0: q.append(y)
    return order


def auto_layout(g):
    """Assign x/y positions by dependency depth for nodes that have none."""
    depth = {}
    for nid in topo_order(g):
        depth.setdefault(nid, 0)
        for e in g.get("edges", []):
            if e["source"] == nid: depth[e["target"]] = max(depth.get(e["target"], 0), depth[nid] + 1)
    rows = defaultdict(int)
    for n in g["nodes"]:
        if not n.get("position"):
            d = depth.get(n["id"], 0)
            n["position"] = {"x": d * 280, "y": rows[d] * 150}
        rows[depth.get(n["id"], 0)] += 1
    return g

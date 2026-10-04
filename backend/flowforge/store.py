"""SQLite persistence (WAL). Workflows, runs (with graph snapshot), per-node runs, events, records, outbox."""
import json, sqlite3, threading, uuid
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY,name TEXT,description TEXT,graph TEXT,active INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1,webhook_token TEXT,created_at TEXT,updated_at TEXT);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,workflow_id TEXT,workflow_version INTEGER,status TEXT,trigger_type TEXT,
  trigger TEXT,graph TEXT,dry_run INTEGER,started_at TEXT,finished_at TEXT,duration_ms INTEGER,error TEXT,resumed_from TEXT,
  parent_run_id TEXT,idempotency_key TEXT,output TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS ux_run_idem ON runs(workflow_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_run_wf ON runs(workflow_id,started_at);
CREATE TABLE IF NOT EXISTS node_runs(run_id TEXT,node_id TEXT,status TEXT,attempts INTEGER,input TEXT,output TEXT,handles TEXT,
  error TEXT,started_at TEXT,finished_at TEXT,duration_ms INTEGER,PRIMARY KEY(run_id,node_id));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT,ts TEXT,type TEXT,node_id TEXT,data TEXT);
CREATE INDEX IF NOT EXISTS ix_ev_run ON events(run_id,id);
CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY AUTOINCREMENT,collection TEXT,data TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT,to_addr TEXT,subject TEXT,body TEXT,created_at TEXT);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def dumps(o):
    return json.dumps(o, default=str, ensure_ascii=False)


def loads(s):
    return json.loads(s) if s else None


def uid():
    return uuid.uuid4().hex[:12]


class Store:
    def __init__(self, path="flowforge.db"):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            if path != ":memory:": self.db.execute("PRAGMA journal_mode=WAL")
            self.db.executescript(SCHEMA)
            self.db.commit()

    def _x(self, sql, args=()):
        with self.lock:
            cur = self.db.execute(sql, args); self.db.commit(); return cur

    def _q(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    # ---- workflows
    @staticmethod
    def _wf(r):
        if not r: return None
        r["graph"] = loads(r["graph"]); r["active"] = bool(r["active"]); return r

    def create_workflow(self, name, graph, description="", wid=None):
        wid, t = wid or uid(), now()
        self._x("INSERT INTO workflows VALUES(?,?,?,?,0,1,?,?,?)", (wid, name, description, dumps(graph), uid() + uid(), t, t))
        return self.get_workflow(wid)

    def get_workflow(self, wid):
        r = self._q("SELECT * FROM workflows WHERE id=?", (wid,))
        return self._wf(r[0]) if r else None

    def list_workflows(self, active_only=False):
        rows = self._q("SELECT * FROM workflows" + (" WHERE active=1" if active_only else "") + " ORDER BY updated_at DESC")
        return [self._wf(r) for r in rows]

    def update_workflow(self, wid, **kw):
        wf = self.get_workflow(wid)
        if not wf: return None
        graph_changed = "graph" in kw and kw["graph"] != wf["graph"]
        name, desc = kw.get("name", wf["name"]), kw.get("description", wf["description"])
        graph, active = kw.get("graph", wf["graph"]), kw.get("active", wf["active"])
        self._x("UPDATE workflows SET name=?,description=?,graph=?,active=?,version=version+?,updated_at=? WHERE id=?",
                (name, desc, dumps(graph), int(bool(active)), int(graph_changed), now(), wid))
        return self.get_workflow(wid)

    def delete_workflow(self, wid):
        return self._x("DELETE FROM workflows WHERE id=?", (wid,)).rowcount > 0

    # ---- runs
    def create_run(self, rid, wf_id, version, trigger_type, trigger, graph, dry_run, resumed_from=None, parent=None, idem=None):
        self._x("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,NULL)",
                (rid, wf_id, version, "running", trigger_type, dumps(trigger), dumps(graph), int(dry_run), now(), resumed_from, parent, idem))

    def finish_run(self, rid, status, error, output, duration_ms):
        self._x("UPDATE runs SET status=?,error=?,output=?,finished_at=?,duration_ms=? WHERE id=?",
                (status, error, dumps(output), now(), duration_ms, rid))

    def run_by_key(self, wf_id, key):
        r = self._q("SELECT id FROM runs WHERE workflow_id=? AND idempotency_key=?", (wf_id, key))
        return self.get_run(r[0]["id"]) if r else None

    def get_run(self, rid, with_graph=True):
        r = self._q("SELECT * FROM runs WHERE id=?", (rid,))
        if not r: return None
        r = r[0]
        for k in ("trigger", "output"): r[k] = loads(r[k])
        r["graph"] = loads(r["graph"]) if with_graph else None
        if not with_graph: r.pop("graph")
        r["dry_run"] = bool(r["dry_run"])
        r["nodes"] = {n["node_id"]: n for n in self.node_runs(rid)}
        return r

    def list_runs(self, workflow_id=None, limit=50):
        sql = "SELECT id,workflow_id,workflow_version,status,trigger_type,dry_run,started_at,finished_at,duration_ms,error,resumed_from FROM runs"
        args = []
        if workflow_id: sql += " WHERE workflow_id=?"; args.append(workflow_id)
        return self._q(sql + " ORDER BY started_at DESC LIMIT ?", (*args, min(int(limit), 500)))

    def save_node_run(self, rid, nid, status, attempts=0, inp=None, out=None, handles=None, error=None, started=None, finished=None, dur=None):
        self._x("INSERT OR REPLACE INTO node_runs VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (rid, nid, status, attempts, dumps(inp), dumps(out), dumps(handles), error, started, finished, dur))

    def node_runs(self, rid):
        rows = self._q("SELECT * FROM node_runs WHERE run_id=?", (rid,))
        for r in rows:
            for k in ("input", "output", "handles"): r[k] = loads(r[k])
        return rows

    def mark_interrupted(self):
        runs = self._q("SELECT id FROM runs WHERE status='running'")
        for r in runs:
            self._x("UPDATE runs SET status='failed',error='server restarted while running (use resume)',finished_at=? WHERE id=?", (now(), r["id"]))
            self._x("UPDATE node_runs SET status='cancelled' WHERE run_id=? AND status IN ('running','queued')", (r["id"],))
        return len(runs)

    # ---- events
    def add_event(self, rid, typ, node_id=None, **data):
        ts = now()
        cur = self._x("INSERT INTO events(run_id,ts,type,node_id,data) VALUES(?,?,?,?,?)", (rid, ts, typ, node_id, dumps(data)))
        return {"id": cur.lastrowid, "run_id": rid, "ts": ts, "type": typ, "node_id": node_id, "data": data}

    def events(self, rid, after=0):
        rows = self._q("SELECT * FROM events WHERE run_id=? AND id>? ORDER BY id", (rid, after))
        for r in rows: r["data"] = loads(r["data"])
        return rows

    # ---- records (db node) & outbox (email node)
    def rec_insert(self, coll, data):
        return self._x("INSERT INTO records(collection,data,created_at) VALUES(?,?,?)", (coll, dumps(data), now())).lastrowid

    def rec_list(self, coll, limit=1000):
        rows = self._q("SELECT * FROM records WHERE collection=? ORDER BY id DESC LIMIT ?", (coll, limit))
        for r in rows: r["data"] = loads(r["data"])
        return rows

    def outbox_add(self, rid, to, subject, body):
        return self._x("INSERT INTO outbox(run_id,to_addr,subject,body,created_at) VALUES(?,?,?,?,?)", (rid, to, subject, body, now())).lastrowid

    def outbox(self, limit=100):
        return self._q("SELECT * FROM outbox ORDER BY id DESC LIMIT ?", (limit,))

    def stats(self):
        rows = self._q("SELECT status,COUNT(*) c,AVG(duration_ms) a FROM runs GROUP BY status")
        total = sum(r["c"] for r in rows)
        ok = sum(r["c"] for r in rows if r["status"] == "success")
        return {"workflows": self._q("SELECT COUNT(*) c FROM workflows")[0]["c"], "runs": total,
                "success_rate": round(ok / total, 3) if total else None,
                "by_status": {r["status"]: r["c"] for r in rows},
                "avg_duration_ms": round(sum((r["a"] or 0) * r["c"] for r in rows) / total) if total else None}

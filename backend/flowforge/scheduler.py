"""Cron / interval scheduler. Fires are idempotent (key per slot) so replicas never double-run."""
import asyncio, logging
from datetime import datetime, timezone

from .graph import get_config

log = logging.getLogger("flowforge.scheduler")


def _field(spec, lo, hi):
    vals = set()
    for part in spec.split(","):
        step = 1
        if "/" in part: part, s = part.split("/"); step = int(s)
        if part in ("*", ""): a, b = lo, hi
        elif "-" in part: a, b = map(int, part.split("-"))
        else: a = int(part); b = hi if step > 1 else a
        vals.update(range(a, b + 1, step))
    return vals


def cron_match(expr, dt):
    f = expr.split()
    if len(f) != 5: raise ValueError("cron needs 5 fields: m h dom mon dow")
    mi, h, dom, mon, dow = _field(f[0], 0, 59), _field(f[1], 0, 23), _field(f[2], 1, 31), _field(f[3], 1, 12), {d % 7 for d in _field(f[4], 0, 7)}
    cd = (dt.weekday() + 1) % 7
    if dt.minute not in mi or dt.hour not in h or dt.month not in mon: return False
    dom_any, dow_any = f[2] == "*", f[4] == "*"
    if dom_any and dow_any: return True
    if dom_any: return cd in dow
    if dow_any: return dt.day in dom
    return dt.day in dom or cd in dow


class Scheduler:
    def __init__(self, store, engine):
        self.store, self.engine, self.last, self._cache, self._cache_t = store, engine, {}, [], 0
        self.task = None

    def start(self): self.task = asyncio.create_task(self._loop())

    def stop(self):
        if self.task: self.task.cancel()

    async def _loop(self):
        while True:
            await asyncio.sleep(1)
            try: await self.tick(datetime.now(timezone.utc))
            except Exception: log.exception("scheduler tick failed")

    async def tick(self, now):
        if now.timestamp() - self._cache_t > 5:
            self._cache, self._cache_t = self.store.list_workflows(active_only=True), now.timestamp()
        for wf in self._cache:
            for n in wf["graph"]["nodes"]:
                if n["type"] != "trigger.cron": continue
                cfg, key = get_config(n), (wf["id"], n["id"])
                slot = None
                if cfg.get("every_seconds"):
                    iv = max(1.0, float(cfg["every_seconds"])); last = self.last.get(key)
                    if last is None: self.last[key] = now.timestamp()
                    elif now.timestamp() - last >= iv: self.last[key] = now.timestamp(); slot = f"i{int(now.timestamp() // iv)}"
                elif cfg.get("cron"):
                    minute = now.strftime("%Y%m%d%H%M")
                    try: hit = self.last.get(key) != minute and cron_match(cfg["cron"], now)
                    except ValueError: continue
                    if hit: self.last[key] = minute; slot = minute
                if slot:
                    try:
                        await self.engine.start(wf, {"fired_at": now.isoformat(), "scheduled": True}, trigger_type="cron",
                                                idempotency_key=f"cron:{n['id']}:{slot}")
                    except Exception: log.exception("cron fire failed for %s", wf["id"])

"""Safe expression + template engine (no eval/exec, no dunder access, step-budgeted).

Syntax is Python-like:  trigger.body.amount > 100 and input.country in ["IN","US"]
Templates:              "Hello {{ trigger.body.name }}"  (a lone {{ }} keeps the native type)
"""
import ast, json, re
from datetime import datetime, timezone


class ExprError(ValueError):
    permanent = True  # a bad expression never succeeds on retry


_CONST = {"true": True, "false": False, "null": None, "none": None}
_FUNCS = {
    "len": len, "str": str, "int": int, "float": float, "bool": bool, "abs": abs, "round": round,
    "min": min, "max": max, "sum": sum, "sorted": sorted, "any": any, "all": all, "list": list,
    "keys": lambda d: list((d or {}).keys()), "values": lambda d: list((d or {}).values()),
    "json": lambda v: json.dumps(v, default=str), "lower": lambda s: str(s).lower(),
    "upper": lambda s: str(s).upper(), "now": lambda: datetime.now(timezone.utc).isoformat(),
    "contains": lambda a, b: (b in a) if a is not None else False,
}
_METHODS = {"lower", "upper", "strip", "startswith", "endswith", "split", "replace", "join",
            "get", "title", "items", "keys", "values", "count"}
_BIN = {ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b, ast.Mult: lambda a, b: a * b,
        ast.Div: lambda a, b: a / b, ast.FloorDiv: lambda a, b: a // b, ast.Mod: lambda a, b: a % b}
_CMP = {ast.Eq: lambda a, b: a == b, ast.NotEq: lambda a, b: a != b, ast.Lt: lambda a, b: a < b,
        ast.LtE: lambda a, b: a <= b, ast.Gt: lambda a, b: a > b, ast.GtE: lambda a, b: a >= b,
        ast.In: lambda a, b: b is not None and a in b, ast.NotIn: lambda a, b: b is None or a not in b,
        ast.Is: lambda a, b: a is b, ast.IsNot: lambda a, b: a is not b}


class _Ev:
    def __init__(self, env):
        self.env, self.steps = env, 0

    def ev(self, n, loc):
        self.steps += 1
        if self.steps > 20000:
            raise ExprError("expression too complex")
        t = type(n)
        if t is ast.Constant:
            return n.value
        if t is ast.Name:
            if n.id in loc: return loc[n.id]
            if n.id in self.env: return self.env[n.id]
            if n.id.lower() in _CONST: return _CONST[n.id.lower()]
            if n.id in _FUNCS: return _FUNCS[n.id]
            raise ExprError(f"unknown name '{n.id}'")
        if t is ast.Attribute:
            return self.attr(self.ev(n.value, loc), n.attr)
        if t is ast.Subscript:
            obj = self.ev(n.value, loc)
            sl = n.slice
            key = slice(*[self.ev(x, loc) if x else None for x in (sl.lower, sl.upper, sl.step)]) \
                if isinstance(sl, ast.Slice) else self.ev(sl, loc)
            return self.sub(obj, key)
        if t is ast.BinOp:
            a, b = self.ev(n.left, loc), self.ev(n.right, loc)
            if type(n.op) is ast.Pow:
                if abs(b) > 64: raise ExprError("exponent too large")
                return a ** b
            if type(n.op) is ast.Mult and isinstance(a, (str, list)) and isinstance(b, int) and len(a) * b > 100000:
                raise ExprError("result too large")
            return _BIN[type(n.op)](a, b)
        if t is ast.UnaryOp:
            v = self.ev(n.operand, loc)
            return {ast.Not: lambda x: not x, ast.USub: lambda x: -x, ast.UAdd: lambda x: +x}[type(n.op)](v)
        if t is ast.BoolOp:
            if isinstance(n.op, ast.And):
                v = True
                for x in n.values:
                    v = self.ev(x, loc)
                    if not v: return v
                return v
            v = False
            for x in n.values:
                v = self.ev(x, loc)
                if v: return v
            return v
        if t is ast.Compare:
            left = self.ev(n.left, loc)
            for op, c in zip(n.ops, n.comparators):
                right = self.ev(c, loc)
                try: ok = _CMP[type(op)](left, right)
                except TypeError: ok = False  # None < 5 etc. is simply false
                if not ok: return False
                left = right
            return True
        if t is ast.IfExp:
            return self.ev(n.body if self.ev(n.test, loc) else n.orelse, loc)
        if t is ast.List or t is ast.Tuple:
            return [self.ev(x, loc) for x in n.elts]
        if t is ast.Dict:
            return {self.ev(k, loc): self.ev(v, loc) for k, v in zip(n.keys, n.values) if k is not None}
        if t is ast.Call:
            f = n.func
            if isinstance(f, ast.Attribute):
                if f.attr not in _METHODS: raise ExprError(f"method '{f.attr}' not allowed")
                obj = self.ev(f.value, loc)
                if obj is None: raise ExprError(f"cannot call .{f.attr}() on null")
                fn = getattr(obj, f.attr, None)
                if fn is None: raise ExprError(f"no method '{f.attr}'")
            elif isinstance(f, ast.Name) and f.id in _FUNCS:
                fn = _FUNCS[f.id]
            else:
                raise ExprError("only built-in functions can be called")
            return fn(*[self.ev(a, loc) for a in n.args], **{k.arg: self.ev(k.value, loc) for k in n.keywords if k.arg})
        if t in (ast.ListComp, ast.GeneratorExp):
            if len(n.generators) != 1: raise ExprError("only one 'for' allowed in comprehension")
            g, out = n.generators[0], []
            for v in (self.ev(g.iter, loc) or []):
                l2 = dict(loc)
                if isinstance(g.target, ast.Name): l2[g.target.id] = v
                elif isinstance(g.target, ast.Tuple):
                    for tn, tv in zip(g.target.elts, v): l2[tn.id] = tv
                else: raise ExprError("unsupported loop target")
                if all(self.ev(c, l2) for c in g.ifs):
                    out.append(self.ev(n.elt, l2))
                    if len(out) > 100000: raise ExprError("result too large")
            return out
        raise ExprError(f"unsupported syntax: {t.__name__}")

    @staticmethod
    def attr(obj, name):
        if name.startswith("_"): raise ExprError("private attributes are not accessible")
        if isinstance(obj, dict):
            if name in obj: return obj[name]
            return getattr(obj, name) if name in _METHODS else None
        if obj is None: return None
        if name in _METHODS and hasattr(obj, name): return getattr(obj, name)
        raise ExprError(f"cannot read '.{name}'")

    @staticmethod
    def sub(obj, key):
        if obj is None: return None
        if isinstance(obj, dict): return obj.get(key)
        if isinstance(obj, (list, tuple, str)):
            try: return obj[key]
            except (IndexError, TypeError): return None
        raise ExprError("value is not subscriptable")


def evaluate(expr, env):
    if not isinstance(expr, str): return expr
    expr = expr.strip()
    if not expr: raise ExprError("empty expression")
    if len(expr) > 2000: raise ExprError("expression too long")
    try: tree = ast.parse(expr, mode="eval")
    except SyntaxError as e: raise ExprError(f"syntax error in '{expr}': {e.msg}")
    try: return _Ev(env).ev(tree.body, {})
    except ExprError: raise
    except (TypeError, ValueError, KeyError, ZeroDivisionError, AttributeError, OverflowError) as e:
        raise ExprError(f"cannot evaluate '{expr}': {e}")


_TPL = re.compile(r"\{\{(.*?)\}\}", re.S)


def _s(v):
    if v is None: return ""
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, (dict, list)): return json.dumps(v, default=str)
    return str(v)


def render(v, env):
    """Resolve {{ }} templates recursively inside strings / lists / dicts."""
    if isinstance(v, str):
        if "{{" not in v: return v
        s = v.strip()
        m = _TPL.fullmatch(s)
        if m and s.count("{{") == 1: return evaluate(m.group(1), env)
        return _TPL.sub(lambda m: _s(evaluate(m.group(1), env)), v)
    if isinstance(v, list): return [render(x, env) for x in v]
    if isinstance(v, dict): return {k: render(x, env) for k, x in v.items()}
    return v

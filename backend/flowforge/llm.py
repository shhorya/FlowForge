import json, os, urllib.request


def _cfg():
    if os.getenv("GROQ_API_KEY"):
        return "groq", os.environ["GROQ_API_KEY"], os.getenv("FLOWFORGE_LLM_MODEL", "llama-3.3-70b-versatile")
    if os.getenv("ANTHROPIC_API_KEY"):
        return "anthropic", os.environ["ANTHROPIC_API_KEY"], os.getenv("FLOWFORGE_LLM_MODEL", "claude-sonnet-5-5")
    return None, None, None


def available():
    return _cfg()[0] is not None


def complete_sync(prompt, system="", max_tokens=1500, timeout=60):
    kind, key, model = _cfg()
    if not kind: raise RuntimeError("no LLM key set (GROQ_API_KEY)")
    if kind == "groq":
        msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
        body = {"model": model, "max_tokens": max_tokens, "temperature": 0.2, "messages": msgs}
        url, headers = "https://api.groq.com/openai/v1/chat/completions", {"Authorization": f"Bearer {key}"}
    else:
        body = {"model": model, "max_tokens": max_tokens, "system": system, "messages": [{"role": "user", "content": prompt}]}
        url, headers = "https://api.anthropic.com/v1/messages", {"x-api-key": key, "anthropic-version": "2023-06-01"}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "User-Agent": "FlowForge/1.0", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read())
    if kind == "groq": return data["choices"][0]["message"]["content"] or "", model
    return "".join(b.get("text", "") for b in data.get("content", [])), model
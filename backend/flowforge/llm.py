import json, os, urllib.request


def available():
    return bool(os.getenv("ANTHROPIC_API_KEY"))


def complete_sync(prompt, system="", max_tokens=1500, timeout=60):
    key = os.getenv("ANTHROPIC_API_KEY")
    if not key: raise RuntimeError("ANTHROPIC_API_KEY not set")
    model = os.getenv("FLOWFORGE_LLM_MODEL", "claude-sonnet-5-5")
    body = json.dumps({"model": model, "max_tokens": max_tokens, "system": system,
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, method="POST",
                                 headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read())
    return "".join(b.get("text", "") for b in data.get("content", [])), model

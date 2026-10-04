#!/usr/bin/env bash
# 90-second judge demo. Start the server first:  FLOWFORGE_ALLOW_PRIVATE=1 uvicorn flowforge.api:app --port 8000
B=${B:-http://localhost:8000}; j() { python3 -m json.tool; }
echo "1) Instantiate the order-router template"; W=$(curl -s -X POST $B/templates/order-router/instantiate); echo "$W" | python3 -c "import sys,json;w=json.load(sys.stdin);print(w['id'],w['webhook_path'])"
ID=$(echo "$W" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])"); HOOK=$(echo "$W" | python3 -c "import sys,json;print(json.load(sys.stdin)['webhook_path'])")
echo "2) Fire the webhook with a high-value order (waits for result)"
curl -s -X POST "$B$HOOK?wait=true" -H 'Idempotency-Key: demo-1' -H 'content-type: application/json' -d '{"id":"A-1","qty":3,"price":49.5,"email":"buyer@example.com"}' | python3 -c "import sys,json;r=json.load(sys.stdin);print(r['status'],{k:v['status'] for k,v in r['nodes'].items()})"
echo "3) Same Idempotency-Key => deduplicated, no second run"; curl -s -X POST "$B$HOOK" -H 'Idempotency-Key: demo-1' -d '{}' | j
echo "4) Outbox + saved records"; curl -s $B/outbox | j | head -12
echo "5) English -> workflow"; curl -s -X POST $B/ai/generate -H 'content-type: application/json' -d '{"prompt":"Every 30 seconds call https://jsonplaceholder.typicode.com/todos/1 then log it"}' | python3 -c "import sys,json;g=json.load(sys.stdin);print(g['source'],g['validation']['valid'],[n['type'] for n in g['graph']['nodes']])"
echo "6) Retry demo: flaky endpoint fails twice, node retries with backoff"
F=$(curl -s -X POST $B/workflows -H 'content-type: application/json' -d '{"name":"flaky","graph":{"nodes":[{"id":"t","type":"trigger.manual"},{"id":"h","type":"action.http","data":{"config":{"url":"'$B'/mock/flaky/demo?fail_first=2"},"settings":{"retries":3,"backoff":0.3}}}],"edges":[{"source":"t","target":"h"}]}}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
curl -s -X POST $B/workflows/$F/run -H 'content-type: application/json' -d '{"wait":true}' | python3 -c "import sys,json;r=json.load(sys.stdin);print(r['status'],'attempts =',r['nodes']['h']['attempts'])"

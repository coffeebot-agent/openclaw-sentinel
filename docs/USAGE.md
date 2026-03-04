# OpenClaw Sentinel Usage Guide

This guide shows practical ways to use `@coffeexdev/openclaw-sentinel` in OpenClaw and skill-driven flows.

## 1) Install + Enable

```bash
openclaw plugins install @coffeexdev/openclaw-sentinel
openclaw gateway restart
```

In config, you **must** set `allowedHosts` — no hosts are allowed by default. Watchers can only connect to explicitly listed hostnames:

```json
{
  "sentinel": {
    "allowedHosts": ["api.github.com", "api.coingecko.com", "status.example.com"],
    "localDispatchBase": "http://127.0.0.1:18789"
  }
}
```

---

## 2) Basic watcher creation (agent tool)

Create a watcher via `sentinel_control`:

```json
{
  "action": "create",
  "watcher": {
    "id": "status-watch",
    "skillId": "skills.ops",
    "enabled": true,
    "strategy": "http-poll",
    "endpoint": "https://status.example.com/api/health",
    "intervalMs": 10000,
    "match": "all",
    "conditions": [{ "path": "status", "op": "eq", "value": "degraded" }],
    "fire": {
      "webhookPath": "/hooks/agent",
      "eventName": "service_degraded",
      "payloadTemplate": {
        "event": "${event.name}",
        "component": "${payload.component}",
        "status": "${payload.status}",
        "ts": "${timestamp}"
      }
    },
    "retry": { "maxRetries": 8, "baseMs": 500, "maxMs": 30000 }
  }
}
```

---

## 3) One-shot trigger (`fireOnce`)

Use `fireOnce: true` to dispatch once and auto-disable:

```json
{
  "action": "create",
  "watcher": {
    "id": "price-threshold-once",
    "skillId": "skills.alerts",
    "enabled": true,
    "strategy": "http-poll",
    "endpoint": "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    "intervalMs": 15000,
    "match": "all",
    "conditions": [{ "path": "ethereum.usd", "op": "gte", "value": 5000 }],
    "fire": {
      "webhookPath": "/hooks/agent",
      "eventName": "eth_target_hit",
      "payloadTemplate": {
        "event": "${event.name}",
        "price": "${payload.ethereum.usd}",
        "ts": "${timestamp}"
      }
    },
    "retry": { "maxRetries": 5, "baseMs": 500, "maxMs": 15000 },
    "fireOnce": true
  }
}
```

---

## 4) CI run completion monitor

```json
{
  "action": "create",
  "watcher": {
    "id": "ci-run-12345",
    "skillId": "skills.github",
    "enabled": true,
    "strategy": "http-poll",
    "endpoint": "https://api.github.com/repos/owner/repo/actions/runs/12345",
    "headers": {
      "Authorization": "Bearer ${secrets.github_pat}",
      "Accept": "application/vnd.github+json"
    },
    "intervalMs": 30000,
    "match": "all",
    "conditions": [{ "path": "status", "op": "eq", "value": "completed" }],
    "fire": {
      "webhookPath": "/hooks/agent",
      "eventName": "ci_completed",
      "payloadTemplate": {
        "event": "${event.name}",
        "conclusion": "${payload.conclusion}",
        "url": "${payload.html_url}",
        "ts": "${timestamp}"
      }
    },
    "retry": { "maxRetries": 10, "baseMs": 1000, "maxMs": 60000 },
    "fireOnce": true
  }
}
```

---

## 5) Runtime control actions

Check status:

```json
{ "action": "status", "id": "status-watch" }
```

Disable:

```json
{ "action": "disable", "id": "status-watch" }
```

Remove:

```json
{ "action": "remove", "id": "status-watch" }
```

---

## 6) Skill integration pattern

Typical skill flow:

1. Skill creates watcher when user asks to monitor an external event.
2. Sentinel watches with zero token burn while idle.
3. On condition match, Sentinel dispatches webhook payload.
4. Agent wakes, acts, and optionally disables/removes watcher.

This pattern keeps the model active only at decision points.

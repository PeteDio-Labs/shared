# @petedio/shared

Shared types and utilities for PeteDio Labs services and agents.

## Includes

- shared domain types (including `ApprovalPreview` discriminated union)
- HTTP helpers
- SSE utilities
- agent reporting and task payload contracts
- Ollama tool loop helpers
- deterministic agent runner
- Ollama connection router (`resolveOllamaUrl`, `isGpu1Model`)
- Prometheus metrics for agents (`agent_up`, `agent_runs_total`)

## Versioning

| Version | Highlights |
|---------|------------|
| 1.4.0   | Reporter exposes `agent_up` + `agent_runs_total` via prom-client; `reportLogLine` event for SSE live-tail; `ApprovalPreview` discriminated union lifted into shared; `resolveOllamaUrl` helper |
| 1.2.1   | Reporter logs non-2xx HTTP errors; 10s fetch timeout |
| 1.2.0   | `runDeterministicPlan` + `onBeforeStep` gate hook + `skipped` step status |
| 1.1.0   | Shared deterministic runner |

### `agent_up` / `agent_runs_total` usage

```ts
import { initAgentMetrics, renderMetrics, AgentReporter } from '@petedio/shared/agents';

initAgentMetrics({ agentName: 'pm-agent' });
// AgentReporter constructor calls this automatically — only call it
// directly if your agent owns metrics lifecycle separately.

app.get('/metrics', async (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(await renderMetrics());
});
```

The Grafana "Agent Fleet" dashboard
(`infrastructure/kubernetes/control-plane/observability/mission-control/grafana-dashboard-agent-fleet.yaml`)
queries these timeseries.

## Publish

This package is published by GitHub Actions on pushes to `main`.

Workflow:

- [`.github/workflows/publish.yml`](./.github/workflows/publish.yml)

Registry target:

- `https://registry.toastedbytes.com/repository/npm-hosted/`

## Development

```bash
bun install
bun run typecheck
```

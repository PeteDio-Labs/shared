# @petedio/shared

Shared types and utilities for PeteDio Labs services and agents.

## Includes

- shared domain types
- HTTP helpers
- SSE utilities
- agent reporting and task payload contracts
- Ollama tool loop helpers
- deterministic agent runner

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

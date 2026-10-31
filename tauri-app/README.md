# Agentree desktop app

See [the project README](../README.md) for setup, scope, and export provenance.

Install dependencies here with `pnpm install --frozen-lockfile`.
`pnpm run dev` starts Tauri without a secrets-manager dependency.
`pnpm run build` compiles the frontend; `pnpm run tauri:build:prod` packages the desktop app.

Source environment-variable references remain configurable by the developer.
No environment files or credentials are included.

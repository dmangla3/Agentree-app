# Source export

Source commit: `d9acc68c54abc09f6b080cea9b65314970396763`.

## Included

- `tauri-app/`: application source, native provider adapters, tests, icons, runtime manifests, lockfiles, and build tooling.
- `shared/agentStatus.ts`: the desktop app's shared status contract, moved from `server/shared/`.
- Minimal root build/test shortcuts and ignore rules.

Database implementation code and credential-handling code are part of the app. Actual databases, sessions, credentials, and account configuration are excluded.

## Excluded

Original private Git objects, refs, and metadata; the cloud server; landing page; marketing/GTM assets; documentation websites; public-sharing websites; memory bank; private notes; logs; environment examples and values; secrets-manager project configuration; databases and journals; dependencies; runtime binaries; generated outputs; private release instructions and release automation; development-worktree launchers tied to the original secrets manager and database snapshot setup.

## Source adjustments

- Shared-module aliases point to `shared/` instead of the omitted server.
- Default development/build commands no longer require Infisical.
- Removed commands for excluded private release and development-worktree tooling.
- Personal home-directory and repository paths in fixtures use generic examples.
- Provider-key fixtures use explicit `FAKE_DO_NOT_USE` markers; OAuth parser fixtures retain required prefixes and lengths.
- No application features were intentionally redesigned.
- Added a public-facing README and a local SVG illustration of the branching workflow.

## Validation

- Frontend TypeScript check and Vite production build: passed, using a clean environment without inherited Vite configuration values.
- Frontend unit, composer, and performance tests: 180 files, 1,110 tests passed.
- Runtime archive and provider adapter tests: 65 passed.
- Tests used `NODE_OPTIONS=--no-experimental-webstorage` to avoid the host Node version's experimental storage behavior.
- Dependencies were borrowed temporarily from the local installation for validation; the link and all generated build output were removed afterwards. A fresh dependency install was not performed.
- Native Rust compilation, native tests, provider connections, cloud services, and desktop interaction were not exercised.
- Cargo metadata validation (`--offline --locked --no-deps`): passed.
- Offline TruffleHog credential scan: no findings; verification against external services was disabled.
- Final file audit: no original private Git history, dependency links, build output, environment files, private configuration, databases/journals, logs, or excluded website/private folders.
- PNG metadata audit: no text or EXIF metadata chunks.
- The original working repository remains unchanged.

## Reconstructed public history

The public repository contains 50 sanitized app snapshots arranged across August–October 2026, followed by a publication commit with the actual creation date. The reconstructed author and committer timestamps were proportionally adjusted to this recent window. Original source dates (May 10–August 10, 2026) remain in the provenance map and commit trailers. Only reconstructed Git objects are present; original private objects and refs were not copied. Source authors retain their names with redacted email addresses. See [history provenance](docs/history.md) for the source-to-public commit map and date policy.

The final application files are unchanged by history reconstruction. Only this document, the README, and the new history provenance document changed.

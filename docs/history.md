# History provenance

This is a curated, app-only reconstruction of the original Agentree development history. It was created on 2026-10-30; its public timeline was adjusted on 2026-10-31.

```text
Original development history                  Public repository
┌─────────────────────────────┐              ┌─────────────────────────────┐
│ May 10 – August 10, 2026     │              │ 50 curated app snapshots    │
│ Selected first-parent       │   filter,    │ Adjusted Aug–Oct timestamps │
│ milestones through d9acc68c │ ──sanitize──▶│ New, standalone Git objects │
└─────────────────────────────┘  and squash  └──────────────┬──────────────┘
                                                          │
                                            ┌─────────────▼──────────────┐
                                            │ Publication commit         │
                                            │ Current README and badges  │
                                            │ Export cleanup, dated today│
                                            └────────────────────────────┘
```

## What the dates and commits mean

The 50 historical commits represent distinct application source snapshots from May 10 through August 10, 2026. Intervening development commits are squashed into the next selected milestone. Commit subjects summarize those grouped changes.

Author names come from the selected source commits. At the owner’s request, public author and committer timestamps were proportionally remapped to August 1–October 31, 2026, preserving commit order and the relative spacing between milestones. These adjusted timestamps describe the public reconstruction timeline; they are not the dates on which the original development occurred. Original source dates are retained below and in each commit’s `Original-Author-Date` and `Original-Committer-Date` trailers. Personal email addresses remain replaced with reserved `example.invalid` addresses. These are reconstructed commits, not the original signed commits or their complete ancestry.

The final publication commit uses the actual date of this timeline update, October 31, 2026. It records the app-only packaging, privacy cleanup, current README, website link, badges, and these notes. Publication changes are kept separate from the app snapshots and are not backdated.

## Privacy and scope

Only application source and the shared status contract were reconstructed. The original Git object database, branches, remotes, commit bodies, marketing sites, private notes, environment files, database files/journals, logs, installed dependencies, generated outputs, and private release tooling were not copied.

All 50 historical trees were checked against the excluded-file rules. An offline TruffleHog scan of the reconstructed Git history reported no credential findings; external credential verification was disabled. The final publication commit is scanned separately before this repository is handed over.

Earlier snapshots preserve development states and have not been independently built or tested. Some refer to historical cloud services or omitted runtime dependencies. The frontend build and test results in [EXPORT.md](../EXPORT.md) apply to the current publication snapshot.

## Milestone map

| # | Original source date | Adjusted public date | Public commit | Source commit | Milestone |
| ---: | --- | --- | --- | --- | --- |
| 1 | 2026-05-10 | 2026-08-01 | `dfbc0742d9` | `414b00e98b` | feat(graph): establish conversation and commit histories |
| 2 | 2026-05-11 | 2026-08-02 | `eaf4d96b28` | `e31c0e7184` | feat(graph): add canonical commit projections |
| 3 | 2026-05-12 | 2026-08-03 | `6b0d6e0a6d` | `7e888fb23c` | feat(sync): synchronize the local commit graph |
| 4 | 2026-05-14 | 2026-08-05 | `1a4ba871c6` | `79365825a0` | fix(graph): preserve base commits and parent closures |
| 5 | 2026-05-16 | 2026-08-06 | `1d58672716` | `a39b31fa08` | refactor(graph): organize layouts around conversation turns |
| 6 | 2026-05-16 | 2026-08-07 | `904de9bd7e` | `209e8f4867` | fix(runtime): improve agent lifecycle and tool timeline persistence |
| 7 | 2026-05-19 | 2026-08-10 | `ddabb8fdcd` | `d24c5499f9` | perf(chat): improve markdown rendering and graph focus |
| 8 | 2026-05-19 | 2026-08-10 | `88e683d2a1` | `550fbe7db5` | feat(threads): introduce thread roots and workspace switching |
| 9 | 2026-05-20 | 2026-08-10 | `18171029a2` | `1db42b4397` | refactor(runtime): unify finalization and performance diagnostics |
| 10 | 2026-05-21 | 2026-08-12 | `065b9bb8a6` | `9d12497150` | feat(merge): preserve merge results as Git merge commits |
| 11 | 2026-05-22 | 2026-08-13 | `4a728779cc` | `98c56f9089` | perf(graph): improve zoom and cancellation responsiveness |
| 12 | 2026-05-24 | 2026-08-15 | `5c4cde5f37` | `943ca10484` | feat(threads): persist graph visibility and thread filters |
| 13 | 2026-05-26 | 2026-08-17 | `b6ca17028c` | `51f6853396` | feat(graph): route thread origins through the commit graph |
| 14 | 2026-05-27 | 2026-08-18 | `c8403b362f` | `6d527ef7cd` | feat(composer): add the standalone graph dock |
| 15 | 2026-05-28 | 2026-08-19 | `9f52c34024` | `4196966e35` | feat(composer): start graph sends through local state |
| 16 | 2026-05-28 | 2026-08-19 | `311a82b370` | `c32ce0f2b0` | feat(threads): refine sessions, timeline controls, and work logs |
| 17 | 2026-05-31 | 2026-08-22 | `faaea29571` | `eb3f68b473` | fix(composer): restore mentions and graph context actions |
| 18 | 2026-06-01 | 2026-08-23 | `16a2dbae21` | `6d651c1861` | perf(composer): make local send acceptance immediate |
| 19 | 2026-06-03 | 2026-08-25 | `b34f793d88` | `de96517c4d` | feat(auth): add managed Claude OAuth profiles |
| 20 | 2026-06-07 | 2026-08-29 | `fe408feb73` | `cf5eecbb26` | feat(storage): make workspace state locally authoritative |
| 21 | 2026-06-09 | 2026-08-31 | `4386b74109` | `f8750a01e1` | feat(worktrees): add configurable workspace policies |
| 22 | 2026-06-09 | 2026-08-31 | `031e9f0971` | `61af7a7039` | feat(insights): add local background attention workflows |
| 23 | 2026-06-10 | 2026-09-01 | `fa49db4b7a` | `370564420b` | refactor(flows): type workflow visualization and compilation |
| 24 | 2026-06-12 | 2026-09-02 | `a28af606ef` | `f085cf3798` | feat(runtime): introduce managed provider runtimes |
| 25 | 2026-06-14 | 2026-09-05 | `c88a2e0dd4` | `e658222a39` | feat(runtime): add watchdog recovery and lifecycle guards |
| 26 | 2026-06-15 | 2026-09-05 | `59d009d3ab` | `f8ca6e11c4` | fix(threads): align workflow execution with thread state |
| 27 | 2026-06-16 | 2026-09-07 | `dec3de30cc` | `11b0908872` | feat(orchestration): control agent workflows through MCP |
| 28 | 2026-06-17 | 2026-09-07 | `c282b62c3f` | `eb4c2d001f` | fix(claude): preserve native conversation continuity |
| 29 | 2026-06-20 | 2026-09-10 | `36e5a0d24f` | `76644e5039` | fix(runtime): improve Codex and Claude live event handling |
| 30 | 2026-06-22 | 2026-09-12 | `cdf311b635` | `e9b6ddb049` | feat(storage): make cloud services optional for desktop work |
| 31 | 2026-06-24 | 2026-09-14 | `762b11b335` | `b304bde233` | fix(runtime): allow local runs without cloud authentication |
| 32 | 2026-06-25 | 2026-09-15 | `6c5bb492ab` | `afd5e3772b` | fix(runtime): resume interrupted runs after restart |
| 33 | 2026-06-27 | 2026-09-17 | `faa3fddab5` | `170f81f364` | feat(messages): persist text highlights and live output |
| 34 | 2026-07-09 | 2026-09-29 | `da1963a212` | `26572bdf26` | fix(highlights): refine selection and preview behavior |
| 35 | 2026-07-11 | 2026-10-01 | `a52565b98f` | `2150fe03a7` | feat(navigation): open workspace nodes through deep links |
| 36 | 2026-07-13 | 2026-10-03 | `c65b182016` | `36142d5ece` | feat(providers): fork native threads at exact turns |
| 37 | 2026-07-13 | 2026-10-03 | `2e015def64` | `ce947282ff` | feat(diff): adopt the Pierre diff viewer |
| 38 | 2026-07-17 | 2026-10-07 | `1c42ed02e9` | `fa5777a765` | fix(diff): preserve hunk line positions and graph controls |
| 39 | 2026-07-18 | 2026-10-08 | `bebf94765f` | `4ab747c3c0` | fix(auth): preserve runtime repair progress across remounts |
| 40 | 2026-07-27 | 2026-10-17 | `6f616cba79` | `0466b38550` | feat(composer): refresh provider models and effort options |
| 41 | 2026-07-29 | 2026-10-19 | `f5258245ff` | `4d09bcffd8` | feat(runtime): manage provider toolchains and package installs |
| 42 | 2026-07-29 | 2026-10-19 | `9b3127764d` | `5d8eabb943` | fix(runtime): bound streamed output and synchronize account readiness |
| 43 | 2026-07-30 | 2026-10-20 | `d20f2d113c` | `7c798d75d3` | fix(auth): classify provider failures from structured events |
| 44 | 2026-08-05 | 2026-10-26 | `1b05ede323` | `f12a90bb60` | feat(orchestration): separate branch placement from run ownership |
| 45 | 2026-08-05 | 2026-10-26 | `fddfb65f0b` | `89f6ede530` | feat(terminal): add commit-scoped terminal worktrees |
| 46 | 2026-08-06 | 2026-10-27 | `f7568e05b4` | `991edf46f6` | refactor(models): unify catalogs, logins, and composer selection |
| 47 | 2026-08-08 | 2026-10-29 | `5a8a944a8d` | `eff79812e2` | feat(opencode): test provider accounts and preserve queued steering |
| 48 | 2026-08-09 | 2026-10-30 | `448d16bdbc` | `8ec4a6e402` | feat(tracking): add usage and cost dashboards |
| 49 | 2026-08-10 | 2026-10-30 | `be2cb4f07d` | `b12c286e19` | feat(orchestration): integrate delegation and wrapped diff output |
| 50 | 2026-08-10 | 2026-10-31 | `9c09a8edac` | `d9acc68c54` | fix(worktrees): make cleanup safe across managed lifecycles |

# [0.19.0](https://github.com/goldcaddy77/cronfish/compare/v0.18.0...v0.19.0) (2026-07-20)


### Features

* **store:** add Bun.sql Postgres backend behind CronStore (scope 2) ([54979e3](https://github.com/goldcaddy77/cronfish/commit/54979e37d2a1220dbfe37af622869731ac55c81e))

# [0.18.0](https://github.com/goldcaddy77/cronfish/compare/v0.17.0...v0.18.0) (2026-07-18)


### Features

* **daemon:** jitter the post-restore thundering herd ([8aaa0d0](https://github.com/goldcaddy77/cronfish/commit/8aaa0d04c7a7bc586b83029d19bb5e9978fa9329))

# [0.17.0](https://github.com/goldcaddy77/cronfish/compare/v0.16.2...v0.17.0) (2026-07-18)


### Features

* **prune:** age out ledger rows + daily daemon housekeeping ([c8c00e9](https://github.com/goldcaddy77/cronfish/commit/c8c00e9191750cb2a3fe92b9e9d890bcefea6d50))
* **ui:** daemon-aware dashboard — liveness banner, real next_run, catchup badge ([c9f2cde](https://github.com/goldcaddy77/cronfish/commit/c9f2cde7ed3c104d3b8a1705fd45ebc176e93d10))

## [0.16.2](https://github.com/goldcaddy77/cronfish/compare/v0.16.1...v0.16.2) (2026-07-18)


### Bug Fixes

* **daemon:** close once-job loss windows, sync stampede, lock races, stuck run requests ([3700a5f](https://github.com/goldcaddy77/cronfish/commit/3700a5fe5e34d9d96811c14518457682e0a5be51))

## [0.16.1](https://github.com/goldcaddy77/cronfish/compare/v0.16.0...v0.16.1) (2026-07-18)


### Bug Fixes

* **launchd:** kickstart daemon after bootstrap — RunAtLoad alone can pend forever ([9500483](https://github.com/goldcaddy77/cronfish/commit/9500483781185a07172553c8585ae5125bffa185))

# [0.16.0](https://github.com/goldcaddy77/cronfish/compare/v0.15.1...v0.16.0) (2026-07-18)


### Bug Fixes

* **ci:** bun install before test — croner is the package's first runtime dependency ([44610a3](https://github.com/goldcaddy77/cronfish/commit/44610a34690097a027d0cbea2bbd39a31448f6cf))
* **cli:** sync daemon-mode guard gates on installed plist OR fresh heartbeat ([37b15c4](https://github.com/goldcaddy77/cronfish/commit/37b15c4dacf4f099261fb57a11987c91f5434fe1))
* **daemon:** one-time dispatch, error triage, size+mtime scan, mutual exclusion ([f6751d2](https://github.com/goldcaddy77/cronfish/commit/f6751d2b2e0d8e22e155f15123512c6275cc62a3))
* **db:** busy_timeout, once schedule_kind, v6 backfills, request expiry, honest stats ([135732e](https://github.com/goldcaddy77/cronfish/commit/135732e285d9416d44f1df6a067b2425c153751f))
* **watchdog:** daemon restarts delay missed-run alerts, never mute them ([5d2a7c0](https://github.com/goldcaddy77/cronfish/commit/5d2a7c08fcfc488637ae4c71e6e83f8b2fe6fadd))


### Features

* **cli:** daemon install/uninstall verbs + daemon-mode sync and watchdog guards (CAD-691) ([e07c102](https://github.com/goldcaddy77/cronfish/commit/e07c10237f401f44ca8761bb02bd41a238debe1a))
* **cli:** daemon, history, stats verbs + daemon-aware run and status (CAD-691) ([55473e2](https://github.com/goldcaddy77/cronfish/commit/55473e27f99615292781b59bbc2cb2ab2aa8c9ed))
* **daemon:** 1 Hz tick loop — file sync, dispatch, run-request drain, heartbeat (CAD-691) ([bd10340](https://github.com/goldcaddy77/cronfish/commit/bd1034005b2e1e6a2f0c9b460193043834206c62))
* **daemon:** croner + next-occurrence helpers (CAD-691) ([a8bd449](https://github.com/goldcaddy77/cronfish/commit/a8bd4490446bffedd1215c3a61053a3c74be6f94))
* **daemon:** fold the watchdog in — in-daemon missed-run detection (CAD-691) ([31e87d1](https://github.com/goldcaddy77/cronfish/commit/31e87d16b5bf30775d4d71ff7b1596a9661073e2))
* **db:** daemon sync + reporting lookups (CAD-691) ([9693900](https://github.com/goldcaddy77/cronfish/commit/9693900fb6acbe80af7a2b4695f2a411dce3358f))
* **db:** v6 migration — daemon scheduler state + first-class run reporting (CAD-691) ([8e27edc](https://github.com/goldcaddy77/cronfish/commit/8e27edcf881df8e8fa48f7f7c72b8e406e2dff7a))
* **launchd:** daemon plist + injectable hot-swap install/uninstall (CAD-691) ([567f67e](https://github.com/goldcaddy77/cronfish/commit/567f67e8a798301123502ce68c233331352dc50b))
* **runner:** daemon-context env — run-request link, scheduled_for, last-run stamp (CAD-691) ([2fd281f](https://github.com/goldcaddy77/cronfish/commit/2fd281f632fb3f2bc6a74a8c52da7fa341cdafb9))

## [0.15.1](https://github.com/goldcaddy77/cronfish/compare/v0.15.0...v0.15.1) (2026-07-10)


### Bug Fixes

* **frontmatter:** make TS config-block parser comment-aware ([#24](https://github.com/goldcaddy77/cronfish/issues/24)) ([f7905fd](https://github.com/goldcaddy77/cronfish/commit/f7905fd7832fe1c8a33747015cddac97c231a73f))

# [0.15.0](https://github.com/goldcaddy77/cronfish/compare/v0.14.0...v0.15.0) (2026-07-09)


### Bug Fixes

* **runner:** release concurrency lock on SIGTERM during startup window ([2666526](https://github.com/goldcaddy77/cronfish/commit/266652607a93d6c56f846effca9eaa1618881859))


### Features

* **alerts:** slack_bot adapter — chat.postMessage via bot token ([0fe4a13](https://github.com/goldcaddy77/cronfish/commit/0fe4a13b1e37f7b1cf0d622be86636faa2fc011f))

# [0.14.0](https://github.com/goldcaddy77/cronfish/compare/v0.13.0...v0.14.0) (2026-07-05)


### Features

* **models:** subconscious/ model prefix — hosted Anthropic-compatible backend ([24f0ab4](https://github.com/goldcaddy77/cronfish/commit/24f0ab4616b60ac7c3391f59f8cf5b062b7372aa))

# [0.13.0](https://github.com/goldcaddy77/cronfish/compare/v0.12.1...v0.13.0) (2026-06-29)


### Features

* **one-time:** bound the sentinel folder and fix the one-time plist lifecycle ([3e27fb8](https://github.com/goldcaddy77/cronfish/commit/3e27fb81fa340f962d1d5a0d8c557601e75676ff))

## [0.12.1](https://github.com/goldcaddy77/cronfish/compare/v0.12.0...v0.12.1) (2026-06-25)


### Bug Fixes

* **cli:** derive version from package.json; automate releases via semantic-release ([#22](https://github.com/goldcaddy77/cronfish/issues/22)) ([886ef9e](https://github.com/goldcaddy77/cronfish/commit/886ef9ed5348e60c9c4d457d119f6ee9b3689098))
* **frontmatter:** match inline-array close bracket by scan, not lastIndexOf ([#21](https://github.com/goldcaddy77/cronfish/issues/21)) ([763a1c7](https://github.com/goldcaddy77/cronfish/commit/763a1c718835ddb8fe6e2ca587b073d5de1a029e))

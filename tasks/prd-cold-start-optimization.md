# PRD: Cold Start Optimization

## Introduction

Cold start time for OpenCode (lark-opencode) directly impacts user experience. The current startup chain contains multiple serial blocking points: module-level await (`global/index.ts`), serial remote config fetching (`config.ts`), Git subprocess calls (`project.ts`), plugin installation and dynamic imports (`plugin/index.ts`), and eager import of 20+ AI SDK providers (`provider/provider.ts`).

This PRD aims to systematically optimize cold start performance for both TUI mode (`$0` default command) and CLI run mode (`run [message..]`) through a profiling → bottleneck identification → layered optimization approach, maximizing startup performance without introducing functional regressions.

## Goals

- Establish a cold start performance baseline (profile per-phase durations)
- Eliminate module-level blocking await (directory creation and cache checks in `global/index.ts`)
- Convert serial initialization to parallel (Git subprocesses, Config loading, Plugin initialization)
- Defer non-critical-path initialization (LSP, FileWatcher, AI SDK providers)
- Cache repeated computations (Git metadata, Config parse results)
- Add timeouts and graceful degradation for remote config fetching
- Optimize blocking infrastructure (Log.init, Global directory creation)
- Cover both TUI and CLI run code paths

## Execution Order

> **Important**: User stories have inter-dependencies and must be executed in the following order:
>
> 1. **Phase 0 — Baseline**: US-001 (timing infrastructure) → collect baseline measurements
> 2. **Phase 1 — High-impact quick wins**: US-014 (terminal background color detection, est. ~1000ms), US-015 (resolveNetworkOptions decoupling, est. ~50-200ms), US-012 (Log.init optimization, est. ~10-50ms) — can be parallelized
> 3. **Phase 2 — Blocking elimination**: US-002 (Global module-level await, est. ~5-50ms) — execute independently, do not move directory creation into Log.init (see US-002 notes)
> 4. **Phase 3 — Serial to parallel**: US-003 (Git parallelization, est. ~10-50ms), US-004 (remote config timeout/degradation, est. worst case ~unbounded→3s cap), US-005 (Bootstrap parallelization, est. ~depends on plugin timing), US-006 (Plugin parallel loading, est. ~several seconds), US-008 (Config pipeline optimization, est. ~10-100ms) — can be parallelized, but US-005 depends on US-006 conclusions
> 5. **Phase 4 — Lazy loading**: US-007 (AI SDK lazy loading, requires spike first), US-009 (LSP/FileWatcher deferral), US-013 (models-snapshot evaluation)
> 6. **Phase 5 — Verification**: US-010 (TUI first-frame verification), US-011 (regression tests, thresholds depend on Phase 1-4 optimization results)
>
> **Estimated impact ranking (high → low):**
>
> | Priority | US                                 | Estimated savings              | Confidence                              |
> | -------- | ---------------------------------- | ------------------------------ | --------------------------------------- |
> | P0       | US-014 Terminal bg color detection | ~1000ms (worst case)           | High: 1s timeout visible in code        |
> | P0       | US-006 Plugin parallel loading     | ~several seconds (npm install) | High: serial install is observable      |
> | P0       | US-004 Remote config degradation   | ~unbounded→3s cap              | High: no timeout can block indefinitely |
> | P1       | US-015 resolveNetworkOptions       | ~50-200ms                      | Medium: depends on Config.global()      |
> | P1       | US-005 Bootstrap parallelization   | ~depends on plugin/LSP         | Medium: needs profiling                 |
> | P0       | US-008 Config installDependencies  | ~10s+ per dir (cold npm cache) | High: bun add + bun install observable  |
> | P2       | US-008 Config pipeline (other)     | ~10-100ms                      | Medium: needs profiling                 |
> | P2       | US-002 Global module-level await   | ~5-50ms                        | Medium: depends on FS speed             |
> | P2       | US-007 AI SDK lazy loading         | ~needs profiling               | Low: spike required first               |
> | P2       | US-012 Log.init optimization       | ~10-50ms                       | Medium: cleanup IO                      |
> | P3       | US-003 Git parallelization         | ~10-50ms (on cache miss)       | Low: no benefit on cache hit            |
> | P3       | US-009 LSP/FileWatcher deferral    | ~needs profiling               | Low: may already be fast                |
> | P3       | US-013 models-snapshot             | ~needs profiling               | Low: likely < 50ms                      |

## User Stories

### US-001: Establish cold start performance profiling infrastructure

**Status:** ✅ Partially complete

**Completed:**

- Each init step in `InstanceBootstrap()` in `bootstrap.ts` now has `performance.now()` timing
- Added `Bootstrap` namespace and `Bootstrap.Timing` Zod schema
- Added `/bootstrap` server endpoint exposing timing data
- TUI home screen now displays bootstrap phase durations

**Remaining work:**

- [ ] Add `--startup-trace` CLI flag that outputs **complete** per-phase durations to stderr (JSON format)
- [ ] Current timing only covers phases inside `InstanceBootstrap()`. Extend coverage to: `global-init` (module-level await), `log-init` (two `Log.init()` calls), `worker-spawn` (Worker thread creation to RPC ready), `terminal-bg-detect` (`getTerminalBackgroundColor()`), `resolve-network-options` (`resolveNetworkOptions()`), `project-detect` (`Project.fromDirectory()`), `git-metadata`, `config-load` (with sub-phases: `remote-fetch`, `global-config`, `project-config`, `directory-scan`), `server-init`
- [ ] Support nested timing output format: `{ "phase": "string", "duration_ms": number, "children"?: [...] }`
- [ ] No impact on normal startup performance (timing code always collects, but only outputs to stderr when flag is enabled)
- [ ] Typecheck passes

### US-002: Eliminate `global/index.ts` module-level blocking await

**Description:** As a developer, I want the global directory initialization to not block module import so that dependent modules can be parsed immediately.

**Current state analysis:**
`global/index.ts` has two blocking code segments at module top-level:

1. `await Promise.all([fs.mkdir(...)])` — creates 5 directories (data, config, state, log, bin)
2. Cache version check — reads `cache/version` file, clears entire cache directory and rewrites version file on mismatch

Since `Log.init()` depends on `import { Global } from "../global"` and `Global` is a namespace (not async), the real blocking is in the **import side effect**. Any module that `import`s `global/index.ts` will wait for these two IO operations to complete.

**⚠️ Design constraint: Do not move directory creation into `Log.init()`**
US-012 aims to make `Log.init()` faster — adding directory creation to `Log.init()` would conflict with US-012. `Global.ensureDirectories()` should be an independent explicit call, placed at the earliest point in the startup chain (e.g., CLI entry `index.ts` or Worker entry `worker.ts`), decoupled from `Log.init()`.

The two do not require strict ordering: `Log.init()` buffers to memory before directories are ready (see US-012), and `Global.ensureDirectories()` triggers Log flush upon completion.

**Acceptance Criteria:**

- [ ] Remove `await Promise.all([fs.mkdir(...)])` and cache version check from module top-level in `global/index.ts`
- [ ] Export `Global.ensureDirectories()` as an async function instead
- [ ] Call `Global.ensureDirectories()` explicitly in CLI entry (`index.ts`) and Worker entry (`worker.ts`), **not inside `Log.init()`**
- [ ] After `Global.ensureDirectories()` completes, call `Log.flush()` to write memory buffer to disk (in coordination with US-012)
- [ ] Code paths that only read `Global.Path.*` (pure path computation) should not need to wait for directory creation
- [ ] Make cache version check async, not blocking the startup chain
- [ ] Typecheck passes

### US-003: Parallelize Git metadata fetching

**Description:** As a developer, I want Git metadata operations to run in parallel so that project detection doesn't waste time on sequential subprocess calls.

**Acceptance Criteria:**

- [ ] Run `git rev-parse --show-toplevel` and `git rev-parse --git-common-dir` in `project.ts` via `Promise.all()` in parallel
- [ ] Only execute `git rev-list --max-parents=0 --all` on cache miss (existing cache logic exists — verify its effectiveness)
- [x] After first computation, write project ID to `.git/opencode` so subsequent startups skip `git rev-list` ✅ Already implemented in `project.ts` lines 66-69 (read) and 107-109 (write)
- [ ] Consider caching `git rev-parse` results to `.git/opencode-metadata` with session-level TTL (valid for process lifetime)
- [ ] Typecheck passes

### US-004: Add timeout and graceful degradation for remote config fetching

**Description:** As a developer, I want remote config fetching to have timeouts and fallback so that a slow or unreachable server doesn't block startup.

**Current state analysis:**
`config.ts` line 79: `const response = await fetch(\`${key}/.well-known/opencode\`)`has no timeout. Lines 80-82:`if (!response.ok) throw new Error(...)` crashes the entire startup. Multiple wellknown entries are fetched serially in a for loop.

**Acceptance Criteria:**

- [ ] Add `AbortSignal.timeout(3000)` (3-second timeout) to `fetch()` calls in `config.ts`
- [ ] On timeout or network error, degrade to empty config (don't block startup), log at warning level
- [ ] Cache remote config results to `Global.Path.cache/wellknown/{hash}.json` with 5-minute TTL (note: `Global.Path` has a `cache` field with value `xdgCache/opencode`)
- [ ] On cache hit, use cached result directly with background async refresh (stale-while-revalidate pattern)
- [ ] Convert multiple wellknown entry `fetch()` calls to `Promise.allSettled()` for parallel execution
- [ ] Current behavior where `fetch` failure `throw`s and crashes startup — change to graceful degradation
- [ ] Typecheck passes

### US-005: Parallelize InstanceBootstrap initialization chain

**Description:** As a developer, I want independent initialization steps in InstanceBootstrap to run concurrently so that the total bootstrap time is dominated by the slowest step, not the sum.

**Current state analysis (revised):**

The dependency relationships between all 11 init steps in the current serial chain:

| Step                                  | Sync/Async | What it does                                                          | Depends on (init-time)                       | Depended on by (runtime)                       | Est. cost                         |
| ------------------------------------- | ---------- | --------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------- | --------------------------------- |
| `Plugin.init()`                       | async      | `Config.get()` + serial plugin install/import + Bus subscribe + hooks | `Config.state()`                             | `Plugin.trigger()` callers (sessions, etc.)    | Heavy (npm)                       |
| `Share.init()`                        | sync       | Subscribes to 3 Bus events (Updated, PartUpdated, etc.)               | None                                         | Session sync to cloud                          | ~0ms                              |
| `ShareNext.init()`                    | async      | Disabled check + subscribes to Bus events                             | None (Config.get only at runtime in handler) | Session sync to cloud                          | ~0ms                              |
| `Format.init()`                       | async      | `Config.get()` + builds formatter registry from config                | `Config.state()`                             | Tool invocations (file edit formatting)        | Low                               |
| `LSP.init()`                          | async      | `Config.get()` + builds LSP server registry (no process spawn)        | `Config.state()`                             | Tool invocations (diagnostics, symbols, etc.)  | Low                               |
| `FileWatcher.init()`                  | async      | `Config.get()` + native `@parcel/watcher` require + subscribe         | `Config.state()`, native binding             | `Vcs` branch change detection (runtime)        | Medium (10s timeout on subscribe) |
| `File.init()`                         | sync→async | Calls `state()` triggering lazy git diff + file listing               | `Instance.state()`, git                      | Tool invocations (file read/edit/status)       | Medium (git subprocess)           |
| `Vcs.init()`                          | async      | `git rev-parse --abbrev-ref HEAD` + subscribes to FileWatcher events  | Git subprocess                               | Branch display in TUI, branch change detection | Low-Medium (1 git call)           |
| `Snapshot.init()`                     | sync       | `Scheduler.register()` only (cleanup is scheduled, not immediate)     | None                                         | Snapshot operations                            | ~0ms                              |
| `Truncate.init()`                     | sync       | `Scheduler.register()` only                                           | None                                         | Tool output truncation                         | ~0ms                              |
| `SecurityConfig.loadSecurityConfig()` | async      | Reads security config file from project directory                     | None                                         | Permission checks                              | Low                               |

**Key findings from analysis:**

- `Share.init()`, `Snapshot.init()`, `Truncate.init()` are genuinely near-zero-cost (just Bus.subscribe or Scheduler.register)
- `FileWatcher.init()` loads a native binding via `require()` and calls `@parcel/watcher` subscribe with a **10-second timeout** — not zero-cost
- `File.init()` triggers lazy `state()` which runs git diff — not zero-cost
- `Vcs.init()` subscribes to `FileWatcher.Event.Updated` at **runtime** (not init-time) — no strict init ordering dependency with FileWatcher, but FileWatcher must be initialized before Vcs branch change detection works
- Most async steps call `Config.get()` internally which returns cached result after first call — no re-computation

**⚠️ Risk: Plugin and LSP parallelization:**

- `Plugin.init()` calls `hook.config?.(config)` to register plugin hooks
- If LSP or downstream modules depend on plugin hooks being registered, parallelization could cause race conditions
- **Verification method**: Check whether `Plugin.trigger()` is called during bootstrap. If it's only called during session/tool execution, parallelization is safe

**Parallelization groups (proposed):**

- **Group A (zero-cost, keep serial)**: `Share.init()`, `Snapshot.init()`, `Truncate.init()` — overhead of Promise.all() wrapping is not justified
- **Group B (parallelizable)**: `Plugin.init()`, `LSP.init()`, `Format.init()`, `SecurityConfig.loadSecurityConfig()` — all depend on `Config.get()` (cached after first call), no inter-dependencies at init-time
- **Group C (parallelizable, after Group B validation)**: `FileWatcher.init()`, `File.init()`, `Vcs.init()` — can run in parallel; Vcs only needs FileWatcher at runtime for branch change events, not at init-time
- **Group D (needs verification)**: `ShareNext.init()` — calls `Config.get()` only in Bus event handlers (runtime), so init itself is near-zero-cost

**Acceptance Criteria:**

- [ ] **Pre-validation**: Confirm that `Plugin.trigger()` is not called during `InstanceBootstrap()` execution (only called during session runtime)
- [ ] Profile all 11 init steps via US-001 to confirm estimated costs (especially `FileWatcher.init()`, `File.init()`, `Vcs.init()`)
- [ ] If pre-validation passes: run Group B (`Plugin.init()`, `LSP.init()`, `Format.init()`, `SecurityConfig.load()`) via `Promise.all()` in parallel
- [ ] If pre-validation fails: only parallelize `LSP.init()`, `Format.init()`, `SecurityConfig.load()` in parallel; `Plugin.init()` must still precede them
- [ ] Run Group C (`FileWatcher.init()`, `File.init()`, `Vcs.init()`) via `Promise.all()` in parallel (can run concurrently with Group B)
- [ ] Keep Group A (`Share.init()`, `Snapshot.init()`, `Truncate.init()`) serial — zero-cost, no benefit from parallelization
- [ ] Typecheck passes

### US-006: Plugin initialization deferral and parallel loading

**Description:** As a developer, I want plugins to be loaded in parallel and non-critical plugins to be deferred so that plugin initialization doesn't serialize the startup.

**Current state analysis:**
`Plugin.state()` internal flow:

1. `INTERNAL_PLUGINS` (CodexAuthPlugin, CopilotAuthPlugin) — serial `await fn(input)` in a for loop
2. External plugins — serial `BunProc.install()` → `import()` → `fn(input)` in a for loop

Each plugin is independent, sharing a read-only `PluginInput`.

**Acceptance Criteria:**

- [ ] Change INTERNAL_PLUGINS loading in `Plugin.state()` to `Promise.allSettled()` for parallel execution
- [ ] Change external plugins' `BunProc.install()` + `import()` + `fn(input)` to `Promise.allSettled()` for parallel execution
- [ ] A single plugin failure should not affect other plugins or overall startup (current error tolerance for BUILTIN — extend to all plugin types)
- [ ] Add 10-second timeout to `BunProc.install()` to prevent slow npm registry from blocking startup
- [ ] Ensure the `PluginInput` object has no write conflicts during parallel loading (currently read-only usage — verify)
- [ ] Typecheck passes

### US-007: Lazy-load AI SDK providers

**Description:** As a developer, I want AI SDK providers to be imported on-demand instead of all 20+ at module level so that unused providers don't add to startup time.

**⚠️ Prerequisite: Must complete spike first (verify Bun compile + dynamic import)**

**Spike steps:**

1. Create a minimal test: write `test-dynamic-import.ts` under `script/` using `import("@ai-sdk/anthropic")` dynamic import
2. Compile with `bun build --compile` to a binary
3. Run the compiled binary and verify dynamic import succeeds
4. If it fails, record the error and switch to the fallback approach

**Acceptance Criteria:**

- [ ] **Spike complete**: Bun compile support for dynamic `import()` has been verified; conclusion documented in PR description
- [ ] If Bun compile supports dynamic import:
  - [ ] Convert 20+ `import { createXxx } from "@ai-sdk/xxx"` in `provider/provider.ts` to dynamic `import()` inside factory functions
  - [ ] Each provider is only imported when the user actually selects it
  - [ ] Use a `Map<string, () => Promise<SDK>>` registry pattern, keyed by provider ID
  - [ ] Cache imported provider references to avoid duplicate loading
- [ ] If Bun compile **does not support** dynamic import (fallback):
  - [ ] Group providers into "common" (anthropic, openai, google) and "other"
  - [ ] Eager-load "common", lazy-load "other" via conditional require or code splitting
- [ ] Typecheck passes

### US-008: Config loading pipeline optimization

**Description:** As a developer, I want config loading to be more efficient by reducing redundant filesystem scans and parallelizing independent operations.

**Current state analysis:**
`Config.state()` internal flow (starting at `config.ts` line 63):

1. `await Auth.all()` — fetches auth credentials (contains remote wellknown information)
2. Iterates over wellknown entries in auth → serial `fetch()` for remote configs
3. `await global()` — reads global config file
4. `await Filesystem.findUp("opencode.jsonc", ...)` + `await Filesystem.findUp("opencode.json", ...)` — two directory scans
5. For each `.opencode/` directory: `await needsInstall(dir)` → `await installDependencies(dir)` — **⚠️ MAJOR BLOCKER**: runs `bun add @opencode-ai/plugin@{version} --exact` + `bun install` per directory. On cold npm cache, this can take **10+ seconds per directory**. Multiple `.opencode/` directories (global + project + home) multiply the cost.
6. Subsequent `loadCommand()`, `loadAgent()`, `loadMode()`, `loadPlugin()` — multiple `.opencode/` directory scans

Step 2 depends on step 1's auth result (needs token), but step 3 (global config) does not depend on auth.

**⚠️ `installDependencies()` is potentially the slowest operation in the entire Config.state() pipeline.** It runs `BunProc.run(["add", ...])` and `BunProc.run(["install"])` synchronously per directory. Unlike US-006's `BunProc.install()` (single package), this installs all dependencies for the `.opencode/` directory's `package.json`. Priority should be elevated accordingly.

**Acceptance Criteria:**

- [ ] Run `Auth.all()` and `global()` config reading in parallel (`global()` does not depend on auth)
- [ ] Merge or parallelize `Filesystem.findUp("opencode.jsonc")` and `Filesystem.findUp("opencode.json")` into a single call
- [ ] Parallelize `loadCommand()`, `loadAgent()`, `loadMode()`, `loadPlugin()` via `Promise.all()` — these use different glob patterns (`{command,commands}/**/*.md`, `{agent,agents}/**/*.md`, `{mode,modes}/*.md`, `{plugin,plugins}/*.{ts,js}`) across different subdirectories, so they cannot be consolidated into a single read but can run concurrently
- [ ] **Critical**: Defer `needsInstall()` + `installDependencies()` out of the Config.state() critical path. Options: (a) run after Config.state() returns with current config, update config async when install completes; (b) parallelize install across directories via `Promise.all()`; (c) check if `node_modules/@opencode-ai/plugin` exists and version matches — skip install entirely if so (current `needsInstall()` already does this but calls `PackageRegistry.isOutdated()` which may do a network request)
- [ ] Typecheck passes

### US-009: LSP and FileWatcher lazy initialization

**Description:** As a developer, I want LSP servers and file watcher to initialize lazily so that they don't add to the critical startup path.

**Acceptance Criteria:**

- [ ] Change `LSP.init()` in `InstanceBootstrap()` from `await` to fire-and-forget (`LSP.init().catch(log.error)`) or remove entirely, letting LSP auto-initialize on first tool invocation
- [ ] Verify whether `FileWatcher.init()` is already lazy via its `state()` — if so, `FileWatcher.init()` can be removed from bootstrap
- [ ] Verify that LSP server processes only spawn on first use of that language's LSP features (check if this is already the case)
- [ ] After bootstrap completes, pre-warm LSP and FileWatcher in background (`setTimeout(0)` or `queueMicrotask`)
- [ ] Ensure TUI first-frame rendering does not wait for LSP and FileWatcher readiness
- [ ] Typecheck passes

### US-010: TUI first-frame rendering prioritization (verification + enhancement)

**Status:** ⚠️ Partially implemented, blocking points remain

**Description:** As a developer, I want the TUI to show its first frame (logo, input prompt) before bootstrap completes so that the user perceives faster startup.

**Current state analysis (verified):**

Code analysis confirms that TUI and Worker bootstrap decoupling **is already implemented**:

1. In `thread.ts`, `tui()` is called after Worker creation (line 143) without waiting for Worker bootstrap
2. `InstanceBootstrap()` in the Worker does not execute at startup — it is lazily triggered via `Instance.provide()` middleware on the **first HTTP request** (line 197 in `server.ts`)
3. TUI's `SyncProvider` calls `bootstrap()` in `onMount` (`sync.tsx` line 412), which triggers SDK request → triggers `InstanceBootstrap()`

**However, there are three serial blocking points before `tui()` is called:**

```
thread.ts handler entry
  → resolveNetworkOptions(args)      // await Config.global() — blocker ① (US-015)
  → tui()
    → getTerminalBackgroundColor()   // worst case 1000ms timeout — blocker ② (US-014)
    → render()                       // TUI first frame
```

Additionally, the Worker thread has blocking:

- `await Log.init()` at worker.ts top-level (line 14) — blocks Worker RPC listening (US-012)

**This US serves as a combined verification item, confirming first-frame time meets targets after US-012/014/015 are complete:**

**Acceptance Criteria:**

- [ ] ~~TUI rendering does not wait for Worker bootstrap~~ ✅ Confirmed as current behavior
- [ ] After US-014 (terminal bg color), US-015 (resolveNetworkOptions), US-012 (Log.init) are complete, re-measure TUI first-frame time
- [ ] First-frame time (from process start to Logo render) < 200ms
- [ ] If user enters a message before bootstrap completes, verify current behavior (whether `status === "loading"` in sync.tsx prevents submission)
- [ ] Typecheck passes

### US-011: Startup performance regression tests

**Description:** As a developer, I want automated startup time tracking so that future changes don't regress cold start performance.

**⚠️ Dependency: Thresholds need to be set after Phase 1-3 optimizations are complete, based on measured data. The test framework can be built first with loose thresholds.**

**Acceptance Criteria:**

- [ ] Add `test/perf/startup.test.ts` performance test
- [ ] Test spawns `lark-opencode --startup-trace --help` and parses trace output
- [ ] Assert per-phase durations do not exceed preset thresholds (initial thresholds set to 1.5x of current baseline, tightened after optimization)
- [ ] Test runs optionally in CI (controlled by `OPENCODE_PERF_TEST=1` environment variable)
- [ ] No dependency on external services (mock remote config fetch)
- [ ] Typecheck passes

### US-012: Log.init() optimization

**Description:** As a developer, I want Log.init() to not block the startup critical path so that TUI rendering starts sooner.

**Current state analysis:**
Two `Log.init()` blocking points exist in the startup chain:

1. Main thread `index.ts` — called in yargs middleware, blocks all command parsing
2. Worker thread `worker.ts` line 14 — module top-level `await Log.init()`, blocks RPC listening

**Worker thread full startup chain (Log.init → Rpc.listen):**

```
worker.ts:
  L14:  await Log.init(...)                    ← BLOCKER (fs.truncate)
  L23-33: process.on("unhandledRejection/uncaughtException", ...)  ← sync, ~0ms
  L36-38: GlobalBus.on("event", ...)           ← sync, ~0ms
  L42-95: eventStream setup (define object)    ← sync, ~0ms
  L97:    startEventStream(process.cwd())      ← starts async polling loop (non-blocking, but creates SDK client)
  L99-143: define rpc object                   ← sync, ~0ms
  L145:   Rpc.listen(rpc)                      ← TUI can now send RPC requests
```

The gap between `Log.init()` completing and `Rpc.listen()` executing is mostly synchronous code, so the real blocker is `Log.init()` itself. However, `startEventStream()` at L97 creates an SDK client via `createOpencodeClient()` — if this has any synchronous overhead (module imports, initialization), it adds to the gap before `Rpc.listen()`.

`Log.init()` internal operations (`util/log.ts` line 58):

- `cleanup()` — uses `Bun.Glob` to scan old log files + `fs.unlink` to delete. ✅ **Already fire-and-forget** (not awaited at line 60), but missing `.catch()` so errors become unhandled rejections
- `await fs.truncate(logpath).catch(() => {})` — **actual blocking operation** (line 67), waits for file truncation to complete
- `Bun.file(logpath).writer()` — creates file writer (synchronous)

The primary blocker is `await fs.truncate()`, not `cleanup()`. `cleanup()` is already non-blocking.

**Design decision: Log.init internal buffering**
After decoupling `Global.ensureDirectories()` and `Log.init()`, directories may not be created when Log.init starts executing. Solution: `Log.init()` returns immediately, buffering logs to an in-memory array first. After `Global.ensureDirectories()` completes, it notifies Log to flush the buffer to disk. This allows both to start in parallel without strict ordering.

**Acceptance Criteria:**

- [ ] Change `Log.init()` to synchronous initialization, no await on any IO
- [ ] Buffer logs to an in-memory array first, independent of whether directories exist
- [ ] After `Global.ensureDirectories()` completes, call `Log.flush()` or similar mechanism to write buffer to disk and switch to direct-write mode
- [x] Change `cleanup()` to fire-and-forget — ✅ Already not awaited (line 60 in `util/log.ts`). Add `.catch(() => {})` to prevent unhandled rejections
- [ ] Make `await fs.truncate(logpath)` non-blocking (this is the **actual blocker**, not `cleanup()`) — either remove await or make truncation lazy
- [ ] Verify actual timing improvement after `Log.init()` optimization
- [ ] Typecheck passes

### US-013: Provider models-snapshot loading optimization

**Description:** As a developer, I want the provider models snapshot to be loaded efficiently so that large model registries don't slow down provider initialization.

**Current state analysis:**
`provider/models-snapshot.ts` took 443ms during SDK generation (observed build time), indicating large file size. If runtime also needs to parse this module, its parse/eval time could be a significant overhead.

**Acceptance Criteria:**

- [ ] **Pre-investigation**: Use US-001 profiling to confirm `models-snapshot.ts` runtime import duration
- [ ] If duration > 50ms: convert models-snapshot to JSON format, load with `Bun.file().json()` (JSON.parse is ~10x faster than JS eval)
- [ ] If duration > 100ms: consider lazy loading (only on provider selection UI or first model invocation)
- [ ] If duration < 50ms: mark as not needing optimization, close this US
- [ ] Typecheck passes

### US-014: Terminal background color detection optimization

**Description:** As a developer, I want terminal background color detection to not block TUI rendering so that the first frame appears immediately.

**Current state analysis:**
`getTerminalBackgroundColor()` at `app.tsx` lines 40-98 is the first `await` call in `tui()` (line 113), executing before TUI render.

How it works:

1. Sets stdin to raw mode
2. Sends escape sequence `\x1b]11;?\x07` to query terminal background color
3. Listens for stdin response, parses RGB values and calculates luminance
4. **If the terminal does not respond (many terminals don't support this), waits 1000ms then defaults to "dark"**

This means on terminals that don't support this escape sequence (e.g., many Linux terminals), TUI first frame is unconditionally delayed by 1 second. This is the **single largest blocking point** in the current startup chain.

**Optimization approaches (in recommended order):**

1. **Cache detection result**: Store result in KV store (`kv.get("terminal_mode")`), detect once on first launch, use cached result on subsequent launches. Users can manually switch via command.
2. **Reduce timeout**: Lower from 1000ms to 100-200ms. Most terminals supporting this feature respond in < 50ms.
3. **Async detection + render with default first**: Render first frame with "dark", update theme after background detection completes (may cause brief flash)
4. **Infer from environment variables**: Many terminals set `COLORFGBG` or `TERM_PROGRAM` environment variables, enabling direct inference without escape sequence detection

**Cache invalidation strategy:** Cache does not auto-invalidate. After changing terminal theme, users manually trigger re-detection via a command (e.g., `/theme detect` or "Detect terminal theme" in command palette).

**Acceptance Criteria:**

- [ ] `getTerminalBackgroundColor()` no longer blocks TUI first-frame rendering beyond 200ms
- [ ] Preferred approach: cache detection result to KV store, subsequent launches use cache directly (0ms blocking)
- [ ] If no cache (first launch): reduce detection timeout from 1000ms to 150ms
- [ ] Consider using `COLORFGBG` environment variable for fast inference, skipping terminal query
- [ ] Provide a command for users to manually trigger re-detection (clear cache + re-detect + update theme)
- [ ] Fallback behavior unchanged: default to "dark" when detection fails
- [ ] Typecheck passes

### US-015: resolveNetworkOptions decoupling

**Description:** As a developer, I want network options resolution to not block TUI rendering so that the first frame appears before config files are read.

**Current state analysis:**
`thread.ts` line 119:

```ts
const networkOpts = await resolveNetworkOptions(args)
```

This is awaited before calling `tui()`. `resolveNetworkOptions()` (`cli/network.ts` line 39) internally calls `Config.global()`, reading global config files.

The problem is that most TUI users don't need to start an HTTP server (`shouldStartServer` is false), yet `resolveNetworkOptions` is unconditionally executed.

**Design decision:**
Currently `shouldStartServer` depends on `networkOpts` values (`networkOpts.mdns`, `networkOpts.port !== 0`, etc.), which come from `Config.global()`. ~~Decoupling approach: skip config reading when no CLI flags present.~~ **Revised approach: defer, don't skip.** Skipping config reading would be a breaking change — users with `server: { port: 8080 }` in config (no CLI flags) would silently lose HTTP server functionality.

**Deferred approach:**

1. Call `tui()` immediately without waiting for network options
2. Resolve network options in the background (`resolveNetworkOptions()` + `Config.global()`)
3. After resolution completes, check `shouldStartServer` using both CLI args and config values (preserving current behavior)
4. If server is needed, start HTTP server late and hot-swap the TUI's SDK connection from RPC to HTTP

This preserves backward compatibility while unblocking first-frame rendering.

**Acceptance Criteria:**

- [ ] `tui()` call no longer waits for `resolveNetworkOptions()` — TUI starts with direct RPC communication immediately
- [ ] `resolveNetworkOptions()` runs in the background after `tui()` starts
- [ ] `shouldStartServer` logic preserved: checks both CLI arguments AND config values (no behavioral change)
- [ ] If `shouldStartServer` is true after background resolution: start HTTP server and transition SDK connection from RPC to HTTP transparently
- [ ] If `shouldStartServer` is false (common case): no additional work needed, TUI already running on RPC
- [ ] Typecheck passes

## Functional Requirements

- FR-1: Add `--startup-trace` flag, output JSON-formatted per-phase timing to stderr
- FR-2: `Global.ensureDirectories()` replaces module-level await, creates directories on first call
- FR-3: Parallelize `git rev-parse` calls in `Project.fromDirectory()`, cache results to `.git/opencode-metadata`
- FR-4: Add 3s timeout to remote fetch in `Config.state()`, degrade to empty config on failure, cache results for 5 minutes
- FR-5: Execute multiple wellknown fetches in `Config.state()` in parallel (`Promise.allSettled`)
- FR-6: Run `Plugin.init()`, `LSP.init()`, `SecurityConfig.load()` in parallel in `InstanceBootstrap()` (requires race condition verification first)
- FR-7: Load multiple plugins in parallel in `Plugin.state()` (install + import + init)
- FR-8: Change AI SDK providers in `provider/provider.ts` to on-demand dynamic import or grouped loading (requires spike first)
- FR-9: Run `Auth.all()` and local config reading in parallel in `Config.state()`; parallelize directory scans; defer `installDependencies()` out of critical path
- FR-10: Remove `LSP.init()` from bootstrap await chain, change to background pre-warming or initialize on first use
- FR-11: ~~TUI first-frame rendering does not wait for bootstrap~~ ✅ Already the case. Optimize main thread Log.init and resolveNetworkOptions blocking
- FR-12: Startup performance tests covering per-phase durations to prevent regressions
- FR-13: Make cleanup operation in `Log.init()` async, not blocking startup
- FR-14: Evaluate `models-snapshot.ts` runtime loading overhead, optimize as needed
- FR-15: Cache `getTerminalBackgroundColor()` detection result or reduce timeout to 150ms, not blocking first frame
- FR-16: Only execute `resolveNetworkOptions()` when HTTP server is needed, not blocking `tui()` call

## Non-Goals

- No changes to CLI functional behavior or API compatibility
- No modifications to plugin protocol or SDK interfaces
- No runtime performance optimizations (tool execution, LLM calls, etc.)
- No binary size optimization (separate PRD)
- No new external dependencies
- No changes to config precedence order or merge logic

## Technical Considerations

- **Bun compile + dynamic import**: Support for dynamic `import()` in `Bun.build({ compile: true })` needs verification. Must be confirmed through US-007's spike steps. If unsupported, US-007 falls back to grouped loading approach
- **Plugin parallelization race conditions**: When loading multiple plugins in parallel, they share a single `PluginInput`. `PluginInput` is currently used read-only (`client`, `project`, `worktree`, etc.), but verification is needed that plugin implementations don't perform writes
- **Plugin/LSP parallelization race conditions**: `Plugin.init()` registers config hooks and Bus subscriptions. If LSP.init() executes before Plugin hooks are registered and LSP triggers events that depend on plugin hooks, race conditions will occur. Must be confirmed through US-005's pre-validation step
- **Config cache consistency**: Wellknown caching introduces stale data risk. 5-minute TTL + background refresh is a reasonable compromise
- **TUI first-frame prioritization**: ✅ Worker bootstrap is already decoupled. However, three serial blocking points remain before TUI first frame: `resolveNetworkOptions()` → `getTerminalBackgroundColor()` → `render()`. Terminal background color detection blocks up to 1000ms in the worst case
- **Worker startup cost**: After Worker thread spawn, module top-level code must execute (`await Log.init()`, GlobalBus subscription, event stream startup). During this time, TUI SDK requests queue up waiting. Actual duration needs to be confirmed via US-001 profiling
- **Premature resolveNetworkOptions call**: `resolveNetworkOptions()` in `thread.ts` calls `Config.global()` to read config files, blocking TUI first-frame. Solution: defer network options resolution to background, start TUI immediately with direct RPC. If config indicates server should start, transition from RPC to HTTP after the fact. This preserves backward compatibility for users with `server: { port: 8080 }` in config
- **Git cache invalidation**: `.git/opencode-metadata` cache needs to be invalidated after `git checkout`, `git worktree`, and similar operations. Use `.git/HEAD` mtime as a validation check
- **Test isolation**: Startup performance tests need network isolation (mock fetch) and filesystem isolation (tmpdir) to avoid environment-dependent flakiness
- **models-snapshot size**: `provider/models-snapshot.ts` took 443ms at build time, suggesting large file size. Runtime JS parsing of large files is much slower than JSON.parse — needs profiling to confirm

## Success Metrics

- Establish per-phase duration baseline (concrete numbers determined after US-001 completion)
- `global-init` phase reduced from blocking import to 0ms (US-002)
- `log-init` cleanup no longer blocks startup (US-012)
- `git-metadata` phase < 5ms on cache hit (US-003)
- `config-load` phase < 3.5s on network timeout (US-004)
- `bootstrap` total time reduced by 40%+ (US-005 + US-006)
- `terminal-bg-detect` reduced from 1000ms to < 150ms, or 0ms on cache hit (US-014)
- `resolve-network-options` at 0ms in no-server mode (US-015)
- TUI first-frame display time < 200ms (US-010, depends on US-014 + US-015 + US-012 completion)
- No functional regressions, all existing tests pass

## Resolved Questions

1. **When is InstanceBootstrap() called in the Worker?**
   ✅ Verified: Lazily triggered via `Instance.provide()` middleware on the first HTTP request (`server.ts` line 197), not executed at Worker startup. TUI first-frame renders before bootstrap.

2. **Does `Global.Path` have a `cache` field?**
   ✅ Verified: Yes. `Global.Path.cache = path.join(xdgCache!, "opencode")` (`global/index.ts` line 9).

3. **Does Bun compile mode support dynamic `import()`?**
   ✅ Resolved: **Partial support with significant limitations.** Bun SFE (`bun build --compile`) supports dynamic `import()` only for **statically analyzable paths** (string literals). Runtime-computed paths (e.g., ``import(`./providers/${name}.ts`)``) **fail at runtime** in compiled binaries ([bun#11732](https://github.com/oven-sh/bun/issues/11732), [bun#6113](https://github.com/oven-sh/bun/issues/6113)). For US-007: since all 20+ AI SDK providers are already static dependencies of the entrypoint, they are bundled into the binary. Static dynamic imports like `import("@ai-sdk/anthropic")` should work because the module is already in the bundle. However, a `Map<string, () => Promise<SDK>>` registry using computed keys may fail. **US-007 spike is still required** to verify the exact pattern works in the compiled binary. Fallback: keep static imports with lazy evaluation via object lookup (no dynamic import needed).

4. **Can the current Plugin system's `BUILTIN` default plugin list be pre-compiled into the binary?**
   ✅ Resolved: **Not recommended.** BUILTIN plugins (`opencode-anthropic-auth@0.0.13`, `@gitlab/opencode-gitlab-auth@1.3.2`) are third-party npm packages with their own dependencies. Pre-compiling would require vendoring source code, introducing maintenance burden and licensing complexity. More practical approach: rely on `BunProc.install()`'s existing cache mechanism — `needsInstall()` already checks version match and skips install when cached (returns early at line 82 in `bun/index.ts`). The real optimization is ensuring `PackageRegistry.isOutdated()` (which may do a network request) doesn't block startup — add timeout or make it an async background check.

5. **What is the actual duration of multiple `Filesystem.findUp()` calls in `Config.state()`?**
   ✅ Resolved: **Not worth optimizing.** `findUp()` does one `fs.stat()` per directory level. Typical project: 2-5 levels, ~0.1ms each on warm FS cache. Two `findUp` calls combined < 2ms. The real bottleneck in Config.state is `installDependencies()` and remote wellknown fetches.

6. **What is the runtime import duration of `models-snapshot.ts`?**
   ✅ Resolved: **Partially answered, profiling still needed for exact number.** The file is 1.4MB JS object literal, but: (a) already lazy-loaded via `lazy()` + `await import()` in `models.ts` — not loaded at startup; (b) `Bun.file().json()` priority path checked first — if a cached JSON file exists, the snapshot is never loaded; (c) in compiled binary, it is pre-parsed bytecode (faster than raw JS parsing). The 443ms observed at build time is bundling cost, not runtime cost. Runtime cost is expected to be lower but non-trivial for 1.4MB object construction. US-001 profiling will confirm. If > 50ms: convert to JSON format (`JSON.parse` is ~10x faster than JS eval for large objects).

## Open Questions

None — all questions resolved.

# Test Analyze Report

## Summary

| Metric | Value |
|--------|-------|
| **Scope** | bun |
| **Total** | 1883 |
| **Pass** | 1393 |
| **Fail** | 489 |
| **Skip** | 1 |
| **Dual Verification** | PASS |

### Verification Details

- **Source A (summary line):** 489 failures
- **Source B (grep count):** 489 failures
- **Arithmetic check:** pass(1393) + fail(489) + skip(1) = 1883 — PASS
- **Silent skip check:** PASS (119 files on disk, 119 files executed)

---

## Failures

### Group: test/security/access_control_cases/helpers.ts — `SecurityConfig.resetConfig` (P1, 437 failures)

The `SecurityConfig` module no longer exports `resetConfig()`. Called by `teardownSecurityConfig()` in the test helper at `helpers.ts:50`. Every security test that uses the shared `afterEach` teardown hits this error.

| # | Priority | File | Test | Error Type | Error Message | Source |
|---|----------|------|------|------------|---------------|--------|
| 1–84 | P1 | test/security/.../bash-bypass.test.ts | (84 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 85–115 | P1 | test/security/.../llm-leakage.test.ts | (31 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 116–144 | P1 | test/security/.../grep-glob-bypass.test.ts | (29 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 145–172 | P1 | test/security/.../skill-subagent-bypass.test.ts | (28 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 173–199 | P1 | test/security/.../inheritance-bypass.test.ts | (27 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 200–224 | P1 | test/security/.../write-edit-bypass.test.ts | (25 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 225–249 | P1 | test/security/.../audit-evasion.test.ts | (25 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 250–274 | P1 | test/security/.../agent-interaction.test.ts | (25 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 275–298 | P1 | test/security/.../mcp-bypass.test.ts | (24 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 299–319 | P1 | test/security/.../role-authentication.test.ts | (21 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 320–340 | P1 | test/security/.../read-bypass.test.ts | (21 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 341–359 | P1 | test/security/.../path-traversal.test.ts | (19 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 360–377 | P1 | test/security/.../access-guard-integration.test.ts | (18 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 378–388 | P1 | test/security/.../config-manipulation.test.ts | (11 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 389–395 | P1 | test/security/.../race-condition.test.ts | (7 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 396–400 | P1 | test/security/integration/security-audit-integration.test.ts | (5 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 401–403 | P1 | test/security/integration/ast-grep-security.test.ts | (3 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 404–405 | P1 | test/security/integration/context-injection-security.test.ts | (2 tests) | runtime | `TypeError: SecurityConfig.loadSecurityConfig is not a function` | helpers.ts:42 |
| 406–407 | P1 | test/security/integration/background-agent-security.test.ts | (2 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 408 | P1 | test/security/integration/interactive-bash-security.test.ts | (1 test) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 409–418 | P1 | test/tool/interactive-bash.test.ts | (10 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 419–435 | P1 | test/tool/ast-grep.test.ts | (17 tests) | runtime | `TypeError: SecurityConfig.resetConfig is not a function` | helpers.ts:50 |
| 436–437 | P1 | test/tool/lsp-tools.test.ts | (2 tests) | runtime | `TypeError: SecurityConfig.loadSecurityConfig is not a function` | instance.ts:42 |

### Group: src/tool/grep.ts (P0, 16 failures)

`SecurityConfig.getSecurityConfig()` is called at `grep.ts:125` inside the tool's `execute()` function. This is **source code**, not test code, making it P0.

| # | Priority | File | Test | Error Type | Error Message | Source |
|---|----------|------|------|------------|---------------|--------|
| 438–439 | P0 | test/tool/grep.test.ts | (2 tests) | runtime | `TypeError: SecurityConfig.getSecurityConfig is not a function` | src/tool/grep.ts:125 |
| 440–453 | P0 | test/tool/grep-enhanced.test.ts | (14 tests) | runtime | `TypeError: SecurityConfig.getSecurityConfig is not a function` | src/tool/grep.ts:125 |

### Group: src/tool/bash.ts (P0, 15 failures)

`SecurityConfig.getSecurityConfig()` is called at `bash.ts:91` inside the tool's `execute()` function. This is **source code**, not test code, making it P0.

| # | Priority | File | Test | Error Type | Error Message | Source |
|---|----------|------|------|------------|---------------|--------|
| 454–468 | P0 | test/tool/bash.test.ts | (15 tests) | runtime | `TypeError: SecurityConfig.getSecurityConfig is not a function` | src/tool/bash.ts:91 |

### Group: src/session/llm.ts (P0, 4 failures)

`Provider.getProvider()` is called at `llm.ts:66` inside the `stream()` function. This is **source code**, not test code, making it P0.

| # | Priority | File | Test | Error Type | Error Message | Source |
|---|----------|------|------|------------|---------------|--------|
| 469 | P0 | test/session/llm.test.ts | stream > sends messages API payload for Anthropic models | runtime | `TypeError: Provider.getProvider is not a function` | src/session/llm.ts:66 |
| 470 | P0 | test/session/llm.test.ts | stream > sends responses API payload for OpenAI models | runtime | `TypeError: Provider.getProvider is not a function` | src/session/llm.ts:66 |
| 471 | P0 | test/session/llm.test.ts | stream > sends temperature, tokens, and reasoning options... | runtime | `TypeError: Provider.getProvider is not a function` | src/session/llm.ts:66 |
| 472 | P0 | test/session/llm.test.ts | stream > sends Google API payload for Gemini models | runtime | `TypeError: Provider.getProvider is not a function` | src/session/llm.ts:66 |

### Group: Assertion failures — Security not enforced (P3, 10 failures)

Tests expect security to block access but security rules were never loaded (consequence of missing `SecurityConfig` API).

| # | Priority | File | Test | Error Type | Error Message | Source |
|---|----------|------|------|------------|---------------|--------|
| 473 | P3 | test/tool/look-at.test.ts | protected file -> SecurityAccess denies read | assertion | Expected to contain: "Security access denied" | — |
| 474 | P3 | test/tool/look-at.test.ts | read allowed but llm denied -> blocked before vision model | assertion | Expected to contain: "Security access denied" | — |
| 475 | P3 | test/tool/lsp-tools-extended.test.ts | lsp_diagnostics filters protected files from results | assertion | Expected: false, Received: true | — |
| 476 | P3 | test/tool/lsp-tools-extended.test.ts | lsp_rename filters protected files from workspace edit... | assertion | Expected: false, Received: true | — |
| 477 | P3 | test/tool/interactive-bash.test.ts | experimental flag disabled -> tool not registered | assertion | Expected: undefined, Received: {...} | — |
| 478 | P3 | test/tool/ast-grep.test.ts | (3 assertion failures) | assertion | Expected: 0, Received: 1 | — |
| 479–480 | P3 | test/session/hooks/context-injection.test.ts | (2 assertion failures) | assertion | Expected value to be defined / greater than 0 | — |

### Ungrouped: context-injection hooks (P1, 7 failures)

| # | Priority | File | Test | Error Type | Error Message | Source |
|---|----------|------|------|------------|---------------|--------|
| 481–489 | P1 | test/session/hooks/context-injection.test.ts | (9 tests) | runtime | `TypeError: SecurityConfig.loadSecurityConfig is not a function` | helpers.ts:42 |

---

## Per-File Breakdown

### test/security/access_control_cases/unit/bash-bypass.test.ts (84 failures)

All 84 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function. (In 'SecurityConfig.resetConfig()', 'SecurityConfig.resetConfig' is undefined)
>
> Stack:
> ```
> at teardownSecurityConfig (test/security/access_control_cases/helpers.ts:50)
> ```

### test/security/access_control_cases/unit/llm-leakage.test.ts (31 failures)

All 31 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/security/access_control_cases/unit/grep-glob-bypass.test.ts (29 failures)

All 29 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/security/access_control_cases/unit/skill-subagent-bypass.test.ts (28 failures)

All 28 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/security/access_control_cases/unit/inheritance-bypass.test.ts (27 failures)

All 27 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/security/access_control_cases/unit/write-edit-bypass.test.ts (25 failures)

All 25 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/security/access_control_cases/unit/audit-evasion.test.ts (25 failures)

All 25 tests fail with `runtime` (P1). Some also reference `SecurityAudit.createContentSummary is not a function`.

### test/security/access_control_cases/unit/agent-interaction.test.ts (25 failures)

All 25 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/security/access_control_cases/unit/mcp-bypass.test.ts (24 failures)

All 24 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/security/access_control_cases/unit/role-authentication.test.ts (21 failures)

All 21 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/security/access_control_cases/unit/read-bypass.test.ts (21 failures)

All 21 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/tool/ast-grep.test.ts (20 failures)

17 tests fail with `runtime` (P1) — `SecurityConfig.resetConfig is not a function`
3 tests fail with `assertion` (P3) — `Expected: 0, Received: 1`

### test/security/access_control_cases/unit/path-traversal.test.ts (19 failures)

All 19 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/security/access_control_cases/unit/access-guard-integration.test.ts (18 failures)

All 18 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/tool/bash.test.ts (15 failures)

All 15 tests fail with `runtime` (P0):
> TypeError: SecurityConfig.getSecurityConfig is not a function
>
> Stack:
> ```
> at execute (src/tool/bash.ts:91)
> at Object.<anonymous> (src/tool/tool.ts:69)
> ```

### test/tool/grep-enhanced.test.ts (14 failures)

All 14 tests fail with `runtime` (P0):
> TypeError: SecurityConfig.getSecurityConfig is not a function
>
> Stack:
> ```
> at execute (src/tool/grep.ts:125)
> ```

### test/security/access_control_cases/unit/config-manipulation.test.ts (11 failures)

All 11 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/tool/interactive-bash.test.ts (11 failures)

10 tests fail with `runtime` (P1) — `SecurityConfig.resetConfig is not a function`
1 test fails with `assertion` (P3) — `Expected: undefined, Received: {...}`

### test/session/hooks/context-injection.test.ts (9 failures)

3 tests fail with `runtime` (P1) — `SecurityConfig.loadSecurityConfig is not a function`
5 tests fail with `assertion` (P3) — `Expected value to be defined`
1 test fails with `assertion` (P3) — `Expected value to be greater than 0`

### test/security/access_control_cases/unit/race-condition.test.ts (7 failures)

All 7 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/security/integration/security-audit-integration.test.ts (5 failures)

All 5 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/session/llm.test.ts (4 failures)

All 4 tests fail with `runtime` (P0):
> TypeError: Provider.getProvider is not a function
>
> Stack:
> ```
> at stream (src/session/llm.ts:66)
> ```

1. **stream > sends messages API payload for Anthropic models** — `runtime` (P0)
   > Provider.getProvider is not a function. (In 'Provider.getProvider(providerID)', 'Provider.getProvider' is undefined)

2. **stream > sends responses API payload for OpenAI models** — `runtime` (P0)
   > Provider.getProvider is not a function

3. **stream > sends temperature, tokens, and reasoning options for openai-compatible models** — `runtime` (P0)
   > Provider.getProvider is not a function

4. **stream > sends Google API payload for Gemini models** — `runtime` (P0)
   > Provider.getProvider is not a function

### test/security/integration/ast-grep-security.test.ts (3 failures)

All 3 tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/tool/lsp-tools.test.ts (2 failures)

Both tests fail with `runtime` (P1):
> TypeError: SecurityConfig.loadSecurityConfig is not a function

### test/tool/lsp-tools-extended.test.ts (2 failures)

Both tests fail with `assertion` (P3):
> expect(received).toBe(expected) — Expected: false, Received: true

### test/tool/look-at.test.ts (2 failures)

1. **protected file -> SecurityAccess denies read** — `assertion` (P3)
   > Expected to contain: "Security access denied"
   > Received: "Analysis: This image shows a 1x1 pixel."

2. **read allowed but llm denied -> blocked before vision model** — `assertion` (P3)
   > Expected to contain: "Security access denied"
   > Received: "Analysis: This image shows a 1x1 pixel."

### test/tool/grep.test.ts (2 failures)

Both tests fail with `runtime` (P0):
> TypeError: SecurityConfig.getSecurityConfig is not a function
>
> Stack:
> ```
> at execute (src/tool/grep.ts:125)
> ```

### test/security/integration/context-injection-security.test.ts (2 failures)

Both tests fail with `runtime` (P1):
> TypeError: SecurityConfig.loadSecurityConfig is not a function

### test/security/integration/background-agent-security.test.ts (2 failures)

Both tests fail with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/session/hooks/hooks-bench.test.ts (1 failure — included in context-injection count above)

Fails with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

### test/security/integration/interactive-bash-security.test.ts (1 failure)

Fails with `runtime` (P1):
> TypeError: SecurityConfig.resetConfig is not a function

---

## Root Cause Analysis

### Root Cause A: SecurityConfig API removed/renamed (472 of 489 failures — 96.5%)

The `SecurityConfig` module no longer exports these functions:
- `resetConfig()` — called by `helpers.ts:50` (`teardownSecurityConfig`)
- `loadSecurityConfig(dir)` — called by `helpers.ts:42` (`setupSecurityConfig`) and `instance.ts:42`
- `getSecurityConfig()` — called by `src/tool/grep.ts:125` and `src/tool/bash.ts:91`
- `mergeSecurityConfigs()` — called by inheritance and config-manipulation tests

**Impact:** 437 test helper teardown failures + 31 source-code runtime failures + 4 related assertion failures.

**Fix:** Restore these exports in the SecurityConfig module, or update all callers to use the new API.

### Root Cause B: Provider.getProvider removed/renamed (4 failures — 0.8%)

`Provider.getProvider(providerID)` is no longer exported. Called by `src/session/llm.ts:66`.

**Impact:** All 4 tests in `test/session/llm.test.ts` fail.

**Fix:** Restore the export or update `llm.ts` to use the new API.

### Root Cause C: Security enforcement not active (10 assertion failures — 2.0%)

Tests expect security to block access but security rules were never loaded (consequence of Root Cause A). These will likely auto-fix once Root Cause A is resolved.

### Root Cause D: ast-grep assertion failures (3 failures — 0.6%)

Three assertion failures where tool exit code or match count differs from expected. Likely independent issues.

---

## Raw Output

Raw output was not saved to disk. Use `--output <path>` to persist the raw test output.

Raw output is temporarily available at: `/tmp/test-output-raw.txt`

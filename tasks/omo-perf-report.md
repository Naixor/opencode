# OMO Hook Pipeline Performance Report

**Date:** 2026-02-14
**Platform:** macOS Darwin 23.6.0, Bun 1.3.8
**Test file:** `packages/opencode/test/session/hooks/hooks-bench.test.ts`
**Run command:** `bun test --cwd packages/opencode -- test/session/hooks/hooks-bench.test.ts`

## Summary

All hook pipeline operations are well within performance targets. The hook system adds negligible overhead to the agent loop — sub-millisecond for most operations, even with all 26 hooks registered.

## Chain Execution Latency

| Chain | Hooks | Target | p50 | p99 | Result |
|-------|-------|--------|-----|-----|--------|
| PreLLMChain (isolated) | 5 | < 5ms | 0.002ms | 0.017ms | PASS |
| PreToolChain (isolated) | 3 | < 2ms | 0.001ms | 0.009ms | PASS |
| PostToolChain (isolated) | 5 | < 10ms | 0.002ms | 0.011ms | PASS |
| PreLLMChain (full pipeline) | all | < 5ms | 0.019ms | 0.030ms | PASS |
| PreToolChain (full pipeline) | all | < 2ms | 0.001ms | 0.007ms | PASS |
| PostToolChain (full pipeline) | all | < 10ms | 0.020ms | 0.034ms | PASS |
| SessionLifecycle (full pipeline) | all | — | 0.003ms | 0.017ms | PASS |

## Tool Output Truncation

| Input Size | Target | p50 | p99 | Result |
|------------|--------|-----|-----|--------|
| 1KB (no truncation) | < 1ms | 0.000ms | 0.001ms | PASS |
| 100KB | < 5ms | 0.003ms | 0.007ms | PASS |
| 1MB | < 20ms | 0.024ms | 0.029ms | PASS |
| 10MB | < 50ms | 0.254ms | 0.275ms | PASS |

## Context Window Monitoring

| Operation | Target | p50 | p99 | Result |
|-----------|--------|-----|-----|--------|
| estimateTokens (100KB text) | < 1ms | 0.000ms | 0.000ms | PASS |
| estimateContextUsage (10KB system + 50 msgs) | < 5ms | 0.024ms | 0.066ms | PASS |
| getModelContextWindow (6 models) | < 0.1ms | 0.000ms | 0.002ms | PASS |

## Disabled Hook Overhead

| Scenario | Target | p50 | p99 | Result |
|----------|--------|-----|-----|--------|
| Disabled hook (1000 iterations) | < 0.01ms | 0.000ms | 0.003ms | PASS |

The disabled hook path involves only a compiled chain lookup (already cached) with zero enabled hooks — essentially a no-op.

## Context Injection Caching

| Scenario | p50 | p99 |
|----------|-----|-----|
| AGENTS.md cache HIT | 0.002ms | 0.007ms |
| AGENTS.md cache MISS (file not found) | 0.038ms | 0.188ms |
| **Cache hit/miss ratio** | **~24x faster** | — |

Cache misses involve async file system operations (`Bun.file().exists()`), explaining the ~24x difference. After the first call per session, all subsequent calls are cache hits.

## Auxiliary Operations

| Operation | p50 | p99 |
|-----------|-----|-----|
| Chain compilation (20 hooks) | 0.019ms | 0.036ms |
| countGrepMatches (500 lines) | 0.023ms | 0.033ms |
| extractCriticalContext (100 messages) | 0.129ms | 0.165ms |
| extractIncompleteTodos (100 messages) | 0.141ms | 0.199ms |

## Full Pipeline Summary

With all 26 hooks registered across 7 modules (error recovery, output management, context injection, detection/checking, agent enforcement, session lifecycle, LLM parameters):

- **Total hooks:** 26
- **PreLLM chain (heaviest):** 0.019ms p50, 0.030ms p99
- **PostTool chain:** 0.020ms p50, 0.034ms p99
- **PreTool chain:** 0.001ms p50, 0.007ms p99
- **SessionLifecycle chain:** 0.003ms p50, 0.017ms p99

**Conclusion:** The hook pipeline adds < 0.1ms of overhead per tool execution even in the worst case. This is orders of magnitude below the performance targets (5ms for PreLLM, 2ms for PreTool, 10ms for PostTool). The overhead is negligible compared to LLM API latency (~1-30 seconds).

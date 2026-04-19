# Memory recall

How local memory and Hindsight work together.

---

## Treat sources differently

- `personal.json` is authoritative for stored memories
- Hindsight is a companion index and retrieval layer, not the source of truth
- On `Memory.create()` and `Memory.update()`, OpenCode saves locally first and then mirrors the memory to Hindsight
- If Hindsight sync fails, local memory still succeeds and remains usable

---

## Follow the pre-LLM flow

- The `memory-injector` hook runs in the `pre-llm` chain at priority `130`
- It skips `memory-extractor` and `memory-recall` to avoid recursive injection
- It loads local memories with `Memory.list()`, builds a candidate pool, and appends the final memory block at the end of the system prompt
- It reuses cached resolved output for sticky child sessions until normal refresh rules apply

---

## Use Hindsight early

- Before `RECALL_THRESHOLD` user messages, recall stays in the early phase
- In this phase, OpenCode queries Hindsight directly with the recent conversation and maps hits back onto the local memory pool
- If Hindsight returns matching candidates, those local memories are injected directly
- This keeps early turns cheap and fast without running a recall LLM

---

## Use the LLM later

- At or after `RECALL_THRESHOLD`, OpenCode moves to the recall phase
- It still uses local memory as the candidate source, but may first ask Hindsight to rank that pool
- The `memory-recall` subagent then filters candidates for relevance and detects conflicts through the normal `SessionPrompt.prompt()` pipeline
- The filtered result is cached per session and refreshed on cache miss, dirty memory state, or the re-recall interval

---

## Fall back safely

- If there are no local memories, nothing is injected
- If Hindsight recall fails or returns no usable candidates, OpenCode falls back to full local-pool injection
- If LLM recall fails, returns no cacheable result, or produces an unparseable response, OpenCode treats all candidate local memories as relevant or injects the full local selection
- Fallback always preserves the local memory path as the reliable baseline

---

## Feed extraction with context

- When Hindsight-assisted extraction is enabled, the extractor first retains the current session slice in Hindsight
- It then queries Hindsight for related context before calling the extractor LLM
- Returned snippets are normalized into hint lines, preferring `source_facts`, then `chunks`, then raw hit text
- Those hints are injected into the extractor system prompt as `## Hindsight context`, capped by item count and token budget

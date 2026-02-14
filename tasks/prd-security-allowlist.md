# PRD: Security Access Control Allowlist (白名单机制)

## Introduction

Add an allowlist mechanism to the existing security access control system, enabling project owners to restrict LLM access to only explicitly permitted files and directories. When an allowlist is configured, the LLM can only access files matching the allowlist patterns. The existing deny rules remain active with higher priority — even if a file is on the allowlist, it can still be blocked by a deny rule. This provides a "default-deny" posture for LLM operations when the allowlist is present.

## Goals

- Enable project owners to define an explicit set of files/directories the LLM is allowed to access
- Restrict only `llm` operations — `read` and `write` operations are unaffected by the allowlist
- Maintain backward compatibility: no allowlist configured = current behavior (everything accessible, only deny rules apply)
- Ensure deny rules always take precedence over the allowlist (deny > allow > default-deny)
- Support multi-level config merging where child allowlists can only narrow, not expand, parent scope
- Wire up multi-level config loading in bootstrap to enable hierarchical allowlist enforcement

## User Stories

### US-001: Add allowlist schema and ResolvedSecurityConfig type
**Description:** As a project owner, I want to define an `allowlist` field in `.opencode-security.json` so that I can specify which files and directories the LLM is permitted to access.

**Acceptance Criteria:**
- [ ] Add `AllowlistEntry` Zod schema in `schema.ts` with fields: `pattern` (string), `type` (`"directory" | "file"`)
- [ ] Add `AllowlistLayer` interface in `schema.ts`: `{ source: string, entries: AllowlistEntry[] }` — `source` identifies the config file path that defined this layer
- [ ] Add optional `allowlist` field to `securityConfigSchema` as `z.array(AllowlistEntry).optional()` — this is the JSON-persisted format
- [ ] Add `ResolvedSecurityConfig` interface in `schema.ts` that extends `SecurityConfig` with `resolvedAllowlist: AllowlistLayer[]` — this is the runtime type used by `checkAccess()` and all callers
- [ ] Schema validation accepts configs with and without the `allowlist` field
- [ ] Existing configs without `allowlist` continue to parse successfully
- [ ] Typecheck passes

### US-002: Introduce ResolvedSecurityConfig and update callers
**Description:** As a developer, I want `getSecurityConfig()` to return a `ResolvedSecurityConfig` so that `checkAccess()` and all other callers have access to the resolved allowlist layers.

**Acceptance Criteria:**
- [ ] Change `getSecurityConfig()` return type from `SecurityConfig` to `ResolvedSecurityConfig`
- [ ] Change internal `currentConfig` variable type from `SecurityConfig` to `ResolvedSecurityConfig`
- [ ] `emptyConfig` includes `resolvedAllowlist: []` (no restriction by default)
- [ ] `loadSecurityConfig()` builds `resolvedAllowlist` from the single config's `allowlist` field: if `allowlist` is defined, create one `AllowlistLayer` with `source` set to the config file path; if not defined, `resolvedAllowlist` is `[]`
- [ ] Update all callers of `getSecurityConfig()` to use the new type — most callers only access existing fields so changes should be minimal
- [ ] Typecheck passes

### US-003: Wire up multi-level config loading in bootstrap
**Description:** As a developer, I want the bootstrap flow to use `findSecurityConfigs()` + `mergeSecurityConfigs()` instead of single-file `loadSecurityConfig()`, so that hierarchical configs (including multi-level allowlists) are properly loaded.

**Acceptance Criteria:**
- [ ] Modify `loadSecurityConfig()` (or introduce a new entry point) to use `findSecurityConfigs(projectRoot)` to discover all `.opencode-security.json` files from project root up to git root
- [ ] Pass discovered configs through `mergeSecurityConfigs()` to produce the final merged config
- [ ] The merged result is stored as `ResolvedSecurityConfig` with properly built `resolvedAllowlist` layers
- [ ] Bootstrap call in `packages/opencode/src/project/bootstrap.ts` uses the updated loading path
- [ ] Single-config scenario (only one `.opencode-security.json` exists) behaves identically to before
- [ ] No-config scenario (no `.opencode-security.json` found) returns empty config as before
- [ ] Typecheck passes

### US-004: Enforce allowlist in checkAccess for LLM operations
**Description:** As a project owner, I want `checkAccess()` to deny `llm` operations on files NOT in the allowlist, so that the LLM cannot access unapproved content.

**Acceptance Criteria:**
- [ ] When `resolvedAllowlist` has one or more layers, `checkAccess()` denies `llm` operations on files that don't pass **every** layer
- [ ] For each `AllowlistLayer`, the file must match at least one `AllowlistEntry` in that layer to pass
- [ ] When no allowlist is configured (no layers), behavior is unchanged (all files accessible by default)
- [ ] `read` and `write` operations are NOT affected by the allowlist — only `llm` is restricted
- [ ] Deny rules still take precedence: a file matching both the allowlist and a deny rule for `llm` is still denied
- [ ] Allowlist matching uses `minimatch` with `matchBase: true`, consistent with deny rules
- [ ] `AllowlistEntry` with `type: "directory"` matches the directory itself and all nested files (same logic as deny rule directory matching)
- [ ] `AllowlistEntry` with `type: "file"` matches the specific file only (same logic as deny rule file matching)
- [ ] Access denial reason message is **user-friendly and actionable**, clearly indicating:
  - The file is not in the allowlist
  - Which layer(s) rejected it (with source config path)
  - How to resolve it: suggest the user add the file/directory pattern to the appropriate `.opencode-security.json` allowlist
  - Example: `"Access denied: LLM cannot access 'test/foo.ts' — file is not in the allowlist. Rejected by allowlist in '/project/.opencode-security.json'. To grant access, add a matching entry (e.g. { \"pattern\": \"test/**\", \"type\": \"directory\" }) to the 'allowlist' field in that config file."`
- [ ] Typecheck passes

### US-005: Allowlist evaluation order in checkAccess
**Description:** As a developer, I want the access control evaluation to follow the correct priority: deny rules > allowlist > default-allow, so that the security model is predictable.

**Acceptance Criteria:**
- [ ] Evaluation order in `checkAccess()`:
  1. Resolve symlinks
  2. Check deny rules first — if any deny rule matches, deny access (regardless of allowlist)
  3. If operation is not `llm`, allow access (allowlist only affects `llm`)
  4. If `resolvedAllowlist` has layers, check if the file passes every layer — if not, deny `llm` access
  5. If no deny rule matched and file passes all allowlist layers (or no allowlist configured), allow access
- [ ] A file in the allowlist that is also covered by a deny rule with `llm` in `deniedOperations` is correctly denied
- [ ] A file NOT in the allowlist is denied for `llm` operations even if no deny rule covers it
- [ ] Symlink handling: resolve symlinks first, then check the **resolved (real) path** against the allowlist. This means: a symlink outside the allowlist pointing to an allowed real path → allowed; a symlink inside the allowlist pointing to a real path outside the allowlist → denied. The resolved path determines access.
- [ ] Typecheck passes

### US-006: Merge allowlists across multi-level configs
**Description:** As a project owner with nested `.opencode-security.json` files, I want child allowlists to only narrow the parent's allowlist scope, so that subdirectories cannot grant access beyond what the parent permits.

**Acceptance Criteria:**
- [ ] Change `mergeSecurityConfigs()` signature: input from `SecurityConfig[]` to `{ config: SecurityConfig, path: string }[]`; return type from `SecurityConfig` to `ResolvedSecurityConfig`
- [ ] Each config that defines `allowlist` produces one `AllowlistLayer` in the merged result's `resolvedAllowlist`
- [ ] `AllowlistLayer.source` is set to the config file path for traceability
- [ ] At runtime, a file must match at least one entry in **every** layer to be allowed (logical AND across layers, OR within each layer)
- [ ] If only the parent defines `allowlist`, there is one layer — the parent's
- [ ] If only the child defines `allowlist`, there is one layer — the child's
- [ ] If both define `allowlist`, there are two layers — the file must pass both
- [ ] A child config cannot expand access beyond the parent's allowlist (enforced by the AND logic)
- [ ] If neither defines `allowlist`, `resolvedAllowlist` is empty (no restriction)
- [ ] Typecheck passes

### US-007: Warn on empty allowlist configuration
**Description:** As a project owner, I want to be warned if I configure an empty allowlist, so that I don't accidentally block all LLM access.

**Acceptance Criteria:**
- [ ] When `allowlist` is present but is an empty array `[]`, log a warning: "Empty allowlist configured — all LLM operations will be denied. No files are accessible to the LLM."
- [ ] Warning is logged during config loading (in `loadSecurityConfig()` or the merged config building step)
- [ ] Empty allowlist still functions as intended: all `llm` operations are denied (the layer has zero entries, so no file can match)
- [ ] Typecheck passes

### US-008: Audit logging for allowlist denials
**Description:** As a security auditor, I want allowlist-denied events to appear in the audit log, so that I can track unauthorized LLM access attempts.

**Acceptance Criteria:**
- [ ] When a file is denied due to not being in the allowlist, call `SecurityAudit.logSecurityEvent()` with the denial details
- [ ] Audit log entry includes: path, operation (`llm`), role, `allowed: false`, reason (with allowlist context), and which layer(s) rejected it
- [ ] Follows the same logging format as existing deny rule audit events
- [ ] Typecheck passes

### US-009: Unit tests for allowlist enforcement
**Description:** As a developer, I want comprehensive unit tests for the allowlist feature so that edge cases and interactions with deny rules are verified.

**Acceptance Criteria:**
- [ ] Test: file matches allowlist entry (type: file), no deny rule → `llm` allowed
- [ ] Test: file matches allowlist entry (type: directory), no deny rule → `llm` allowed for nested files
- [ ] Test: file NOT in allowlist → `llm` denied with friendly actionable message (includes rejected path, rejecting layer source, and suggestion to add entry)
- [ ] Test: file in allowlist but covered by deny rule → `llm` denied (deny wins)
- [ ] Test: `read` and `write` operations unaffected by allowlist
- [ ] Test: empty allowlist array `[]` → all `llm` operations denied, warning logged
- [ ] Test: no allowlist field → all files accessible (backward compatible)
- [ ] Test: allowlist with directory entry (e.g. `{ pattern: "src/**", type: "directory" }`) matches nested files
- [ ] Test: allowlist with file entry (e.g. `{ pattern: "README.md", type: "file" }`) matches only that file
- [ ] Test: symlink target checked against allowlist
- [ ] Test: two-layer allowlist — file must match both layers
- [ ] Test: child config cannot expand parent allowlist (parent allows `src/**`, child allows `src/**` + `test/**` → `test/**` still denied)
- [ ] Test: single-layer allowlist (only parent or only child defines it)
- [ ] Test: multi-level config loading produces correct `ResolvedSecurityConfig`
- [ ] Test: audit log records allowlist denial events
- [ ] All tests pass with `bun test --cwd packages/opencode`
- [ ] Typecheck passes

### US-010: Update security check CLI command for allowlist
**Description:** As a user, I want the `opencode security check <path>` CLI command to show allowlist status, so that I can verify whether a file is in the allowlist.

**Acceptance Criteria:**
- [ ] `security check` output includes whether the file matches the current allowlist
- [ ] If no allowlist is configured, output indicates "No allowlist configured (all files accessible)"
- [ ] If allowlist is configured, output shows per-layer match status: which layer matched (with source path) and which pattern matched, or "Not matched" per layer
- [ ] Typecheck passes

## Functional Requirements

- FR-1: Add `AllowlistEntry` schema (`{ pattern: string, type: "directory" | "file" }`) to `packages/opencode/src/security/schema.ts`
- FR-2: Add `AllowlistLayer` interface (`{ source: string, entries: AllowlistEntry[] }`) to `packages/opencode/src/security/schema.ts`
- FR-3: Add `ResolvedSecurityConfig` interface extending `SecurityConfig` with `resolvedAllowlist: AllowlistLayer[]` to `packages/opencode/src/security/schema.ts`
- FR-4: Add optional `allowlist` field (`z.array(AllowlistEntry).optional()`) to `securityConfigSchema`
- FR-5: Change `getSecurityConfig()` return type to `ResolvedSecurityConfig`; update `currentConfig` and `emptyConfig` accordingly
- FR-6: Modify `loadSecurityConfig()` to use `findSecurityConfigs()` + `mergeSecurityConfigs()` for multi-level config support; update bootstrap call
- FR-7: Change `mergeSecurityConfigs()` signature to accept `{ config: SecurityConfig, path: string }[]` and return `ResolvedSecurityConfig`; build `resolvedAllowlist: AllowlistLayer[]` from each config's `allowlist` field with its source path
- FR-8: When allowlist layers exist, `checkAccess()` must deny `llm` operations on files not matching every layer (AND across layers, OR within entries per layer)
- FR-9: `read` and `write` operations must NOT be restricted by the allowlist — only `llm` is affected
- FR-10: Deny rules always take precedence over the allowlist: the evaluation order is deny check → allowlist check → default allow
- FR-11: Allowlist matching must use `minimatch` with `matchBase: true`, consistent with existing deny rule matching
- FR-12: `AllowlistEntry` with `type: "directory"` matches using the same directory matching logic as deny rules (pattern itself + `pattern/**`)
- FR-13: `AllowlistEntry` with `type: "file"` matches using the same file matching logic as deny rules (exact pattern match)
- FR-14: When `allowlist` is `undefined` or not present in config, the system behaves identically to the current implementation (no restriction)
- FR-15: When `allowlist` is an empty array `[]`, all `llm` operations are denied, and a warning is logged during config loading
- FR-16: Symlink handling for allowlist: resolve symlinks first, then check the **resolved (real) path** against the allowlist — the real file location determines access
- FR-17: Allowlist denial events must be recorded via `SecurityAudit.logSecurityEvent()`
- FR-18: The `security check` CLI command must display per-layer allowlist match status
- FR-19: Allowlist denial messages must be user-friendly and actionable — include the rejected file path, which config layer rejected it, and a suggestion on how to add the file to the allowlist (with example entry format)

## Non-Goals

- No allowlist support for `read` or `write` operations (only `llm`)
- No role-based differentiation for allowlist — it applies uniformly to all roles
- No allowlist UI in the TUI or web interface
- No wildcard negation patterns (e.g. `"!test/**"`) — use deny rules for exclusions
- No per-tool allowlist configuration — the allowlist applies globally to all tools performing `llm` operations
- No runtime allowlist modification — changes require editing `.opencode-security.json`

## Technical Considerations

### Key Data Structures

```typescript
// In schema.ts — persisted in .opencode-security.json
const AllowlistEntry = z.object({
  pattern: z.string(),                    // glob pattern, e.g. "src/**", "README.md"
  type: z.enum(["directory", "file"]),    // matching behavior, aligned with deny rules
})
type AllowlistEntry = z.infer<typeof AllowlistEntry>

// In schema.ts — computed at load/merge time, not persisted in JSON
interface AllowlistLayer {
  source: string                // config file path, e.g. "/project/.opencode-security.json"
  entries: AllowlistEntry[]     // the allowlist entries from that config level
}

// In schema.ts — the runtime type returned by getSecurityConfig()
interface ResolvedSecurityConfig extends SecurityConfig {
  resolvedAllowlist: AllowlistLayer[]  // empty array = no allowlist restriction
}
```

### Files to Modify

| File | Change |
|------|--------|
| `packages/opencode/src/security/schema.ts` | Add `AllowlistEntry` Zod schema, `AllowlistLayer` interface, `ResolvedSecurityConfig` interface, `allowlist` field on `securityConfigSchema` |
| `packages/opencode/src/security/config.ts` | Change `currentConfig`/`emptyConfig`/`getSecurityConfig()` to `ResolvedSecurityConfig`; refactor `loadSecurityConfig()` to use `findSecurityConfigs()` + `mergeSecurityConfigs()`; build `AllowlistLayer[]` in merge; add empty-allowlist warning |
| `packages/opencode/src/security/access.ts` | Add per-layer allowlist check in `checkAccess()` after deny rules; add `matchAllowlistEntry()` helper reusing existing `matchPath()` logic |
| `packages/opencode/src/project/bootstrap.ts` | Verify bootstrap call works with updated `loadSecurityConfig()` (may need no change if signature stays the same) |
| `packages/opencode/src/cli/cmd/security/` | Update `security check` command to display per-layer allowlist status |
| `packages/opencode/test/security/` | Add allowlist unit tests |

### Config Example

```json
{
  "version": "1.0",
  "roles": [
    { "name": "developer", "level": 50 }
  ],
  "allowlist": [
    { "pattern": "src/**", "type": "directory" },
    { "pattern": "docs/**", "type": "directory" },
    { "pattern": "README.md", "type": "file" },
    { "pattern": "package.json", "type": "file" }
  ],
  "rules": [
    {
      "pattern": "src/auth/secrets/**",
      "type": "directory",
      "deniedOperations": ["read", "write", "llm"],
      "allowedRoles": ["admin"]
    }
  ]
}
```

In this example:
- LLM can access files under `src/`, `docs/`, `README.md`, and `package.json`
- LLM CANNOT access `src/auth/secrets/**` even though it's under `src/` (deny rule wins)
- LLM CANNOT access `test/**`, `.env`, or any file not matching the allowlist
- `read`/`write` operations on `test/**` still work normally (allowlist only affects `llm`)

### Evaluation Flow in `checkAccess()`

```
checkAccess(filePath, operation, role)
  │
  ├─ Resolve symlinks
  ├─ Check deny rules → if denied, return DENIED
  │
  ├─ Is operation "llm"?
  │   ├─ No → return ALLOWED (allowlist only affects llm)
  │   └─ Yes → Is resolvedAllowlist non-empty?
  │       ├─ No → return ALLOWED (backward compatible)
  │       └─ Yes → For each AllowlistLayer:
  │           │     Does file match >= 1 entry in this layer?
  │           ├─ All layers pass → return ALLOWED
  │           └─ Any layer fails → return DENIED with friendly message:
  │               "Access denied: LLM cannot access '<path>' — file is not
  │                in the allowlist. Rejected by <source>. To grant access,
  │                add a matching entry to the 'allowlist' in that config."
  │
  └─ return ALLOWED
```

### Multi-Level Config Merge Example

```
Parent config (/project/.opencode-security.json):
  allowlist:
    - { pattern: "src/**", type: "directory" }
    - { pattern: "docs/**", type: "directory" }

Child config (/project/packages/app/.opencode-security.json):
  allowlist:
    - { pattern: "src/components/**", type: "directory" }
    - { pattern: "test/**", type: "directory" }

resolvedAllowlist (computed):
  Layer 0: { source: "/project/.opencode-security.json",
             entries: [src/**, docs/**] }
  Layer 1: { source: "/project/packages/app/.opencode-security.json",
             entries: [src/components/**, test/**] }

Runtime evaluation:
  "src/components/Button.tsx"  → Layer 0 ✓ (src/**) → Layer 1 ✓ (src/components/**) → ALLOWED
  "test/foo.test.ts"           → Layer 0 ✗ (no match) → DENIED (parent rejects)
  "docs/api.md"                → Layer 0 ✓ (docs/**) → Layer 1 ✗ (no match) → DENIED (child rejects)
  "src/index.ts"               → Layer 0 ✓ (src/**) → Layer 1 ✗ (no match) → DENIED (child rejects)
```

### Bootstrap Flow Change

```
Before (current):
  InstanceBootstrap()
    → SecurityConfig.loadSecurityConfig(Instance.directory)
      → loads single .opencode-security.json from project root

After (this feature):
  InstanceBootstrap()
    → SecurityConfig.loadSecurityConfig(Instance.directory)
      → findSecurityConfigs(projectRoot)          // discover all configs up to git root
      → mergeSecurityConfigs(configs)              // merge rules, roles, MCP, etc.
      → build resolvedAllowlist from each config   // compute AllowlistLayer[]
      → store as ResolvedSecurityConfig            // runtime type with layers
```

### Performance Considerations

- Allowlist check adds one `minimatch` pass per entry per layer per `llm` operation — should be negligible for typical allowlist sizes (< 50 entries per layer, 1-3 layers)
- No filesystem I/O needed for allowlist matching — purely pattern-based
- Early exit: if any layer rejects, skip remaining layers

## Success Metrics

- All existing security tests continue to pass (no regression)
- New allowlist tests cover all acceptance criteria
- Typecheck passes across the monorepo
- Configs without `allowlist` behave identically to before (verified by existing tests)
- Multi-level config loading works correctly in bootstrap

## Open Questions

- Should the allowlist support comments or descriptions per entry for documentation purposes? (Out of scope for v1)

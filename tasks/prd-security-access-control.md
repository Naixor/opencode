# PRD: Security Access Control

## Introduction

OpenCode needs a security access control system to protect confidential directories, files, and code segments in collaborative development environments. This feature prevents unauthorized access, reading, writing, and transmission of protected content to LLMs. It supports role-based access control, allowing different team members to have different permission levels based on their security clearance.

## Goals

- Prevent unauthorized reading of protected content (directories, files, code segments)
- Prevent unauthorized writing/editing of protected content
- Block protected content from being sent to LLM providers in any request
- Support granular protection at directory, file, and code segment levels
- Implement role-based access control for different user permission levels
- Provide clear error messages when access is denied
- Log all violation attempts for security auditing

## User Stories

### US-001: Create security configuration schema

**Description:** As a developer, I need a well-defined configuration schema so that security rules can be consistently parsed and validated.

**Acceptance Criteria:**

- [ ] Define Zod schema for `.opencode-security.json` configuration
- [ ] Schema supports `roles` array with role definitions (name, level for hierarchy)
- [ ] Schema supports `rules` array for directory/file protection rules
- [ ] Each rule specifies: `pattern` (glob), `type` (directory/file), `deniedOperations` (read/write/llm), `allowedRoles`
- [ ] Schema supports `segments.markers` for comment-based segment protection
- [ ] Schema supports `segments.ast` for AST-based segment protection (languages, nodeTypes, namePattern)
- [ ] Schema supports `logging` configuration (path, level, maxSizeMB, retentionDays)
- [ ] Schema supports `authentication` configuration (publicKey, revokedTokens)
- [ ] Schema supports `mcp` configuration (defaultPolicy, per-server policies)
- [ ] Typecheck passes

### US-002: Implement configuration loader

**Description:** As a developer, I need to load and validate security configuration so that protection rules are available at runtime.

**Acceptance Criteria:**

- [ ] Load `.opencode-security.json` from project root on startup
- [ ] Validate configuration against schema
- [ ] **Fail-open behavior:** If config is malformed, log clear warning and allow all access (do not block operations)
- [ ] Provide default empty config if file doesn't exist
- [ ] Hot-reload configuration when file changes (re-validate on reload)
- [ ] Export configuration state for other modules to consume
- [ ] Typecheck passes

### US-003: Implement role authentication

**Description:** As a security admin, I want roles to be cryptographically verified so that users cannot falsely claim higher privileges.

**Acceptance Criteria:**

- [ ] Support role verification via signed token file (`.opencode-role.token`)
- [ ] Token contains: role name, expiration date, project scope, signature
- [ ] Verify token signature against public key in security config
- [ ] Reject expired or invalid tokens (fall back to lowest role)
- [ ] Support CLI command `opencode security issue-token --role <role>` for admins to generate tokens
- [ ] Log current verified role on startup
- [ ] Typecheck passes

### US-004: Implement path-based access checker

**Description:** As a developer, I need a centralized access checking function so that all tools can verify permissions consistently.

**Acceptance Criteria:**

- [ ] Function `checkAccess(path, operation, role)` returns `{ allowed: boolean, reason?: string }`
- [ ] Supports operations: `read`, `write`, `llm`
- [ ] Matches paths against directory and file patterns using glob matching
- [ ] Respects role hierarchy (higher roles can access lower-level protected content)
- [ ] Returns clear denial reason for logging and error messages
- [ ] Typecheck passes

### US-005: Implement marker-based segment detector

**Description:** As a developer, I need to detect protected code segments via comment markers so that teams can easily mark sensitive code blocks.

**Acceptance Criteria:**

- [ ] Parse marker rules from configuration (e.g., `// @secure-start` / `// @secure-end`)
- [ ] Support language-specific comment styles (JS/TS: `//`, Python: `#`, HTML: `<!--`, etc.)
- [ ] Function `findMarkerSegments(filePath, content)` returns array of `{ start, end, rule }` ranges
- [ ] Support multiple marker patterns per file
- [ ] Handle nested markers correctly (inner markers inherit outer protection)
- [ ] Typecheck passes

### US-005b: Implement AST-based segment detector

**Description:** As a developer, I need to detect protected code segments via AST analysis so that functions and classes can be protected by name pattern.

**Acceptance Criteria:**

- [ ] Support AST parsing for common languages (TypeScript, JavaScript, Python, Go, Rust)
- [ ] Parse function/class name patterns from configuration (regex patterns)
- [ ] Function `findASTSegments(filePath, content)` returns array of `{ start, end, rule, nodeType }` ranges
- [ ] Detect function declarations, arrow functions, class methods, and class definitions
- [ ] Handle exported and non-exported declarations
- [ ] Graceful fallback to marker-only mode if AST parsing fails for a language
- [ ] Typecheck passes

### US-006: Integrate access control with Read tool

**Description:** As a user, I want the Read tool to respect security rules so that protected content cannot be read.

**Acceptance Criteria:**

- [ ] Check file path against access rules before reading
- [ ] If file is fully protected, return access denied error
- [ ] If file contains protected segments, redact those segments with placeholder text `[REDACTED: Security Protected]`
- [ ] Log access attempts (both allowed and denied)
- [ ] Typecheck passes

### US-007: Integrate access control with Write/Edit tools

**Description:** As a user, I want Write and Edit tools to respect security rules so that protected content cannot be modified.

**Acceptance Criteria:**

- [ ] Check file path against access rules before writing/editing
- [ ] If file or target segment is protected, return access denied error
- [ ] Prevent edits that would modify protected segments within files
- [ ] Log write/edit attempts (both allowed and denied)
- [ ] Typecheck passes

### US-008: Integrate access control with Grep/Glob tools

**Description:** As a user, I want search tools to respect security rules so that protected content is not exposed in search results.

**Acceptance Criteria:**

- [ ] Filter out protected files/directories from Glob results
- [ ] Filter out matches in protected files from Grep results
- [ ] Redact matches within protected segments (show file/line but not content)
- [ ] Log search attempts that touched protected content
- [ ] Typecheck passes

### US-009: Integrate access control with Bash tool

**Description:** As a user, I want the Bash tool to respect security rules so that shell commands cannot bypass protection.

**Acceptance Criteria:**

- [ ] Detect file access patterns in common commands (cat, less, head, tail, vim, etc.)
- [ ] Block commands that would read protected files
- [ ] Block commands that would write to protected files
- [ ] Block commands that would expose protected content (grep, find with -exec, etc.)
- [ ] Return clear error message explaining which protection rule was triggered
- [ ] Typecheck passes

### US-010: Implement LLM request interceptor

**Description:** As a security admin, I want all LLM requests to be scanned so that protected content never reaches external providers.

**Acceptance Criteria:**

- [ ] Create middleware that intercepts all outgoing LLM requests
- [ ] Scan request content (messages, context, tool results) for protected content patterns
- [ ] If protected content detected, either redact it or block the request entirely
- [ ] Support configurable behavior: `redact` vs `block` per rule
- [ ] Log all interceptions with details (what was caught, which rule)
- [ ] Typecheck passes

### US-011: Implement audit logging

**Description:** As a security admin, I want all access attempts logged so that I can review security events.

**Acceptance Criteria:**

- [ ] Log location configurable via `logging.path` in security config (default: `.opencode-security.log` in project root)
- [ ] Support absolute paths or relative paths (relative to project root)
- [ ] Log format: timestamp, user/role, operation, target path/content, result (allowed/denied), rule triggered
- [ ] Support log rotation (configurable max size/age)
- [ ] Support configurable log level (verbose: all access, normal: denials only)
- [ ] Sensitive content in logs should be hashed, not stored in plain text
- [ ] Typecheck passes

### US-012: Add security status to TUI

**Description:** As a user, I want to see my security role and status in the TUI so that I understand my access level.

**Acceptance Criteria:**

- [ ] Display current role in status bar or header
- [ ] Show indicator when security config is active
- [ ] Provide command to view current security rules (filtered by role)
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-013: Add security CLI commands

**Description:** As a user, I want CLI commands to manage and inspect security configuration.

**Acceptance Criteria:**

- [ ] `opencode security status` - show current role, active configs (merged), and rules count
- [ ] `opencode security check <path>` - test if a path is accessible (shows inheritance chain)
- [ ] `opencode security logs` - view recent security audit logs
- [ ] `opencode security init` - create template `.opencode-security.json`
- [ ] `opencode security init-keys [--passphrase]` - generate admin key pair for token signing (optional passphrase protection)
- [ ] `opencode security issue-token --role <role> --expires <days>` - generate signed role token
- [ ] `opencode security verify-token <token>` - verify and display token claims
- [ ] `opencode security revoke-token <token-id>` - add token to revocation list
- [ ] Typecheck passes

### US-014: Implement symbolic link protection

**Description:** As a security admin, I want symbolic links to protected content to be handled safely so that users cannot bypass protection via symlinks.

**Acceptance Criteria:**

- [ ] Resolve symbolic link targets before checking access rules
- [ ] If symlink target is protected, deny access to the symlink
- [ ] Symlinks remain visible in directory listings (existence is not hidden)
- [ ] Error message clearly states "symlink target is protected" (not just "access denied")
- [ ] Handle chains of symlinks (resolve fully before checking)
- [ ] Typecheck passes

### US-015: Implement rule inheritance

**Description:** As a security admin, I want protection rules to be inherited by subdirectories so that I don't need to specify rules for every nested path.

**Acceptance Criteria:**

- [ ] Child paths automatically inherit parent directory protection rules
- [ ] More restrictive child rules take precedence over inherited rules
- [ ] Less restrictive child rules do NOT override parent restrictions
- [ ] Inheritance chain is visible in `opencode security check <path>` output
- [ ] Typecheck passes

### US-016: Integrate security with MCP servers

**Description:** As a security admin, I want to configure whether MCP server tools are subject to security rules so that external tools don't bypass protection.

**Acceptance Criteria:**

- [ ] Add `mcp` section to security config with per-server settings
- [ ] Each MCP server can be: `enforced` (full security rules), `trusted` (exempt), or `blocked` (no access)
- [ ] Default behavior for unlisted MCP servers is configurable (`defaultMcpPolicy`)
- [ ] MCP tool calls that access protected content are blocked/redacted based on policy
- [ ] Log MCP access attempts with server name in audit log
- [ ] Typecheck passes

### US-017: Handle nested project configurations

**Description:** As a developer working in a monorepo, I want nested projects to have their own security configs that merge with parent configs.

**Acceptance Criteria:**

- [ ] Detect `.opencode-security.json` files in parent directories up to git root
- [ ] Merge multiple configs: nested configs can only ADD restrictions, not remove them
- [ ] Role definitions must match across configs (conflict = error)
- [ ] `opencode security status` shows all active config files and merge result
- [ ] Clear error message if configs conflict in incompatible ways
- [ ] Typecheck passes

### US-018: Implement token generation for role authentication

**Description:** As a security admin, I want to generate signed role tokens so that team members can prove their access level.

**Acceptance Criteria:**

- [ ] `opencode security issue-token --role <role> --expires <days>` generates signed token
- [ ] Token is JWT format with claims: role, project, exp, iat, jti
- [ ] Signing uses private key from admin's key file
- [ ] Support optional passphrase protection for private key (`--passphrase` flag or prompt)
- [ ] Public key stored in security config for verification
- [ ] Support token revocation via `revokedTokens` list in config (by token ID)
- [ ] Typecheck passes

## Functional Requirements

- FR-1: Load security configuration from `.opencode-security.json` in project root
- FR-2: Support three protection levels: directory, file, and code segment
- FR-3: Support both marker-based (`// @secure-start`) and AST-based (function/class name patterns) segment detection
- FR-4: Support role-based access control with configurable role hierarchy
- FR-5: Block read operations on protected content (return error or redact segments)
- FR-6: Block write/edit operations on protected content
- FR-7: Block protected content from appearing in search results (Grep/Glob)
- FR-8: Detect and block shell commands that would access protected content
- FR-9: Intercept all LLM requests and scan for protected content
- FR-10: Either redact or block LLM requests containing protected content (configurable)
- FR-11: Log all security events to audit log with timestamps and details
- FR-12: Display security status and current role in TUI
- FR-13: Provide CLI commands for security management
- FR-14: Protection rules are inheritable (subdirectories/files inherit parent directory rules)
- FR-15: Symbolic links to protected content are visible but content is not accessible (link exists, but following it to protected content is denied)
- FR-16: Role authentication via signed JWT tokens (not honor system)
- FR-17: MCP server security policy configurable per server (enforced/trusted/blocked)
- FR-18: Nested project configs merge with parent configs (more restrictive only)
- FR-19: Audit log location is configurable in security config

## Non-Goals

- No encryption of protected files at rest (this is access control, not encryption)
- No integration with external identity providers (LDAP, SSO, etc.)
- No network-level protection (firewall rules, etc.)
- No protection against users with direct file system access outside OpenCode
- No real-time alerting or notification system for violations
- No web UI for security configuration management
- No "break glass" emergency bypass mechanism (all access must follow configured rules)
- No git history protection (only current working tree is protected, not `git log`/`git show` of past commits)
- No dedicated dry-run mode (use `opencode security check <path>` to test individual paths)

## Technical Considerations

### Configuration File Structure

```json
{
  "version": "1.0",
  "roles": [
    { "name": "admin", "level": 100 },
    { "name": "developer", "level": 50 },
    { "name": "viewer", "level": 10 }
  ],
  "rules": [
    {
      "pattern": "secrets/**",
      "type": "directory",
      "deniedOperations": ["read", "write", "llm"],
      "allowedRoles": ["admin"]
    },
    {
      "pattern": "**/.env*",
      "type": "file",
      "deniedOperations": ["read", "write", "llm"],
      "allowedRoles": ["admin", "developer"]
    },
    {
      "pattern": "src/auth/keys.ts",
      "type": "file",
      "deniedOperations": ["llm"],
      "allowedRoles": ["admin"]
    }
  ],
  "segments": {
    "markers": [
      {
        "start": "// @secure-start",
        "end": "// @secure-end",
        "deniedOperations": ["read", "write", "llm"],
        "allowedRoles": ["admin"]
      },
      {
        "start": "# @secure-start",
        "end": "# @secure-end",
        "deniedOperations": ["read", "write", "llm"],
        "allowedRoles": ["admin"]
      }
    ],
    "ast": [
      {
        "languages": ["typescript", "javascript"],
        "nodeTypes": ["function", "class", "method"],
        "namePattern": "^(encrypt|decrypt|sign|verify).*",
        "deniedOperations": ["llm"],
        "allowedRoles": ["admin", "developer"]
      },
      {
        "languages": ["python"],
        "nodeTypes": ["function", "class"],
        "namePattern": "^_private_.*",
        "deniedOperations": ["read", "write", "llm"],
        "allowedRoles": ["admin"]
      }
    ]
  },
  "logging": {
    "path": ".opencode-security.log",
    "level": "normal",
    "maxSizeMB": 10,
    "retentionDays": 30
  },
  "authentication": {
    "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    "revokedTokens": []
  },
  "mcp": {
    "defaultPolicy": "enforced",
    "servers": {
      "filesystem": "enforced",
      "github": "trusted",
      "untrusted-server": "blocked"
    }
  }
}
```

### Architecture Integration Points

- **Tool Layer:** Wrap Read, Write, Edit, Grep, Glob, Bash tools with access check middleware
- **Provider Layer:** Add request interceptor in `provider/` before sending to LLM
- **Bus Layer:** Emit security events for audit logging
- **CLI Layer:** Add new `security` command group in `cli/cmd/`

### Performance Considerations

- Cache compiled glob patterns and regex for rule matching
- Lazy-load security config only when first access check is needed
- Use efficient string scanning for segment detection (avoid re-parsing entire files)

### Security Considerations

- Configuration file itself should not contain sensitive data (only patterns)
- Audit logs should hash or truncate actual content to prevent log-based leaks
- Role verification should not be bypassable via tool arguments

### Symbolic Link Handling

- Symbolic links to protected content are visible in directory listings
- Following a symlink that resolves to protected content is denied
- The symlink target path is resolved and checked against protection rules
- Error message indicates the symlink exists but target is protected

### Rule Inheritance

- Protection rules are inheritable by default
- If a directory is protected, all files and subdirectories within inherit that protection
- Child rules can be more restrictive but not less restrictive than parent rules
- Explicit rules on child paths take precedence over inherited rules (if more restrictive)

### Error Handling Strategy

- **Fail-open on config errors:** Malformed configuration logs a warning but does not block operations
- This prevents accidental lockouts due to config typos
- Security admins should monitor logs for config validation warnings

### Role Token Format

- JWT (JSON Web Token) format for portability and standard tooling
- Claims: `role`, `project` (git remote or path hash), `exp` (expiration), `iat` (issued at), `jti` (token ID for revocation)
- Algorithm: RS256 (RSA with SHA-256) for asymmetric verification
- Token file location: `.opencode-role.token` in project root or `~/.config/opencode/role.token` for global
- Private key passphrase: Optional, prompted during `init-keys` and `issue-token` if key is encrypted

### Nested Config Merging

- Walk up directory tree from accessed file to git root, collecting `.opencode-security.json` files
- Merge rules: union of all rules (more files = more restrictions)
- Role definitions must be identical across all configs (different levels = error)
- `segments` rules are merged (union of markers and AST patterns)
- `mcp` policies: most restrictive wins (blocked > enforced > trusted)

## Success Metrics

- Protected content is never sent to LLM providers (verified via request logging)
- All access attempts to protected content are logged
- No performance regression >5% for normal (unprotected) file operations
- Security configuration validation catches 100% of malformed configs
- Clear, actionable error messages for all denial scenarios

## Design Decisions

The following design decisions have been made:

| Decision                 | Choice                          | Rationale                                                                                  |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------ |
| Segment detection method | Both AST-based and marker-based | AST provides precise function/class protection; markers are language-agnostic and explicit |
| Config error handling    | Fail-open with warning          | Prevents accidental lockouts; admins should monitor logs                                   |
| Break glass mechanism    | Not implemented                 | All access must follow rules; no bypass to prevent abuse                                   |
| Symbolic link handling   | Link visible, content protected | Users can see symlinks exist but cannot follow to protected targets                        |
| Rule inheritance         | Yes, inheritable                | Subdirectories inherit parent protection; simplifies configuration                         |
| Role authentication      | Signed JWT tokens               | Cryptographic verification prevents role spoofing; tokens can expire and be revoked        |
| MCP server security      | Configurable per server         | Flexibility to trust some MCP servers while enforcing rules on others                      |
| Audit log location       | Configurable in config          | Teams can centralize logs or keep them per-project as needed                               |
| Nested project configs   | Merge (more restrictive)        | Monorepo support; child projects can add restrictions but not remove parent rules          |
| Dry-run mode             | Not needed                      | Use `opencode security check <path>` to test individual paths instead                      |
| Git history protection   | Out of scope                    | Only protect current working tree; past commits not blocked                                |
| Key passphrase           | Optional                        | Balance between security and convenience; teams can choose their policy                    |

## Open Questions

None - all design questions have been resolved.

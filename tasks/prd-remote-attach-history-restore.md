# PRD: Remote Attach Session History Restoration

## Introduction

When a user performs `opencode attach <url> --session <id>` (or `--continue`) to connect to a remote instance as an observer, the TUI only displays a partial subset of the session's message history. Early messages are missing, making it impossible to review the full conversation context. This feature ensures that remote-attached sessions display complete history identical to local sessions, with pagination support for large sessions.

## Goals

- Remote attach (observer or owner) displays the same complete message history as a local session
- Support lazy-loading of older messages for sessions with >100 messages
- Eliminate the race condition where SSE events prevent full history sync
- Both observer and owner roles can view the full session history

## Root Cause Analysis

Three interacting bugs cause incomplete history on remote attach:

1. **SSE race condition skips full sync**: The observer's SSE connection starts receiving `message.updated` events immediately. When the session component mounts, the guard `if (!sync.data.message[sessionId]?.length)` sees messages already exist (from SSE) and skips calling `sync.session.sync()`. The observer only sees messages that arrived via SSE after connection — not the full history.

2. **Hard limit of 100**: `sync.session.sync()` fetches `sdk.client.session.messages({ sessionID, limit: 100 })`. Sessions with more than 100 messages permanently lose early history.

3. **Rolling window eviction**: The `message.updated` event handler evicts the oldest message when the in-memory array exceeds 100, preventing accumulation beyond that threshold.

## User Stories

### US-001: Fix SSE race condition — always perform full sync on session entry
**Description:** As an observer attaching to a remote session, I want the full session history to load when I enter the session view, even if SSE events have already delivered some recent messages.

**Acceptance Criteria:**
- [ ] `sync.session.sync(sessionID)` always runs when navigating to a session, regardless of whether `store.message[sessionID]` already has entries from SSE events
- [ ] The sync merges fetched history with any SSE-delivered messages (no duplicates, no gaps)
- [ ] `fullSyncedSessions` flag is only set after a successful full sync, not after partial SSE population
- [ ] Existing local session navigation continues to work correctly (no regression)
- [ ] Typecheck passes

### US-002: Remove hard 100-message cap on initial sync
**Description:** As a user viewing any session (local or remote), I want to see all messages in the session history, not just the latest 100.

**Acceptance Criteria:**
- [ ] `sync.session.sync()` fetches all messages for the session (remove `limit: 100` or use a sufficiently large default)
- [ ] Server endpoint `GET /session/:sessionID/message` supports unlimited fetch when no limit is specified
- [ ] Performance remains acceptable for sessions with up to 500 messages (typical upper bound)
- [ ] Typecheck passes

### US-003: Add pagination / lazy-load for very large sessions
**Description:** As a user viewing a session with hundreds of messages, I want to load older messages on demand so that initial load is fast but I can still access the full history.

**Acceptance Criteria:**
- [ ] Server endpoint supports cursor-based or offset-based pagination (`before` parameter: load messages before a given message ID)
- [ ] TUI detects when the user scrolls to the top of the message list and triggers a fetch for older messages
- [ ] A loading indicator appears while older messages are being fetched
- [ ] Fetched older messages are prepended to the existing list without disrupting scroll position
- [ ] Typecheck passes

### US-004: Remove rolling window eviction for active sessions
**Description:** As an observer watching an active session, I want new messages to accumulate without evicting old ones, so I can review the full conversation.

**Acceptance Criteria:**
- [ ] The `message.updated` handler no longer evicts the oldest message when count exceeds 100
- [ ] Memory usage remains bounded through the pagination system (only loaded messages are in memory)
- [ ] If pagination is not yet implemented, raise the eviction threshold to a safe upper bound (e.g., 500)
- [ ] Typecheck passes

### US-005: Fork preserves full history for remote-attached sessions
**Description:** As a user who attaches remotely and then forks the session, I want the forked session to contain the complete message history, not just the subset visible in the TUI.

**Acceptance Criteria:**
- [ ] `Session.fork()` on the server always copies all messages regardless of client-side visibility
- [ ] Verify fork works correctly when initiated by an observer-turned-owner
- [ ] Typecheck passes

## Functional Requirements

- FR-1: `sync.session.sync()` must execute unconditionally when navigating to a session route, using fetched data as the authoritative source and merging with any SSE-delivered messages
- FR-2: The session messages API (`GET /session/:sessionID/message`) must support a `before` query parameter (message ID) for cursor-based pagination
- FR-3: When `limit` is omitted in the messages API, return all messages (current behavior in `Session.messages()`)
- FR-4: The TUI must detect scroll-to-top and trigger `sdk.client.session.messages({ sessionID, limit: N, before: oldestMessageID })` to load earlier messages
- FR-5: The `message.updated` event handler must not evict messages that were loaded via full sync or pagination
- FR-6: `Session.fork()` must always operate on the full server-side message set, not the client-side subset
- FR-7: Both `owner` and `observer` roles must have read access to full session history via the messages API

## Non-Goals

- No changes to the ownership/takeover model (observer → owner promotion is out of scope)
- No message search or filtering within session history
- No persistence of scroll position across reconnects
- No streaming of historical messages (bulk fetch is sufficient)
- No changes to the compaction system — compacted messages remain compacted

## Technical Considerations

- **Merge strategy**: When `sync.session.sync()` runs after SSE events have already populated some messages, use message ID-based deduplication. The fetched set is authoritative for ordering; SSE-delivered messages that are newer than the fetched set should be appended.
- **Scroll detection**: The TUI uses ink-based rendering. Scroll-to-top detection may require tracking the viewport offset in the message list component and triggering fetch when offset reaches 0.
- **Memory budget**: For sessions with 500+ messages, each message with parts can consume significant memory. Consider a maximum in-memory window (e.g., 500 messages) with eviction of the oldest when paginating forward, but never evicting during backward (history) pagination.
- **`fullSyncedSessions` semantics**: This flag should mean "a full sync from the server has completed," not "some messages exist in the store." Reset it on reconnect so that a fresh sync occurs.
- **Server-side cursor**: `MessageV2.stream()` already loads from SQLite ordered by ID. Adding a `WHERE id < :before` clause is straightforward.

## Success Metrics

- Remote-attached session shows identical message count to local session (0 missing messages)
- Initial session load completes in <2s for sessions with ≤200 messages
- Pagination loads a batch of 50 older messages in <500ms
- No duplicate messages appear in the TUI after sync + SSE merge

## Open Questions

- Should there be a configurable max message retention per session in TUI memory, or is 500 sufficient?
- Should the pagination batch size (e.g., 50) be configurable via `opencode.json`?
- When compaction removes old messages from the DB, should the TUI show a "history truncated" indicator?

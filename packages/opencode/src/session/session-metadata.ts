// In-memory session metadata store for hook context
// Used to pass swarm_id, task_id, discussion_channel etc. to hooks

export namespace SessionMetadata {
  const store = new Map<string, Record<string, unknown>>()

  export function set(sessionID: string, key: string, value: unknown) {
    if (!store.has(sessionID)) store.set(sessionID, {})
    store.get(sessionID)![key] = value
  }

  export function get(sessionID: string): Record<string, unknown> | undefined {
    return store.get(sessionID)
  }

  export function remove(sessionID: string) {
    store.delete(sessionID)
  }
}

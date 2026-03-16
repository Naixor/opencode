/** Simple owner state module with no transitive top-level await dependencies. */

let owner: string | null = null

/** Get the current owner client ID. */
export function getOwner(): string | null {
  return owner
}

/** Set the current owner client ID. */
export function setOwnerState(id: string | null) {
  owner = id
}

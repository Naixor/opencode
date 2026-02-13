export namespace BuiltIn {
  const features = new Set<string>([
    "ast-grep",
    "lsp-rename",
    "look-at",
    "context-injection",
    "todo-continuation",
    "comment-checker",
    "session-recovery",
  ])

  export function has(feature: string): boolean {
    return features.has(feature)
  }
}

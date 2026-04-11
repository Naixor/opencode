export function stateTone(value: string) {
  if (value === "active") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
  if (value === "blocked") return "border-amber-500/30 bg-amber-500/10 text-amber-200"
  if (value === "paused") return "border-zinc-500/30 bg-zinc-500/10 text-zinc-300"
  if (value === "failed") return "border-red-500/30 bg-red-500/10 text-red-300"
  if (value === "completed") return "border-sky-500/30 bg-sky-500/10 text-sky-200"
  if (value === "deleted") return "border-zinc-500/30 bg-zinc-500/10 text-zinc-300"
  if (value === "archived") return "border-zinc-500/30 bg-zinc-500/10 text-zinc-300"
  if (value === "stopped") return "border-orange-500/30 bg-orange-500/10 text-orange-200"
  return "border-border-weak-base bg-surface-base text-text-base"
}

export function consensusTone(value: string) {
  if (value === "consensus") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
  if (value === "partial_consensus") return "border-sky-500/30 bg-sky-500/10 text-sky-200"
  if (value === "no_consensus") return "border-red-500/30 bg-red-500/10 text-red-300"
  return "border-border-weak-base bg-surface-base text-text-base"
}

export function taskTone(value: string, blocked: boolean) {
  if (value === "failed") return "text-red-300"
  if (blocked) return "text-amber-200"
  if (value === "completed") return "text-emerald-300"
  if (value === "in_progress" || value === "verifying") return "text-sky-200"
  if (value === "ready") return "text-cyan-200"
  return "text-text-base"
}

export function ago(value?: number | null, now = Date.now()) {
  if (!value) return "-"
  const diff = Math.max(0, now - value)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

export function filterTasks<T extends { assignee: string | null; status: string; type: string }>(
  list: T[],
  input: { assignee: string; status: string; type: string },
) {
  return list.filter((item) => {
    if (input.assignee && item.assignee !== input.assignee) return false
    if (input.status && item.status !== input.status) return false
    if (input.type && item.type !== input.type) return false
    return true
  })
}

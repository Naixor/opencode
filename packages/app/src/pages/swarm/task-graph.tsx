import { For, createMemo } from "solid-js"

const colors: Record<string, string> = {
  completed: "bg-green-500/20 border-green-500 text-green-400",
  in_progress: "bg-blue-500/20 border-blue-500 text-blue-400",
  pending: "bg-gray-500/20 border-gray-600 text-gray-400",
  failed: "bg-red-500/20 border-red-500 text-red-400",
  cancelled: "bg-gray-700/20 border-gray-700 text-gray-500",
}

interface Task {
  id: string
  subject: string
  status: string
  assignee?: string
  blockedBy: string[]
}

export function TaskGraph(props: { tasks: Task[] }) {
  const layers = createMemo(() => {
    const tasks = props.tasks
    const done = new Set<string>()
    const result: Task[][] = []
    let remaining = [...tasks]
    while (remaining.length > 0) {
      const layer = remaining.filter((t) => t.blockedBy.every((dep) => done.has(dep)))
      if (layer.length === 0) {
        result.push(remaining)
        break
      }
      result.push(layer)
      for (const t of layer) done.add(t.id)
      remaining = remaining.filter((t) => !done.has(t.id))
    }
    return result
  })

  return (
    <div class="flex flex-col gap-3 p-3 rounded-lg bg-gray-900 border border-gray-800 overflow-auto">
      <h3 class="text-xs font-semibold text-gray-400 uppercase">Task Graph</h3>
      <For each={layers()}>
        {(layer) => (
          <div class="flex gap-2 flex-wrap">
            <For each={layer}>
              {(task) => (
                <div class={`px-3 py-2 rounded border text-xs ${colors[task.status] ?? colors.pending}`}>
                  <div class="font-medium truncate max-w-[180px]">{task.subject}</div>
                  {task.assignee && <div class="text-[10px] opacity-70">{task.assignee}</div>}
                </div>
              )}
            </For>
          </div>
        )}
      </For>
      {props.tasks.length === 0 && <div class="text-xs text-gray-500">No tasks yet</div>}
    </div>
  )
}

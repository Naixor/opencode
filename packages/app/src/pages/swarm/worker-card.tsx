import { A } from "@solidjs/router"

const colors: Record<string, string> = {
  active: "border-blue-500 bg-blue-500/10",
  done: "border-green-500 bg-green-500/10",
  idle: "border-gray-500 bg-gray-500/10",
  failed: "border-red-500 bg-red-500/10",
}

const dots: Record<string, string> = {
  active: "bg-blue-400",
  done: "bg-green-400",
  idle: "bg-gray-400",
  failed: "bg-red-400",
}

export function WorkerCard(props: { worker: { session_id: string; agent: string; task_id: string; status: string } }) {
  const w = () => props.worker
  return (
    <A
      href={`/session/${w().session_id}`}
      class={`flex flex-col gap-1 p-3 rounded-lg border min-w-[160px] ${colors[w().status] ?? colors.idle}`}
    >
      <div class="flex items-center gap-2">
        <div class={`w-2 h-2 rounded-full ${dots[w().status] ?? dots.idle}`} />
        <span class="text-sm font-medium">{w().agent}</span>
      </div>
      <span class="text-xs text-gray-400 truncate">{w().task_id || "No task"}</span>
      <span class="text-[10px] text-gray-500">{w().status}</span>
    </A>
  )
}

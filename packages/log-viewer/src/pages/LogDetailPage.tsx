import { useParams } from "react-router"

export function LogDetailPage() {
  const { id } = useParams<{ id: string }>()
  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">Log Detail</h2>
      <p className="text-zinc-400">
        Viewing log <code className="text-zinc-300 bg-zinc-800 px-1.5 py-0.5 rounded text-sm">{id}</code>
      </p>
    </div>
  )
}

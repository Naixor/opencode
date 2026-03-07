import { useState, useEffect, useCallback } from "react"

interface Suggestion {
  category: string
  description: string
  impact: {
    tokens?: number
    cost?: number
  }
  recommended_action: string
}

interface LargeToolOutput {
  tool_name: string
  output_bytes: number
  llm_log_id: string
}

interface AnalyzeResult {
  suggestions: Suggestion[]
  top_large_tool_outputs: LargeToolOutput[]
  cache_hit_rate: number
  reasoning_token_ratio: number
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n}B`
}

function formatCost(microdollars: number): string {
  return `$${(microdollars / 1_000_000).toFixed(4)}`
}

const CATEGORY_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  oversized_tool_output: { label: "Oversized Tool Output", color: "text-red-400 bg-red-400/10 border-red-400/20", icon: "!" },
  cache_hit_rate: { label: "Low Cache Hit Rate", color: "text-amber-400 bg-amber-400/10 border-amber-400/20", icon: "%" },
  repeated_context: { label: "Repeated Context", color: "text-orange-400 bg-orange-400/10 border-orange-400/20", icon: "R" },
  high_cost_model: { label: "High-Cost Model Usage", color: "text-purple-400 bg-purple-400/10 border-purple-400/20", icon: "$" },
  reasoning_token_ratio: { label: "High Reasoning Token Ratio", color: "text-blue-400 bg-blue-400/10 border-blue-400/20", icon: "T" },
}

function getCategoryConfig(category: string) {
  return CATEGORY_CONFIG[category] ?? { label: category, color: "text-zinc-400 bg-zinc-400/10 border-zinc-400/20", icon: "?" }
}

export function AnalyzePage() {
  const [data, setData] = useState<AnalyzeResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/logs/analyze")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = await res.json()
      setData(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleExport = () => {
    if (!data) return
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `llm-log-analysis-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-zinc-400">Loading analysis...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-red-400">Error: {error}</div>
      </div>
    )
  }

  if (!data) return null

  const hasSuggestions = data.suggestions.length > 0
  const hasToolOutputs = data.top_large_tool_outputs.length > 0

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Optimization Suggestions</h2>
        <button
          onClick={handleExport}
          className="px-3 py-1.5 text-sm bg-zinc-700 hover:bg-zinc-600 rounded border border-zinc-600 transition-colors"
        >
          Export JSON
        </button>
      </div>

      {/* Summary metrics */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-zinc-800 rounded-lg border border-zinc-700 p-4">
          <div className="text-sm text-zinc-400">Cache Hit Rate</div>
          <div className="text-2xl font-bold mt-1 tabular-nums">
            {(data.cache_hit_rate * 100).toFixed(1)}%
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            {data.cache_hit_rate >= 0.3 ? "Good" : "Below 30% threshold"}
          </div>
        </div>
        <div className="bg-zinc-800 rounded-lg border border-zinc-700 p-4">
          <div className="text-sm text-zinc-400">Reasoning Token Ratio</div>
          <div className="text-2xl font-bold mt-1 tabular-nums">
            {(data.reasoning_token_ratio * 100).toFixed(1)}%
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            {data.reasoning_token_ratio <= 0.5 ? "Normal" : "Above 50% threshold"}
          </div>
        </div>
        <div className="bg-zinc-800 rounded-lg border border-zinc-700 p-4">
          <div className="text-sm text-zinc-400">Issues Found</div>
          <div className="text-2xl font-bold mt-1 tabular-nums">{data.suggestions.length}</div>
          <div className="text-xs text-zinc-500 mt-1">
            {hasSuggestions ? "Action recommended" : "No issues detected"}
          </div>
        </div>
      </div>

      {/* Suggestions */}
      <div>
        <h3 className="text-md font-semibold mb-3">Suggestions</h3>
        {!hasSuggestions ? (
          <div className="bg-zinc-800 rounded-lg border border-zinc-700 p-6 text-center text-zinc-400">
            No optimization suggestions at this time. Everything looks good!
          </div>
        ) : (
          <div className="space-y-3">
            {data.suggestions.map((s, i) => {
              const config = getCategoryConfig(s.category)
              return (
                <div key={i} className={`rounded-lg border p-4 ${config.color}`}>
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full border flex items-center justify-center font-bold text-sm">
                      {config.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-sm">{config.label}</span>
                        {s.impact.tokens != null && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-black/20">
                            ~{formatTokens(s.impact.tokens)} tokens
                          </span>
                        )}
                        {s.impact.cost != null && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-black/20">
                            ~{formatCost(s.impact.cost)}
                          </span>
                        )}
                      </div>
                      <p className="text-sm opacity-90 mb-2">{s.description}</p>
                      <div className="text-xs opacity-70">
                        <span className="font-medium">Recommendation:</span> {s.recommended_action}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Top large tool outputs */}
      <div>
        <h3 className="text-md font-semibold mb-3">Top Large Tool Outputs</h3>
        {!hasToolOutputs ? (
          <div className="bg-zinc-800 rounded-lg border border-zinc-700 p-6 text-center text-zinc-400">
            No tool output data available.
          </div>
        ) : (
          <div className="bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-700 text-zinc-400">
                  <th className="text-left px-4 py-2 font-medium">#</th>
                  <th className="text-left px-4 py-2 font-medium">Tool Name</th>
                  <th className="text-right px-4 py-2 font-medium">Output Size</th>
                  <th className="text-right px-4 py-2 font-medium">~Token Impact</th>
                  <th className="text-left px-4 py-2 font-medium">Log ID</th>
                </tr>
              </thead>
              <tbody>
                {data.top_large_tool_outputs.map((t, i) => (
                  <tr key={i} className="border-b border-zinc-700/50 hover:bg-zinc-700/30">
                    <td className="px-4 py-2 text-zinc-500 tabular-nums">{i + 1}</td>
                    <td className="px-4 py-2 font-mono text-xs">{t.tool_name}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatBytes(t.output_bytes)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-400">
                      ~{formatTokens(Math.round(t.output_bytes / 4))}
                    </td>
                    <td className="px-4 py-2">
                      <a
                        href={`/logs/${t.llm_log_id}`}
                        className="text-blue-400 hover:underline font-mono text-xs"
                      >
                        {t.llm_log_id.substring(0, 12)}...
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

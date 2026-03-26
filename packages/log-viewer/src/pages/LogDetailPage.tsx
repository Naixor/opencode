import { useState, useEffect, useCallback, useRef } from "react"
import { useParams, useNavigate } from "react-router"

interface TokenDetail {
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost: number
}

interface ToolCall {
  id: string
  call_id: string | null
  tool_name: string
  input: any
  output: any
  title: string | null
  status: string | null
  time_start: number | null
  duration_ms: number | null
  output_bytes: number | null
}

interface HookRecord {
  id: string
  hook_name: string
  chain_type: string
  priority: number
  modified_fields: any
  duration_ms: number | null
}

interface Annotation {
  id: string
  type: string
  content: string
  marked_text: string | null
  time_created: number
}

interface LogDetail {
  id: string
  session_id: string
  agent: string
  model: string
  provider: string
  variant: string | null
  status: string
  time_start: number
  time_end: number | null
  duration_ms: number | null
  request: {
    system_prompt: string
    messages: any[]
    tools: any
    options: any
    headers: Record<string, string> | null
  } | null
  response: {
    completion_text: string | null
    tool_calls: any
    raw_response: any
    error: any
  } | null
  tokens: TokenDetail | null
  tool_calls: ToolCall[]
  hooks: HookRecord[]
  annotations: Annotation[]
}

type Tab = "overview" | "request" | "response" | "tools" | "hooks" | "annotations" | "diff"

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "request", label: "Request" },
  { id: "response", label: "Response" },
  { id: "tools", label: "Tools" },
  { id: "hooks", label: "Hooks" },
  { id: "annotations", label: "Annotations" },
  { id: "diff", label: "Diff" },
]

const statusColors: Record<string, string> = {
  success: "text-green-400",
  error: "text-red-400",
  aborted: "text-yellow-400",
  pending: "text-zinc-400",
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "-"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTokens(n: number | null | undefined): string {
  if (n == null) return "-"
  return n.toLocaleString()
}

function formatCost(microdollars: number | null | undefined): string {
  if (microdollars == null) return "-"
  const dollars = microdollars / 1_000_000
  if (dollars < 0.001) return "<$0.001"
  return `$${dollars.toFixed(4)}`
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "-"
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function JsonTree({ data, collapsed }: { data: any; collapsed?: boolean }) {
  const [isCollapsed, setIsCollapsed] = useState(collapsed ?? false)

  if (data == null) return <span className="text-zinc-500">null</span>
  if (typeof data !== "object") {
    if (typeof data === "string") return <span className="text-green-400">"{data}"</span>
    if (typeof data === "boolean") return <span className="text-yellow-400">{String(data)}</span>
    return <span className="text-blue-400">{String(data)}</span>
  }

  const isArray = Array.isArray(data)
  const entries = isArray ? data.map((v: any, i: number) => [i, v]) : Object.entries(data)
  const bracket = isArray ? ["[", "]"] : ["{", "}"]

  if (entries.length === 0) return <span className="text-zinc-500">{bracket[0] + bracket[1]}</span>

  if (isCollapsed) {
    return (
      <span>
        <button onClick={() => setIsCollapsed(false)} className="text-zinc-500 hover:text-zinc-300">
          {bracket[0]} {entries.length} items... {bracket[1]}
        </button>
      </span>
    )
  }

  return (
    <span>
      <button onClick={() => setIsCollapsed(true)} className="text-zinc-500 hover:text-zinc-300">
        {bracket[0]}
      </button>
      <div className="pl-4 border-l border-zinc-800">
        {entries.map((entry: any, idx: number) => {
          const key = entry[0]
          const value = entry[1]
          return (
            <div key={idx}>
              {!isArray && <span className="text-purple-400">{key}</span>}
              {!isArray && <span className="text-zinc-500">: </span>}
              <JsonTree data={value} collapsed />
              {idx < entries.length - 1 && <span className="text-zinc-600">,</span>}
            </div>
          )
        })}
      </div>
      <span className="text-zinc-500">{bracket[1]}</span>
    </span>
  )
}

function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-2.5 bg-zinc-900 hover:bg-zinc-800/80 text-left text-sm font-medium text-zinc-300 flex items-center justify-between transition-colors"
      >
        {title}
        <span className="text-zinc-500 text-xs">{open ? "collapse" : "expand"}</span>
      </button>
      {open && <div className="p-4 bg-zinc-950 text-sm">{children}</div>}
    </div>
  )
}

function MessageBubble({ message }: { message: any }) {
  const role = message.role ?? "unknown"
  const roleColors: Record<string, string> = {
    user: "border-blue-800 bg-blue-950/30",
    assistant: "border-emerald-800 bg-emerald-950/30",
    tool: "border-amber-800 bg-amber-950/30",
    system: "border-purple-800 bg-purple-950/30",
  }
  const roleLabelColors: Record<string, string> = {
    user: "text-blue-400",
    assistant: "text-emerald-400",
    tool: "text-amber-400",
    system: "text-purple-400",
  }
  const borderClass = roleColors[role] ?? "border-zinc-800 bg-zinc-900"
  const labelClass = roleLabelColors[role] ?? "text-zinc-400"

  const content =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .map((part: any) => {
              if (typeof part === "string") return part
              if (part.type === "text") return part.text
              if (part.type === "tool-call" || part.type === "tool_call") return `[Tool: ${part.toolName ?? part.name}]`
              if (part.type === "tool-result" || part.type === "tool_result")
                return `[Tool Result: ${part.toolName ?? part.name ?? ""}]`
              return JSON.stringify(part)
            })
            .join("\n")
        : JSON.stringify(message.content)

  return (
    <div className={`border rounded-lg p-3 ${borderClass}`}>
      <div className={`text-xs font-medium mb-1.5 ${labelClass}`}>{role}</div>
      <pre className="text-zinc-200 text-sm whitespace-pre-wrap break-words font-mono leading-relaxed">{content}</pre>
    </div>
  )
}

function OverviewTab({ data }: { data: LogDetail }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Left: Meta info */}
      <div className="space-y-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-zinc-400 mb-3">Request Info</h3>
          <KeyValueTable
            entries={[
              ["ID", data.id],
              ["Session", data.session_id],
              ["Agent", data.agent],
              ["Model", data.model],
              ["Provider", data.provider],
              ["Variant", data.variant ?? "-"],
              ["Status", data.status],
              ["Started", formatTime(data.time_start)],
              ["Ended", data.time_end ? formatTime(data.time_end) : "-"],
              ["Duration", formatDuration(data.duration_ms)],
            ]}
          />
        </div>
      </div>

      {/* Right: Token detail */}
      <div className="space-y-4">
        {data.tokens && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <h3 className="text-sm font-medium text-zinc-400 mb-3">Token Usage</h3>
            <KeyValueTable
              entries={[
                ["Input Tokens", formatTokens(data.tokens.input_tokens)],
                ["Output Tokens", formatTokens(data.tokens.output_tokens)],
                ["Reasoning Tokens", formatTokens(data.tokens.reasoning_tokens)],
                ["Cache Read Tokens", formatTokens(data.tokens.cache_read_tokens)],
                ["Cache Write Tokens", formatTokens(data.tokens.cache_write_tokens)],
                ["Total Cost", formatCost(data.tokens.cost)],
              ]}
            />
          </div>
        )}

        {data.response?.error && (
          <div className="bg-red-950 border border-red-800 rounded-lg p-4">
            <h3 className="text-sm font-medium text-red-400 mb-2">Error</h3>
            <pre className="text-red-300 text-sm whitespace-pre-wrap break-words font-mono">
              {typeof data.response.error === "string"
                ? data.response.error
                : JSON.stringify(data.response.error, null, 2)}
            </pre>
          </div>
        )}

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-zinc-400 mb-3">Summary</h3>
          <KeyValueTable
            entries={[
              ["Tool Calls", String(data.tool_calls.length)],
              ["Hooks Executed", String(data.hooks.length)],
              ["Annotations", String(data.annotations.length)],
            ]}
          />
        </div>
      </div>
    </div>
  )
}

function RequestTab({ data }: { data: LogDetail }) {
  if (!data.request) {
    return <p className="text-zinc-500 text-sm">No request data available.</p>
  }

  return (
    <div className="space-y-4">
      {/* System Prompt */}
      <CollapsibleSection title="System Prompt" defaultOpen>
        <pre className="text-zinc-200 text-sm whitespace-pre-wrap break-words font-mono leading-relaxed max-h-[600px] overflow-y-auto">
          {data.request.system_prompt}
        </pre>
      </CollapsibleSection>

      {/* Messages */}
      <CollapsibleSection title={`Messages (${data.request.messages.length})`} defaultOpen>
        <div className="space-y-3 max-h-[600px] overflow-y-auto">
          {data.request.messages.length === 0 ? (
            <p className="text-zinc-500 text-sm">No messages.</p>
          ) : (
            data.request.messages.map((msg: any, i: number) => <MessageBubble key={i} message={msg} />)
          )}
        </div>
      </CollapsibleSection>

      {/* Tools */}
      {data.request.tools && (
        <CollapsibleSection title="Tool Schemas">
          <div className="font-mono text-xs max-h-[400px] overflow-y-auto">
            <JsonTree data={data.request.tools} collapsed />
          </div>
        </CollapsibleSection>
      )}

      {/* Request Headers */}
      {data.request.headers && Object.keys(data.request.headers).length > 0 && (
        <CollapsibleSection title={`Request Headers (${Object.keys(data.request.headers).length})`}>
          <KeyValueTable entries={Object.entries(data.request.headers).sort(([a], [b]) => a.localeCompare(b))} />
        </CollapsibleSection>
      )}

      {/* Provider Options */}
      {data.request.options && (
        <CollapsibleSection title="Provider Options">
          <KeyValueTable
            entries={Object.entries(data.request.options).map(([k, v]) => [
              k,
              typeof v === "object" ? JSON.stringify(v) : String(v ?? "-"),
            ])}
          />
        </CollapsibleSection>
      )}
    </div>
  )
}

function ResponseTab({ data }: { data: LogDetail }) {
  if (!data.response) {
    return <p className="text-zinc-500 text-sm">No response data available.</p>
  }

  const raw = data.response.raw_response
  const headers = raw?.headers as Record<string, string> | undefined
  const meta = raw
    ? [
        ...(raw.id ? [["Response ID", raw.id]] : []),
        ...(raw.modelId ? [["Model ID", raw.modelId]] : []),
        ...(raw.timestamp ? [["Timestamp", String(raw.timestamp)]] : []),
        ...(raw.finishReason ? [["Finish Reason", raw.finishReason]] : []),
      ]
    : []

  return (
    <div className="space-y-4">
      {/* Error */}
      {data.response.error && (
        <div className="bg-red-950 border border-red-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-red-400 mb-2">Error</h3>
          <pre className="text-red-300 text-sm whitespace-pre-wrap break-words font-mono">
            {typeof data.response.error === "string"
              ? data.response.error
              : JSON.stringify(data.response.error, null, 2)}
          </pre>
        </div>
      )}

      {/* Response Metadata */}
      {meta.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-zinc-400 mb-3">Response Metadata</h3>
          <KeyValueTable entries={meta as [string, string][]} />
        </div>
      )}

      {/* Response Headers */}
      {headers && Object.keys(headers).length > 0 && (
        <CollapsibleSection title={`Response Headers (${Object.keys(headers).length})`}>
          <KeyValueTable entries={Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))} />
        </CollapsibleSection>
      )}

      {/* Completion Text */}
      <CollapsibleSection title="Completion" defaultOpen>
        {data.response.completion_text ? (
          <pre className="text-zinc-200 text-sm whitespace-pre-wrap break-words font-mono leading-relaxed max-h-[600px] overflow-y-auto">
            {data.response.completion_text}
          </pre>
        ) : (
          <p className="text-zinc-500 text-sm">No completion text.</p>
        )}
      </CollapsibleSection>

      {/* Tool Calls from response */}
      {data.response.tool_calls && (
        <CollapsibleSection title="Tool Calls (from response)">
          <div className="font-mono text-xs max-h-[400px] overflow-y-auto">
            <JsonTree data={data.response.tool_calls} collapsed />
          </div>
        </CollapsibleSection>
      )}

      {/* Token detail table */}
      {data.tokens && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b border-zinc-800">
            <h3 className="text-sm font-medium text-zinc-400">Token Detail</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500">
                <th className="px-4 py-2 text-left font-medium">Category</th>
                <th className="px-4 py-2 text-right font-medium">Count</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Input", data.tokens.input_tokens],
                ["Output", data.tokens.output_tokens],
                ["Reasoning", data.tokens.reasoning_tokens],
                ["Cache Read", data.tokens.cache_read_tokens],
                ["Cache Write", data.tokens.cache_write_tokens],
              ].map(([label, value]) => (
                <tr key={label as string} className="border-b border-zinc-800/50">
                  <td className="px-4 py-2 text-zinc-300">{label}</td>
                  <td className="px-4 py-2 text-zinc-200 text-right tabular-nums">{formatTokens(value as number)}</td>
                </tr>
              ))}
              <tr className="bg-zinc-900">
                <td className="px-4 py-2 text-zinc-300 font-medium">Cost</td>
                <td className="px-4 py-2 text-zinc-200 text-right font-medium">{formatCost(data.tokens.cost)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ToolsTab({ data }: { data: LogDetail }) {
  if (data.tool_calls.length === 0) {
    return <p className="text-zinc-500 text-sm">No tool calls recorded.</p>
  }

  return (
    <div className="space-y-3">
      {data.tool_calls.map((tc) => (
        <ToolCallCard key={tc.id} toolCall={tc} />
      ))}
    </div>
  )
}

function ToolCallCard({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const statusColor =
    toolCall.status === "success" ? "text-green-400" : toolCall.status === "error" ? "text-red-400" : "text-zinc-400"

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-zinc-800/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-zinc-200">{toolCall.tool_name}</span>
          {toolCall.title && <span className="text-xs text-zinc-500">{toolCall.title}</span>}
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className={statusColor}>{toolCall.status ?? "-"}</span>
          <span className="text-zinc-500">{formatDuration(toolCall.duration_ms)}</span>
          {toolCall.output_bytes != null && <span className="text-zinc-500">{formatBytes(toolCall.output_bytes)}</span>}
          <span className="text-zinc-600">{expanded ? "collapse" : "expand"}</span>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-zinc-800 p-4 space-y-3">
          {toolCall.call_id && (
            <div className="text-xs text-zinc-500">
              Call ID: <code className="text-zinc-400">{toolCall.call_id}</code>
            </div>
          )}
          <div>
            <h4 className="text-xs font-medium text-zinc-500 mb-1.5">Input</h4>
            <div className="bg-zinc-950 rounded p-3 font-mono text-xs max-h-[300px] overflow-y-auto">
              <JsonTree data={toolCall.input} />
            </div>
          </div>
          <div>
            <h4 className="text-xs font-medium text-zinc-500 mb-1.5">Output</h4>
            <div className="bg-zinc-950 rounded p-3 max-h-[400px] overflow-y-auto">
              {typeof toolCall.output === "string" ? (
                <pre className="text-zinc-200 text-xs whitespace-pre-wrap break-words font-mono">{toolCall.output}</pre>
              ) : (
                <div className="font-mono text-xs">
                  <JsonTree data={toolCall.output} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function HooksTab({ data }: { data: LogDetail }) {
  if (data.hooks.length === 0) {
    return <p className="text-zinc-500 text-sm">No hook executions recorded.</p>
  }

  const grouped = data.hooks.reduce<Record<string, HookRecord[]>>((acc, h) => {
    const key = h.chain_type
    if (!acc[key]) acc[key] = []
    acc[key].push(h)
    return acc
  }, {})

  const chainTypeColors: Record<string, string> = {
    "pre-llm": "text-blue-400",
    "pre-tool": "text-amber-400",
    "post-tool": "text-emerald-400",
    "session-lifecycle": "text-purple-400",
  }

  return (
    <div className="space-y-4">
      {Object.entries(grouped).map(([chainType, hooks]) => (
        <div key={chainType} className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b border-zinc-800">
            <h3 className={`text-sm font-medium ${chainTypeColors[chainType] ?? "text-zinc-400"}`}>{chainType}</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500 text-xs">
                <th className="px-4 py-2 text-left font-medium">Hook</th>
                <th className="px-4 py-2 text-right font-medium">Priority</th>
                <th className="px-4 py-2 text-left font-medium">Modified Fields</th>
                <th className="px-4 py-2 text-right font-medium">Duration</th>
              </tr>
            </thead>
            <tbody>
              {hooks.map((hook) => {
                const fields = Array.isArray(hook.modified_fields)
                  ? hook.modified_fields
                  : typeof hook.modified_fields === "string"
                    ? (() => {
                        try {
                          return JSON.parse(hook.modified_fields)
                        } catch {
                          return []
                        }
                      })()
                    : []
                return (
                  <tr key={hook.id} className="border-b border-zinc-800/50">
                    <td className="px-4 py-2 text-zinc-300 font-mono text-xs">{hook.hook_name}</td>
                    <td className="px-4 py-2 text-zinc-400 text-right tabular-nums">{hook.priority}</td>
                    <td className="px-4 py-2">
                      {fields.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {fields.map((field: string, i: number) => (
                            <span key={i} className="px-1.5 py-0.5 bg-zinc-800 rounded text-xs text-zinc-300">
                              {field}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-zinc-600 text-xs">none</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-zinc-400 text-right tabular-nums text-xs">
                      {hook.duration_ms != null ? `${hook.duration_ms.toFixed(1)}ms` : "-"}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

const annotationTypeConfig: Record<
  string,
  { label: string; bg: string; border: string; text: string; highlight: string }
> = {
  hallucination: {
    label: "Hallucination",
    bg: "bg-red-950",
    border: "border-red-800",
    text: "text-red-400",
    highlight: "bg-red-500/20",
  },
  quality: {
    label: "Quality",
    bg: "bg-yellow-950",
    border: "border-yellow-800",
    text: "text-yellow-400",
    highlight: "bg-yellow-500/20",
  },
  note: {
    label: "Note",
    bg: "bg-blue-950",
    border: "border-blue-800",
    text: "text-blue-400",
    highlight: "bg-blue-500/20",
  },
}

function AnnotationToolbar({
  position,
  onAnnotate,
  onClose,
}: {
  position: { top: number; left: number }
  onAnnotate: (type: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl p-1 flex items-center gap-1"
      style={{ top: position.top - 44, left: position.left }}
    >
      {Object.entries(annotationTypeConfig).map(([type, config]) => (
        <button
          key={type}
          onClick={() => onAnnotate(type)}
          className={`px-2.5 py-1.5 text-xs font-medium rounded ${config.text} hover:${config.bg} transition-colors`}
          title={`Mark as ${config.label}`}
        >
          {config.label}
        </button>
      ))}
    </div>
  )
}

function AnnotationsTab({
  data,
  onAnnotationCreated,
  onAnnotationDeleted,
}: {
  data: LogDetail
  onAnnotationCreated: () => void
  onAnnotationDeleted: () => void
}) {
  const containerRef = useRef<HTMLPreElement>(null)
  const [toolbar, setToolbar] = useState<{ top: number; left: number; selectedText: string } | null>(null)
  const [annotationNote, setAnnotationNote] = useState("")
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const completionText = data.response?.completion_text ?? ""

  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !containerRef.current) return
    const selectedText = selection.toString().trim()
    if (!selectedText) return
    const range = selection.getRangeAt(0)
    if (!containerRef.current.contains(range.commonAncestorContainer)) return
    const rect = range.getBoundingClientRect()
    setToolbar({
      top: rect.top + window.scrollY,
      left: rect.left + rect.width / 2 - 100,
      selectedText,
    })
  }, [])

  const handleAnnotate = useCallback(
    async (type: string) => {
      if (!toolbar || creating) return
      setCreating(true)
      try {
        const res = await fetch(`/log-viewer/api/logs/${data.id}/annotations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            content: annotationNote || `Marked as ${type}`,
            marked_text: toolbar.selectedText,
          }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setToolbar(null)
        setAnnotationNote("")
        window.getSelection()?.removeAllRanges()
        onAnnotationCreated()
      } catch {
        // silently fail — could add error toast
      } finally {
        setCreating(false)
      }
    },
    [toolbar, annotationNote, creating, data.id, onAnnotationCreated],
  )

  const handleDelete = useCallback(
    async (annotationId: string) => {
      if (deleting) return
      setDeleting(annotationId)
      try {
        const res = await fetch(`/log-viewer/api/logs/annotations/${annotationId}`, { method: "DELETE" })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        onAnnotationDeleted()
      } catch {
        // silently fail
      } finally {
        setDeleting(null)
      }
    },
    [deleting, onAnnotationDeleted],
  )

  // Build highlighted segments
  const segments: Array<{ text: string; annotation?: Annotation }> = []
  if (data.annotations.length === 0 || !completionText) {
    segments.push({ text: completionText || "(no completion text)" })
  } else {
    const markers: Array<{ start: number; end: number; annotation: Annotation }> = []
    for (const ann of data.annotations) {
      if (!ann.marked_text) continue
      let searchFrom = 0
      while (searchFrom < completionText.length) {
        const idx = completionText.indexOf(ann.marked_text, searchFrom)
        if (idx === -1) break
        markers.push({ start: idx, end: idx + ann.marked_text.length, annotation: ann })
        searchFrom = idx + ann.marked_text.length
      }
    }
    markers.sort((a, b) => a.start - b.start)
    let pos = 0
    for (const marker of markers) {
      if (marker.start < pos) continue
      if (marker.start > pos) segments.push({ text: completionText.slice(pos, marker.start) })
      segments.push({ text: completionText.slice(marker.start, marker.end), annotation: marker.annotation })
      pos = marker.end
    }
    if (pos < completionText.length) segments.push({ text: completionText.slice(pos) })
  }

  return (
    <div className="space-y-6">
      {/* Instructions */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <h3 className="text-sm font-medium text-zinc-300 mb-2">How to Annotate</h3>
        <p className="text-xs text-zinc-500">
          Select text in the completion below, then choose an annotation type from the floating toolbar. Optionally add
          a note before selecting the type.
        </p>
        {toolbar && (
          <div className="mt-2">
            <input
              type="text"
              value={annotationNote}
              onChange={(e) => setAnnotationNote(e.target.value)}
              placeholder="Optional note for annotation..."
              className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
            />
          </div>
        )}
      </div>

      {/* Completion text with highlights */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-zinc-800">
          <h3 className="text-sm font-medium text-zinc-400">Completion Text</h3>
        </div>
        <div className="p-4 relative">
          <pre
            ref={containerRef}
            onMouseUp={handleMouseUp}
            className="text-zinc-200 text-sm whitespace-pre-wrap break-words font-mono leading-relaxed max-h-[500px] overflow-y-auto cursor-text"
          >
            {segments.map((seg, i) => {
              if (!seg.annotation) return <span key={i}>{seg.text}</span>
              const config = annotationTypeConfig[seg.annotation.type] ?? annotationTypeConfig.note
              return (
                <span
                  key={i}
                  className={`${config.highlight} rounded-sm px-0.5 cursor-help`}
                  title={`[${seg.annotation.type}] ${seg.annotation.content}`}
                >
                  {seg.text}
                </span>
              )
            })}
          </pre>
          {toolbar && (
            <AnnotationToolbar
              position={toolbar}
              onAnnotate={handleAnnotate}
              onClose={() => {
                setToolbar(null)
                setAnnotationNote("")
              }}
            />
          )}
        </div>
      </div>

      {/* Existing annotations list */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-zinc-800">
          <h3 className="text-sm font-medium text-zinc-400">Annotations ({data.annotations.length})</h3>
        </div>
        {data.annotations.length === 0 ? (
          <div className="p-4 text-zinc-500 text-sm">No annotations yet. Select text above to create one.</div>
        ) : (
          <div className="divide-y divide-zinc-800">
            {data.annotations.map((ann) => {
              const config = annotationTypeConfig[ann.type] ?? annotationTypeConfig.note
              return (
                <div key={ann.id} className="p-4 flex items-start gap-3">
                  <span
                    className={`px-2 py-0.5 text-xs font-medium rounded ${config.bg} ${config.border} border ${config.text} shrink-0`}
                  >
                    {config.label}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-300">{ann.content}</p>
                    {ann.marked_text && (
                      <p className="text-xs text-zinc-500 mt-1 font-mono truncate">
                        &quot;{ann.marked_text.length > 100 ? ann.marked_text.slice(0, 100) + "..." : ann.marked_text}
                        &quot;
                      </p>
                    )}
                    <p className="text-xs text-zinc-600 mt-1">{formatTime(ann.time_created)}</p>
                  </div>
                  <button
                    onClick={() => handleDelete(ann.id)}
                    disabled={deleting === ann.id}
                    className="text-xs text-zinc-600 hover:text-red-400 transition-colors shrink-0 disabled:opacity-50"
                  >
                    {deleting === ann.id ? "..." : "delete"}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// --- Diff Tab ---

interface DiffPair {
  toolCall: ToolCall
  completionSegment: string | null
  potentialHallucination: boolean
}

function buildDiffPairs(data: LogDetail): DiffPair[] {
  const completionText = data.response?.completion_text ?? ""
  const toolCalls = data.tool_calls.filter((tc) => tc.tool_name && (tc.input != null || tc.output != null))

  if (toolCalls.length === 0) return []

  // Try to find completion text segments that reference each tool call by position.
  // Strategy: look for tool_name mentions in the completion text and extract surrounding context.
  const pairs: DiffPair[] = []

  for (const tc of toolCalls) {
    let segment: string | null = null

    if (completionText) {
      // Search for tool name in completion text
      const nameVariants = [tc.tool_name, tc.tool_name.replace(/_/g, " "), tc.tool_name.replace(/-/g, " ")]
      let bestIdx = -1
      for (const variant of nameVariants) {
        const idx = completionText.toLowerCase().indexOf(variant.toLowerCase())
        if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
          bestIdx = idx
        }
      }

      if (bestIdx !== -1) {
        // Extract context: up to 200 chars before, until next tool mention or 500 chars after
        const start = Math.max(0, completionText.lastIndexOf("\n", Math.max(0, bestIdx - 200)) + 1)
        const end = Math.min(completionText.length, bestIdx + 500)
        // Try to end at a newline boundary
        const newlineAfter = completionText.indexOf("\n\n", bestIdx + tc.tool_name.length)
        const segEnd = newlineAfter !== -1 && newlineAfter < end ? newlineAfter : end
        segment = completionText.slice(start, segEnd).trim()
      }
    }

    // Check for potential hallucination: tool call failed but completion doesn't mention failure/error
    const isFailed = tc.status === "error"
    const completionMentionsFailure = completionText
      ? /\b(fail|error|issue|problem|couldn't|unable|sorry)\b/i.test(segment ?? completionText)
      : false
    const potentialHallucination = isFailed && !completionMentionsFailure

    pairs.push({ toolCall: tc, completionSegment: segment, potentialHallucination })
  }

  return pairs
}

function DiffTab({ data }: { data: LogDetail }) {
  const pairs = buildDiffPairs(data)

  if (pairs.length === 0) {
    return <p className="text-zinc-500 text-sm">No tool calls to compare with completion text.</p>
  }

  const hallucinationCount = pairs.filter((p) => p.potentialHallucination).length

  return (
    <div className="space-y-4">
      {hallucinationCount > 0 && (
        <div className="bg-red-950 border border-red-800 rounded-lg p-3 flex items-center gap-2">
          <span className="text-red-400 text-sm font-medium">
            {hallucinationCount} potential hallucination{hallucinationCount > 1 ? "s" : ""} detected
          </span>
          <span className="text-red-500/70 text-xs">
            Tool call failed but LLM response doesn&apos;t mention the failure.
          </span>
        </div>
      )}

      {pairs.map((pair, i) => (
        <DiffPairCard key={pair.toolCall.id ?? i} pair={pair} index={i} />
      ))}
    </div>
  )
}

function DiffPairCard({ pair, index }: { pair: DiffPair; index: number }) {
  const { toolCall, completionSegment, potentialHallucination } = pair
  const statusColor =
    toolCall.status === "success" ? "text-green-400" : toolCall.status === "error" ? "text-red-400" : "text-zinc-400"

  return (
    <div
      className={`border rounded-lg overflow-hidden ${
        potentialHallucination ? "border-red-700 bg-red-950/20" : "border-zinc-800 bg-zinc-900"
      }`}
    >
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-600">#{index + 1}</span>
          <span className="text-sm font-medium text-zinc-200">{toolCall.tool_name}</span>
          {toolCall.title && <span className="text-xs text-zinc-500">{toolCall.title}</span>}
          <span className={`text-xs ${statusColor}`}>{toolCall.status ?? "-"}</span>
          <span className="text-xs text-zinc-600">{formatDuration(toolCall.duration_ms)}</span>
        </div>
        {potentialHallucination && (
          <span className="px-2 py-0.5 bg-red-900 border border-red-700 rounded text-xs text-red-300 font-medium">
            Potential Hallucination
          </span>
        )}
      </div>

      {/* Side by side panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-zinc-800">
        {/* Left: Completion text segment */}
        <div className="p-4">
          <h4 className="text-xs font-medium text-zinc-500 mb-2">LLM Completion Text</h4>
          {completionSegment ? (
            <pre className="text-zinc-300 text-xs whitespace-pre-wrap break-words font-mono leading-relaxed max-h-[400px] overflow-y-auto bg-zinc-950 rounded p-3">
              {completionSegment}
            </pre>
          ) : (
            <p className="text-zinc-600 text-xs italic">
              No matching segment found in completion text for this tool call.
            </p>
          )}
        </div>

        {/* Right: Tool call actual input/output */}
        <div className="p-4 space-y-3">
          <div>
            <h4 className="text-xs font-medium text-zinc-500 mb-2">Actual Tool Input</h4>
            <div className="bg-zinc-950 rounded p-3 font-mono text-xs max-h-[180px] overflow-y-auto">
              <JsonTree data={toolCall.input} />
            </div>
          </div>
          <div>
            <h4 className="text-xs font-medium text-zinc-500 mb-2">
              Actual Tool Output
              {toolCall.status === "error" && <span className="ml-2 text-red-400 font-normal">(failed)</span>}
            </h4>
            <div
              className={`rounded p-3 max-h-[180px] overflow-y-auto ${
                toolCall.status === "error" ? "bg-red-950/50" : "bg-zinc-950"
              }`}
            >
              {typeof toolCall.output === "string" ? (
                <pre className="text-zinc-200 text-xs whitespace-pre-wrap break-words font-mono">{toolCall.output}</pre>
              ) : (
                <div className="font-mono text-xs">
                  <JsonTree data={toolCall.output} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function KeyValueTable({ entries }: { entries: [string, string][] }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {entries.map(([key, value], i) => (
          <tr key={i} className="border-b border-zinc-800/50 last:border-0">
            <td className="py-1.5 pr-4 text-zinc-500 whitespace-nowrap">{key}</td>
            <td className="py-1.5 text-zinc-200 font-mono text-xs break-all">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function LogDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [data, setData] = useState<LogDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>("overview")

  const fetchData = useCallback(() => {
    if (!id) return
    setLoading(true)
    setError(null)
    fetch(`/log-viewer/api/logs/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json: LogDetail) => setData(json))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to fetch log"))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const refreshData = useCallback(() => {
    if (!id) return
    // Lightweight refresh without loading state
    fetch(`/log-viewer/api/logs/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json: LogDetail) => setData(json))
      .catch(() => {})
  }, [id])

  if (loading) {
    return <div className="text-zinc-500 text-sm">Loading...</div>
  }

  if (error) {
    return (
      <div className="space-y-3">
        <div className="bg-red-950 border border-red-800 rounded-lg p-3 text-red-300 text-sm">{error}</div>
        <button onClick={() => navigate("/")} className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
          Back to list
        </button>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/")} className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
            Logs
          </button>
          <span className="text-zinc-700">/</span>
          <span className="text-sm text-zinc-300 font-mono">{data.id.substring(0, 12)}...</span>
          <span className={`text-sm font-medium ${statusColors[data.status] ?? "text-zinc-400"}`}>{data.status}</span>
        </div>
        <div className="text-xs text-zinc-500">
          {data.agent} &middot; {data.model} &middot; {formatDuration(data.duration_ms)}
        </div>
      </div>

      {/* Tab Bar */}
      <div className="flex items-center gap-1 border-b border-zinc-800 pb-px">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.id
                ? "border-zinc-100 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab.label}
            {tab.id === "tools" && data.tool_calls.length > 0 && (
              <span className="ml-1.5 text-xs text-zinc-500">({data.tool_calls.length})</span>
            )}
            {tab.id === "hooks" && data.hooks.length > 0 && (
              <span className="ml-1.5 text-xs text-zinc-500">({data.hooks.length})</span>
            )}
            {tab.id === "annotations" && data.annotations.length > 0 && (
              <span className="ml-1.5 text-xs text-zinc-500">({data.annotations.length})</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div>
        {activeTab === "overview" && <OverviewTab data={data} />}
        {activeTab === "request" && <RequestTab data={data} />}
        {activeTab === "response" && <ResponseTab data={data} />}
        {activeTab === "tools" && <ToolsTab data={data} />}
        {activeTab === "hooks" && <HooksTab data={data} />}
        {activeTab === "annotations" && (
          <AnnotationsTab data={data} onAnnotationCreated={refreshData} onAnnotationDeleted={refreshData} />
        )}
        {activeTab === "diff" && <DiffTab data={data} />}
      </div>
    </div>
  )
}

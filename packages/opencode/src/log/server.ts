import { LlmLog } from "./query"
import { Log } from "../util/log"
import { NotFoundError } from "../storage/db"

export namespace LogServer {
  const log = Log.create({ service: "log-server" })

  const DEFAULT_PORT = 19836
  const MAX_PORT_ATTEMPTS = 10

  const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }

  function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    })
  }

  function errorResponse(message: string, status: number): Response {
    return jsonResponse({ error: message }, status)
  }

  function parseQueryParams(url: URL): Record<string, string> {
    const params: Record<string, string> = {}
    url.searchParams.forEach((value, key) => {
      params[key] = value
    })
    return params
  }

  function parseListFilters(params: Record<string, string>) {
    return {
      session_id: params.session_id || undefined,
      agent: params.agent || undefined,
      model: params.model || undefined,
      provider: params.provider || undefined,
      status: params.status || undefined,
      time_start: params.time_start ? Number(params.time_start) : undefined,
      time_end: params.time_end ? Number(params.time_end) : undefined,
      limit: params.limit ? Number(params.limit) : undefined,
      offset: params.offset ? Number(params.offset) : undefined,
    }
  }

  function parseStatsFilters(params: Record<string, string>) {
    return {
      session_id: params.session_id || undefined,
      agent: params.agent || undefined,
      model: params.model || undefined,
      provider: params.provider || undefined,
      time_start: params.time_start ? Number(params.time_start) : undefined,
      time_end: params.time_end ? Number(params.time_end) : undefined,
      group_by: (params.group_by as "model" | "agent" | "session" | "hour" | "day") || undefined,
    }
  }

  function parseAnalyzeFilters(params: Record<string, string>) {
    return {
      session_id: params.session_id || undefined,
      agent: params.agent || undefined,
      model: params.model || undefined,
      provider: params.provider || undefined,
      time_start: params.time_start ? Number(params.time_start) : undefined,
      time_end: params.time_end ? Number(params.time_end) : undefined,
    }
  }

  async function handleRequest(req: Request, staticDir?: string): Promise<Response> {
    const url = new URL(req.url)
    const { pathname } = url

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    // API routes
    if (pathname.startsWith("/api/")) {
      return handleApiRoute(req, url, pathname)
    }

    // Static file serving
    if (staticDir) {
      return serveStaticFile(staticDir, pathname)
    }

    // Fallback: return a simple HTML page
    return new Response(
      `<!DOCTYPE html><html><head><title>OpenCode Log Viewer</title></head><body><h1>OpenCode Log Viewer</h1><p>Log viewer assets not found. API available at /api/</p></body></html>`,
      { status: 200, headers: { "Content-Type": "text/html", ...CORS_HEADERS } },
    )
  }

  async function handleApiRoute(req: Request, url: URL, pathname: string): Promise<Response> {
    try {
      // GET /api/health
      if (req.method === "GET" && pathname === "/api/health") {
        return jsonResponse({ status: "ok" })
      }

      // GET /api/logs/stats — must be before /api/logs/:id
      if (req.method === "GET" && pathname === "/api/logs/stats") {
        const params = parseQueryParams(url)
        const filters = parseStatsFilters(params)
        const result = LlmLog.stats(filters)
        return jsonResponse(result)
      }

      // GET /api/logs/analyze — must be before /api/logs/:id
      if (req.method === "GET" && pathname === "/api/logs/analyze") {
        const params = parseQueryParams(url)
        const filters = parseAnalyzeFilters(params)
        const result = LlmLog.analyze(filters)
        return jsonResponse(result)
      }

      // POST /api/logs/cleanup
      if (req.method === "POST" && pathname === "/api/logs/cleanup") {
        const body = await req.json().catch(() => ({}))
        const result = LlmLog.cleanup(body)
        return jsonResponse(result)
      }

      // GET /api/logs — list
      if (req.method === "GET" && pathname === "/api/logs") {
        const params = parseQueryParams(url)
        const filters = parseListFilters(params)
        const result = LlmLog.list(filters)
        return jsonResponse(result)
      }

      // DELETE /api/logs/annotations/:id
      const deleteAnnotationMatch = pathname.match(/^\/api\/logs\/annotations\/(.+)$/)
      if (req.method === "DELETE" && deleteAnnotationMatch) {
        const annotationId = deleteAnnotationMatch[1]
        LlmLog.deleteAnnotation(annotationId)
        return jsonResponse({ success: true })
      }

      // POST /api/logs/:id/annotations
      const postAnnotationMatch = pathname.match(/^\/api\/logs\/(.+)\/annotations$/)
      if (req.method === "POST" && postAnnotationMatch) {
        const llmLogId = postAnnotationMatch[1]
        const body = await req.json()
        const result = LlmLog.annotate(llmLogId, body)
        return jsonResponse(result, 201)
      }

      // GET /api/logs/:id — detail (must be last /api/logs/ route)
      const getDetailMatch = pathname.match(/^\/api\/logs\/(.+)$/)
      if (req.method === "GET" && getDetailMatch) {
        const id = getDetailMatch[1]
        const result = LlmLog.get(id)
        return jsonResponse(result)
      }

      return errorResponse("Not found", 404)
    } catch (e) {
      if (e instanceof NotFoundError) {
        return errorResponse(e.message, 404)
      }
      log.error("api error", { error: e })
      return errorResponse(e instanceof Error ? e.message : "Internal server error", 500)
    }
  }

  async function serveStaticFile(staticDir: string, pathname: string): Promise<Response> {
    const filePath = pathname === "/" ? "/index.html" : pathname
    const fullPath = `${staticDir}${filePath}`

    const file = Bun.file(fullPath)
    if (await file.exists()) {
      return new Response(file, { headers: CORS_HEADERS })
    }

    // SPA fallback: serve index.html for non-file paths
    const indexFile = Bun.file(`${staticDir}/index.html`)
    if (await indexFile.exists()) {
      return new Response(indexFile, { headers: { "Content-Type": "text/html", ...CORS_HEADERS } })
    }

    return new Response(
      `<!DOCTYPE html><html><head><title>OpenCode Log Viewer</title></head><body><h1>OpenCode Log Viewer</h1><p>Log viewer assets not found. API available at /api/</p></body></html>`,
      { status: 200, headers: { "Content-Type": "text/html", ...CORS_HEADERS } },
    )
  }

  async function tryPort(port: number): Promise<boolean> {
    try {
      const server = Bun.serve({ port, fetch: () => new Response("") })
      server.stop(true)
      return true
    } catch {
      return false
    }
  }

  export interface ServerOptions {
    port?: number
    staticDir?: string
  }

  export interface ServerInstance {
    url: string
    port: number
    stop: () => void
  }

  export async function start(options?: ServerOptions): Promise<ServerInstance> {
    let port = options?.port ?? DEFAULT_PORT
    const staticDir = options?.staticDir

    // Auto-increment port when occupied
    if (!options?.port) {
      for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
        if (await tryPort(port)) break
        log.info("port occupied, trying next", { port, next: port + 1 })
        port++
      }
    }

    const server = Bun.serve({
      port,
      fetch: (req) => handleRequest(req, staticDir),
    })

    const url = `http://localhost:${server.port}`
    log.info("server started", { url, port: server.port })

    return {
      url,
      port: server.port ?? port,
      stop: () => server.stop(true),
    }
  }
}

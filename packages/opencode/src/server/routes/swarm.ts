import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Swarm } from "../../session/swarm"
import { Bus } from "../../bus"
import { SharedBoard, BoardTask, BoardArtifact, BoardSignal } from "../../board"
import { Discussion } from "../../board/discussion"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { SwarmAdmin } from "../../session/swarm-admin"
import { SwarmState } from "../../session/swarm-state"

const flag = z
  .string()
  .optional()
  .transform((value) => value === "true")

const alignmentWrite = z.object({
  swarm: z.lazy(() => Swarm.Info),
  alignment: z.lazy(() => SwarmAdmin.Alignment),
})

const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCode Swarm Admin</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e7eb;
    }
    a { color: inherit; }
    .page {
      display: grid;
      grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
      min-height: 100vh;
    }
    .list, .detail {
      padding: 24px;
    }
    .list {
      border-right: 1px solid #20242c;
      background: #0f1115;
    }
    .title {
      font-size: 1.2rem;
      font-weight: 700;
      margin: 0 0 6px;
    }
    .sub {
      color: #94a3b8;
      font-size: 0.9rem;
      margin: 0 0 20px;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .filters {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .btn {
      border: 1px solid #334155;
      background: #111827;
      color: #e5e7eb;
      border-radius: 8px;
      padding: 8px 12px;
      cursor: pointer;
    }
    .btn:hover { border-color: #60a5fa; }
    .btn.active {
      border-color: #60a5fa;
      background: #172554;
    }
    .btn.warn {
      border-color: #854d0e;
      background: #231709;
      color: #facc15;
    }
    .btn.danger {
      border-color: #7f1d1d;
      background: #2a0d13;
      color: #fecaca;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .items {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .item {
      border: 1px solid #253041;
      background: #111827;
      border-radius: 12px;
      padding: 14px;
      cursor: pointer;
    }
    .item.active {
      border-color: #60a5fa;
      box-shadow: inset 0 0 0 1px #60a5fa;
    }
    .item:hover { border-color: #4b5563; }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
    .goal {
      font-weight: 600;
      margin: 10px 0;
      line-height: 1.45;
    }
    .meta, .chips, .section {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .meta {
      color: #94a3b8;
      font-size: 0.82rem;
      margin-bottom: 10px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 0.75rem;
      border: 1px solid #334155;
      background: #0f172a;
      color: #cbd5e1;
    }
    .chip.warn {
      border-color: #854d0e;
      background: #231709;
      color: #facc15;
    }
    .panel {
      border: 1px solid #253041;
      background: #111827;
      border-radius: 14px;
      padding: 18px;
      margin-bottom: 16px;
    }
    .label {
      color: #94a3b8;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 10px;
    }
    .value {
      line-height: 1.55;
      color: #e5e7eb;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .empty {
      color: #94a3b8;
      font-size: 0.9rem;
      padding: 24px;
      border: 1px dashed #334155;
      border-radius: 12px;
      background: #0f172a;
    }
    .muted { color: #94a3b8; }
    .stack {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
    }
    @media (max-width: 960px) {
      .page { grid-template-columns: 1fr; }
      .list { border-right: 0; border-bottom: 1px solid #20242c; }
    }
  </style>
</head>
<body>
  <div class="page">
    <aside class="list">
      <h1 class="title">Swarm Admin</h1>
      <p class="sub">Manager now opens a lightweight Swarm overview instead of the raw JSON API.</p>
      <div class="toolbar">
        <button class="btn" id="refresh">Refresh</button>
        <button class="btn" id="clear">Clear selection</button>
      </div>
      <div class="items" id="items"></div>
    </aside>
    <main class="detail" id="detail"></main>
  </div>
  <script>
    const items = document.getElementById('items')
    const detail = document.getElementById('detail')
    const refresh = document.getElementById('refresh')
    const clear = document.getElementById('clear')
    const state = {
      rows: [],
      id: new URL(window.location.href).searchParams.get('id'),
      status: new URL(window.location.href).searchParams.get('status') || 'all',
      busy: false,
    }

    const esc = (value) => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')

    const ago = (value) => {
      if (!value) return 'unknown'
      const diff = Date.now() - value
      const min = 60 * 1000
      const hour = 60 * min
      const day = 24 * hour
      if (diff < min) return 'just now'
      if (diff < hour) return Math.round(diff / min) + 'm ago'
      if (diff < day) return Math.round(diff / hour) + 'h ago'
      return Math.round(diff / day) + 'd ago'
    }

    const syncUrl = () => {
      const url = new URL(window.location.href)
      if (state.id) url.searchParams.set('id', state.id)
      else url.searchParams.delete('id')
      if (state.status && state.status !== 'all') url.searchParams.set('status', state.status)
      else url.searchParams.delete('status')
      history.replaceState(null, '', url)
    }

    const pick = (id) => {
      state.id = id
      syncUrl()
      renderList()
      renderDetail()
      if (id) loadDetail(id)
    }

    const setStatus = (status) => {
      state.status = status
      syncUrl()
      loadRows()
    }

    const canStop = (status) => status === 'active' || status === 'blocked' || status === 'paused'
    const canArchive = (status) => status && status !== 'active' && status !== 'blocked' && status !== 'paused'

    const renderFilters = () => {
      const tabs = [
        ['all', 'All'],
        ['active', 'Active'],
        ['blocked', 'Blocked'],
        ['paused', 'Paused'],
        ['failed', 'Failed'],
        ['completed', 'Completed'],
        ['stopped', 'Stopped'],
        ['archived', 'Archived'],
      ]
      return tabs.map(([value, label]) =>
        '<button class="btn' + (state.status === value ? ' active' : '') + '" data-status="' + value + '">' + label + '</button>'
      ).join('')
    }

    const renderList = () => {
      const filters = '<div class="filters">' + renderFilters() + '</div>'
      if (!state.rows.length) {
        items.innerHTML = filters + '<div class="empty">No swarms found for the current workspace.</div>'
        items.querySelectorAll('[data-status]').forEach((node) => {
          node.addEventListener('click', () => setStatus(node.getAttribute('data-status')))
        })
        return
      }

      items.innerHTML = filters + state.rows.map((row) => {
        const warn = row.needs_attention && row.attention.length
          ? '<span class="chip warn">⚠ ' + esc(row.attention.join(' · ')) + '</span>'
          : ''
        return '<button class="item' + (state.id === row.swarm_id ? ' active' : '') + '" data-id="' + esc(row.swarm_id) + '">' +
          '<div class="row"><strong>' + esc(row.swarm_id) + '</strong><span class="chip">' + esc(row.status) + '</span>' + (row.verify_status ? '<span class="chip">verify ' + esc(row.verify_status) + '</span>' : '') + '</div>' +
          '<div class="goal">' + esc(row.goal_summary || row.goal || 'Untitled swarm') + '</div>' +
          '<div class="meta"><span>' + esc(row.current_phase || 'unknown phase') + '</span><span>Updated ' + esc(ago(row.updated_at)) + '</span></div>' +
          '<div class="chips">' +
            '<span class="chip">Tasks ' + esc(row.task_counts.total) + '</span>' +
            '<span class="chip">Open ' + esc(row.task_counts.open) + '</span>' +
            '<span class="chip">Discussion ' + esc(row.discussion_counts.total) + '</span>' +
            warn +
          '</div>' +
        '</button>'
      }).join('')

      items.querySelectorAll('[data-status]').forEach((node) => {
        node.addEventListener('click', () => setStatus(node.getAttribute('data-status')))
      })
      items.querySelectorAll('[data-id]').forEach((node) => {
        node.addEventListener('click', () => pick(node.getAttribute('data-id')))
      })
    }

    const renderDetail = () => {
      if (!state.id) {
        detail.innerHTML = '<div class="panel"><div class="label">Overview</div><div class="value">Select a swarm to inspect tasks, agents, discussions, and recent signals.</div></div>'
        return
      }
      detail.innerHTML = '<div class="panel"><div class="label">Loading</div><div class="value">Fetching swarm detail for <span class="mono">' + esc(state.id) + '</span>...</div></div>'
    }

    const renderActions = (list) => {
      if (!list.length) return '<div class="empty">No recent actions.</div>'
      return list.slice(0, 8).map((item) =>
        '<div class="panel"><div class="row"><strong>' + esc(item.actor || 'system') + '</strong><span class="muted">' + esc(ago(item.at)) + '</span></div><div class="value">' + esc(item.summary || item.kind || 'Action') + '</div></div>'
      ).join('')
    }

    const renderTasks = (list) => {
      if (!list.length) return '<div class="empty">No tasks matched the current filters.</div>'
      return list.slice(0, 12).map((item) =>
        '<div class="panel"><div class="row"><strong>' + esc(item.id) + '</strong><span class="chip">' + esc(item.status) + '</span></div><div class="goal">' + esc(item.subject || 'Untitled task') + '</div><div class="meta"><span>' + esc(item.type || 'unknown type') + '</span><span>' + esc(item.assignee || 'unassigned') + '</span></div></div>'
      ).join('')
    }

    const renderAgents = (list) => {
      if (!list.length) return '<div class="empty">No agents recorded.</div>'
      return list.map((item) =>
        '<div class="panel"><div class="row"><strong>' + esc(item.label || item.id) + '</strong><span class="chip">' + esc(item.kind || 'agent') + '</span></div><div class="meta"><span>' + esc(item.session_id || 'no session') + '</span><span>' + esc(item.status || 'unknown') + '</span></div><div class="value">' + esc(item.summary || '') + '</div></div>'
      ).join('')
    }

    const renderSignals = (list) => {
      if (!list.length) return '<div class="empty">No recent signals.</div>'
      return list.slice(0, 10).map((item) =>
        '<div class="panel"><div class="row"><strong>' + esc(item.kind || 'signal') + '</strong><span class="muted">' + esc(ago(item.at)) + '</span></div><div class="value">' + esc(item.summary || '') + '</div></div>'
      ).join('')
    }

    const perform = async (kind) => {
      if (!state.id || state.busy) return
      if (kind === 'stop' && !window.confirm('Stop this swarm?')) return
      if (kind === 'archive' && !window.confirm('Archive this swarm? This hides it from default lists without deleting board data.')) return
      if (kind === 'purge' && !window.confirm('Purge this archived swarm? This permanently deletes its board data.')) return
      state.busy = true
      renderDetail()
      try {
        const res = await fetch('/swarm/' + encodeURIComponent(state.id) + '/' + kind, { method: 'POST' })
        if (!res.ok) throw new Error('request failed')
        await loadRows()
      } catch {
        window.alert('Unable to ' + kind + ' this swarm.')
      } finally {
        state.busy = false
        if (state.id) loadDetail(state.id)
      }
    }

    const loadRows = async () => {
      const query = new URLSearchParams()
      if (state.status !== 'all') query.set('status', state.status)
      if (state.status === 'archived') query.set('include_deleted', 'true')
      const res = await fetch('/swarm/admin?' + query.toString())
      state.rows = await res.json()
      if (state.id && !state.rows.find((row) => row.swarm_id === state.id)) {
        state.id = state.rows[0]?.swarm_id || ''
        syncUrl()
      }
      renderList()
      if (!state.id && state.rows.length) pick(state.rows[0].swarm_id)
      if (state.id) loadDetail(state.id)
      if (!state.rows.length) renderDetail()
    }

    const loadDetail = async (id) => {
      const query = state.status === 'archived' ? '?include_deleted=true' : ''
      const res = await fetch('/swarm/' + encodeURIComponent(id) + '/admin' + query)
      if (!res.ok) {
        detail.innerHTML = '<div class="panel"><div class="label">Error</div><div class="value">Unable to load swarm detail.</div></div>'
        return
      }
      const data = await res.json()
      const overview = data.overview || {}
      const actions =
        '<div class="toolbar">' +
          (canStop(overview.status) ? '<button class="btn warn" data-act="stop"' + (state.busy ? ' disabled' : '') + '>Stop Swarm</button>' : '') +
          (!overview.archived_at && canArchive(overview.status) ? '<button class="btn" data-act="archive"' + (state.busy ? ' disabled' : '') + '>Archive Swarm</button>' : '') +
          (overview.archived_at ? '<button class="btn" data-act="unarchive"' + (state.busy ? ' disabled' : '') + '>Unarchive</button>' : '') +
          (overview.archived_at ? '<button class="btn danger" data-act="purge"' + (state.busy ? ' disabled' : '') + '>Purge Swarm</button>' : '') +
        '</div>'
      detail.innerHTML =
        '<div class="panel">' +
          '<div class="row"><h2 class="title" style="margin:0">' + esc(overview.goal_summary || overview.goal || data.goal || id) + '</h2><span class="chip">' + esc(overview.status || 'unknown') + '</span>' + (overview.verify_status ? '<span class="chip">verify ' + esc(overview.verify_status) + '</span>' : '') + '</div>' +
          '<div class="meta"><span>' + esc(id) + '</span><span>' + esc(overview.current_phase || data.current_phase || 'unknown phase') + '</span><span>Updated ' + esc(ago(overview.updated_at)) + '</span></div>' +
          '<div class="chips">' +
            '<span class="chip">Conductor ' + esc(overview.conductor_label || 'unknown') + '</span>' +
            '<span class="chip">Attention ' + esc((overview.attention || []).length) + '</span>' +
            '<span class="chip">Tasks ' + esc((overview.task_counts || {}).total || 0) + '</span>' +
            '<span class="chip">Discussions ' + esc((overview.discussion_counts || {}).total || 0) + '</span>' +
          '</div>' +
          actions +
        '</div>' +
        '<div class="grid">' +
          '<div class="panel"><div class="label">Goal</div><div class="value">' + esc(data.goal || overview.goal || '') + '</div></div>' +
          '<div class="panel"><div class="label">Plan Summary</div><div class="value">' + esc(data.plan_summary || 'No plan summary recorded.') + '</div></div>' +
          '<div class="panel"><div class="label">Risk Summary</div><div class="value">' + esc(data.risk_summary || 'No active risks recorded.') + '</div></div>' +
          '<div class="panel"><div class="label">Last Decision</div><div class="value">' + esc(ago(data.last_decision_at)) + '</div></div>' +
        '</div>' +
        '<div class="section"><div style="flex:1; min-width:280px"><div class="label">Recent Actions</div>' + renderActions(data.actions || []) + '</div><div style="flex:1; min-width:280px"><div class="label">Recent Signals</div>' + renderSignals(data.recent_signals || []) + '</div></div>' +
        '<div class="stack"><div><div class="label">Tasks</div>' + renderTasks(data.tasks || []) + '</div><div><div class="label">Agents</div>' + renderAgents(data.agents || []) + '</div></div>'

      detail.querySelectorAll('[data-act]').forEach((node) => {
        node.addEventListener('click', () => perform(node.getAttribute('data-act')))
      })
    }

    refresh.addEventListener('click', () => loadRows())
    clear.addEventListener('click', () => pick(''))
    loadRows().catch(() => {
      items.innerHTML = '<div class="empty">Unable to load swarm overview.</div>'
      detail.innerHTML = '<div class="panel"><div class="label">Error</div><div class="value">The Swarm admin UI failed to load.</div></div>'
    })
  </script>
</body>
</html>`

export const SwarmRoutes = lazy(() =>
  new Hono()
    .get(
      "/app",
      describeRoute({
        summary: "Swarm admin UI",
        description: "Serve the Swarm admin web interface.",
        operationId: "swarm.app",
      }),
      (c) => {
        return c.html(APP_HTML)
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Launch a Swarm",
        description: "Launch a new multi-agent Swarm to accomplish a goal.",
        operationId: "swarm.launch",
        responses: {
          200: {
            description: "Swarm launched",
            content: { "application/json": { schema: resolver(Swarm.Info) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          goal: z.string(),
          dedupe_key: z.string().optional(),
          config: z
            .object({
              max_workers: z.number().optional(),
              auto_escalate: z.boolean().optional(),
              verify_on_complete: z.boolean().optional(),
            })
            .optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const info = await Swarm.launch({ goal: body.goal, config: body.config, dedupe_key: body.dedupe_key })
        return c.json(info)
      },
    )
    .post(
      "/discuss",
      describeRoute({
        summary: "Launch a discussion Swarm",
        description: "Launch a discussion-focused Swarm where role-specific agents debate a topic.",
        operationId: "swarm.discuss",
        responses: {
          200: {
            description: "Discussion Swarm launched",
            content: { "application/json": { schema: resolver(Swarm.Info) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          topic: z.string(),
          roles: z.array(
            z.object({
              name: z.string(),
              perspective: z.string(),
            }),
          ),
          max_rounds: z.number().optional(),
          config: z
            .object({
              max_workers: z.number().optional(),
              auto_escalate: z.boolean().optional(),
              verify_on_complete: z.boolean().optional(),
            })
            .optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const info = await Swarm.discuss({
          topic: body.topic,
          roles: body.roles,
          max_rounds: body.max_rounds,
          config: body.config,
        })
        return c.json(info)
      },
    )
    .get(
      "/admin",
      describeRoute({
        summary: "List Swarm admin overview rows",
        description: "Get aggregated Swarm overview rows for the admin UI.",
        operationId: "swarm.admin.list",
        responses: {
          200: {
            description: "Overview rows",
            content: { "application/json": { schema: resolver(SwarmAdmin.Overview.array()) } },
          },
        },
      }),
      validator(
        "query",
        z.object({
          status: z.string().optional(),
          include_deleted: flag,
          needs_attention: flag,
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const rows = await SwarmAdmin.list({
          status: query.status,
          include_deleted: query.include_deleted,
          needs_attention: query.needs_attention,
        })
        return c.json(rows)
      },
    )
    .get(
      "/",
      describeRoute({
        summary: "List Swarms",
        description: "Get a list of all Swarms.",
        operationId: "swarm.list",
        responses: {
          200: {
            description: "List of swarms",
            content: { "application/json": { schema: resolver(Swarm.Info.array()) } },
          },
        },
      }),
      validator(
        "query",
        z.object({
          include_deleted: flag,
        }),
      ),
      async (c) => {
        const swarms = await Swarm.list({ include_deleted: c.req.valid("query").include_deleted })
        return c.json(swarms)
      },
    )
    .get(
      "/:id",
      describeRoute({
        summary: "Get Swarm status",
        description: "Get the current status of a Swarm.",
        operationId: "swarm.status",
        responses: {
          200: {
            description: "Swarm status",
            content: { "application/json": { schema: resolver(Swarm.Info) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator(
        "query",
        z.object({
          include_deleted: flag,
        }),
      ),
      async (c) => {
        const info = await Swarm.status(c.req.valid("param").id, {
          include_deleted: c.req.valid("query").include_deleted,
        })
        return c.json(info)
      },
    )
    .get(
      "/:id/admin",
      describeRoute({
        summary: "Get Swarm admin detail",
        description: "Get an aggregated Swarm detail read model for the admin UI.",
        operationId: "swarm.admin.detail",
        responses: {
          200: {
            description: "Swarm admin detail",
            content: { "application/json": { schema: resolver(SwarmAdmin.Detail) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator(
        "query",
        z.object({
          include_deleted: flag,
          assignee: z.string().optional(),
          status: z.string().optional(),
          type: z.string().optional(),
        }),
      ),
      async (c) => {
        const id = c.req.valid("param").id
        const query = c.req.valid("query")
        const info = await SwarmAdmin.get(id, {
          include_deleted: query.include_deleted,
          assignee: query.assignee,
          status: query.status,
          type: query.type,
        })
        return c.json(info)
      },
    )
    .get(
      "/:id/alignment",
      describeRoute({
        summary: "Get Swarm alignment state",
        description: "Get the swarm alignment read model for CLI and web consumers.",
        operationId: "swarm.alignment",
        responses: {
          200: {
            description: "Swarm alignment state",
            content: { "application/json": { schema: resolver(SwarmAdmin.Alignment) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator(
        "query",
        z.object({
          include_deleted: flag,
        }),
      ),
      async (c) => {
        const info = await SwarmAdmin.readAlignment(c.req.valid("param").id, {
          include_deleted: c.req.valid("query").include_deleted,
        })
        return c.json(info)
      },
    )
    .post(
      "/:id/alignment/approve-role",
      describeRoute({
        summary: "Approve alignment role changes",
        description: "Approve role deltas for the current run and write approved changes back to the catalog.",
        operationId: "swarm.alignment.approveRole",
        responses: {
          200: {
            description: "Updated swarm alignment state",
            content: { "application/json": { schema: resolver(alignmentWrite) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator(
        "json",
        z.object({
          actor: z.string(),
          roles: z.array(z.string()).optional(),
        }),
      ),
      async (c) => {
        const id = c.req.valid("param").id
        const body = c.req.valid("json")
        const swarm = await Swarm.approveRoles(id, body)
        const alignment = await SwarmAdmin.readAlignment(id)
        return c.json({ swarm, alignment })
      },
    )
    .post(
      "/:id/alignment/confirm-run",
      describeRoute({
        summary: "Confirm current swarm run",
        description: "Record run-level confirmation and resume a paused alignment gate when allowed.",
        operationId: "swarm.alignment.confirmRun",
        responses: {
          200: {
            description: "Updated swarm alignment state",
            content: { "application/json": { schema: resolver(alignmentWrite) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator(
        "json",
        z.object({
          actor: z.string(),
        }),
      ),
      async (c) => {
        const id = c.req.valid("param").id
        const swarm = await Swarm.confirm(id, c.req.valid("json"))
        const alignment = await SwarmAdmin.readAlignment(id)
        return c.json({ swarm, alignment })
      },
    )
    .post(
      "/:id/intervene",
      describeRoute({
        summary: "Send message to Swarm",
        description: "Send a message to the Conductor of a running Swarm.",
        operationId: "swarm.intervene",
        responses: {
          200: { description: "Message sent" },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("json", z.object({ message: z.string() })),
      async (c) => {
        await Swarm.intervene(c.req.valid("param").id, c.req.valid("json").message)
        return c.json(true)
      },
    )
    .post(
      "/:id/pause",
      describeRoute({
        summary: "Pause Swarm",
        description: "Pause all workers in a Swarm.",
        operationId: "swarm.pause",
        responses: {
          200: {
            description: "Swarm paused",
            content: { "application/json": { schema: resolver(Swarm.Info) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const info = await Swarm.pause(c.req.valid("param").id)
        return c.json(info)
      },
    )
    .post(
      "/:id/resume",
      describeRoute({
        summary: "Resume Swarm",
        description: "Resume a paused Swarm.",
        operationId: "swarm.resume",
        responses: {
          200: {
            description: "Swarm resumed",
            content: { "application/json": { schema: resolver(Swarm.Info) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const info = await Swarm.resume(c.req.valid("param").id)
        return c.json(info)
      },
    )
    .post(
      "/:id/stop",
      describeRoute({
        summary: "Stop Swarm",
        description: "Stop a Swarm and cancel all workers.",
        operationId: "swarm.stop",
        responses: {
          200: {
            description: "Swarm stopped",
            content: { "application/json": { schema: resolver(Swarm.Info) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const info = await Swarm.stop(c.req.valid("param").id)
        return c.json(info)
      },
    )
    .post(
      "/:id/archive",
      describeRoute({
        summary: "Archive Swarm",
        description: "Hide a finished Swarm from default lists without deleting board data.",
        operationId: "swarm.archive",
        responses: {
          200: {
            description: "Swarm archived",
            content: { "application/json": { schema: resolver(Swarm.Info) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const info = await Swarm.remove(c.req.valid("param").id)
        return c.json(info)
      },
    )
    .post(
      "/:id/delete",
      describeRoute({
        summary: "Archive Swarm (legacy alias)",
        description: "Legacy alias for archiving a finished Swarm without deleting board data.",
        operationId: "swarm.delete",
        responses: {
          200: {
            description: "Swarm deleted",
            content: { "application/json": { schema: resolver(Swarm.Info) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const info = await Swarm.remove(c.req.valid("param").id)
        return c.json(info)
      },
    )
    .post(
      "/:id/unarchive",
      describeRoute({
        summary: "Unarchive Swarm",
        description: "Restore an archived Swarm to the default lists.",
        operationId: "swarm.unarchive",
        responses: {
          200: {
            description: "Swarm unarchived",
            content: { "application/json": { schema: resolver(Swarm.Info) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const info = await Swarm.unarchive(c.req.valid("param").id)
        return c.json(info)
      },
    )
    .post(
      "/:id/purge",
      describeRoute({
        summary: "Purge Swarm",
        description: "Permanently remove a terminal archived Swarm after all active work is gone.",
        operationId: "swarm.purge",
        responses: {
          200: { description: "Swarm purged" },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        await Swarm.purge(c.req.valid("param").id)
        return c.json(true)
      },
    )
    .get(
      "/:id/discussion",
      describeRoute({
        summary: "Get discussion state",
        description: "Get the structured discussion state for a Swarm in discussion mode.",
        operationId: "swarm.discussion",
        responses: {
          200: { description: "Discussion state" },
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const id = c.req.valid("param").id
        const tasks = await BoardTask.list(id)
        const task = tasks.find((t) => t.type === "discuss")
        if (!task) return c.json({ topic: null })
        const channel = (task.metadata.channel as string) ?? task.scope[0]
        if (!channel) return c.json({ topic: task.subject, channel: null })
        const [round, thread, artifacts] = await Promise.all([
          Discussion.status(id, channel),
          BoardSignal.thread(id, channel),
          BoardArtifact.list({ swarm_id: id, type: "decision" }),
        ])
        const decision = artifacts.length > 0 ? artifacts[artifacts.length - 1]!.content : null
        return c.json({
          topic: task.subject,
          channel,
          round: round
            ? {
                current: round.round,
                max: round.max_rounds,
                complete: round.complete,
              }
            : null,
          participants: round
            ? round.expected.map((name) => ({
                name,
                spoken: round.received.includes(name),
              }))
            : [],
          thread: thread.map((s) => ({
            round: s.payload.round,
            from: s.from,
            type: s.type,
            summary: s.payload.summary,
          })),
          decision,
        })
      },
    )
    .get(
      "/:id/events",
      describeRoute({
        summary: "Swarm event stream",
        description: "SSE stream of real-time Swarm events.",
        operationId: "swarm.events",
        responses: {
          200: {
            description: "Event stream",
            content: { "text/event-stream": {} },
          },
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const swarm = c.req.valid("param").id
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")
        return streamSSE(c, async (stream) => {
          const subs: Array<() => void> = []

          function send(type: "snapshot" | "transition", payload: unknown) {
            stream.writeSSE({
              data: JSON.stringify({ type, payload, timestamp: Date.now() }),
            })
          }

          const snapshot = await SwarmState.read(swarm)
          if (snapshot) send("snapshot", snapshot)

          subs.push(
            Bus.subscribe(SwarmState.Event.Transition, (evt) => {
              if (evt.properties.swarm_id === swarm) {
                send("transition", evt.properties)
              }
            }),
          )

          await new Promise<void>((resolve) => {
            stream.onAbort(() => {
              for (const unsub of subs) unsub()
              resolve()
            })
          })
        })
      },
    ),
)

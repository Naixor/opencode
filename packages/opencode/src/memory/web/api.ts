import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Memory } from "../memory"
import { MemoryDecay } from "../optimizer/decay"
import { MemoryConfirmation } from "../engine/confirmation"
import { Config } from "@/config/config"
import { lazy } from "@/util/lazy"

import APP_HTML from "./app.html" with { type: "text" }

export const MemoryRoutes = lazy(() =>
  new Hono()
    // Serve the Memory Manager UI
    .get(
      "/app",
      describeRoute({
        summary: "Memory Manager UI",
        description: "Serve the Memory Manager web interface.",
        operationId: "memory.app",
      }),
      (c) => {
        return c.html(APP_HTML as unknown as string)
      },
    )

    // Stats (must come before /:id to avoid route shadowing)
    .get(
      "/stats",
      describeRoute({
        summary: "Memory statistics",
        description: "Get memory count, capacity, and category breakdown.",
        operationId: "memory.stats",
      }),
      async (c) => {
        const config = await Config.get()
        const limit = config.memory?.injectPoolLimit ?? 200
        const all = await Memory.list()
        const personal = all.filter((m) => m.scope === "personal")
        const team = all.filter((m) => m.scope === "team")
        const pending = all.filter((m) => m.status === "pending")

        const breakdown: Record<string, number> = {}
        for (const m of all) {
          breakdown[m.category] = (breakdown[m.category] || 0) + 1
        }

        return c.json({
          total: all.length,
          personal: personal.length,
          team: team.length,
          pending: pending.length,
          confirmed: all.length - pending.length,
          poolLimit: limit,
          categoryBreakdown: breakdown,
        })
      },
    )

    // Run maintenance
    .post(
      "/maintain",
      describeRoute({
        summary: "Run maintenance",
        description: "Trigger decay update and pending confirmation check.",
        operationId: "memory.maintain",
      }),
      async (c) => {
        const result = await MemoryDecay.maintain()
        const confirmed = await MemoryConfirmation.checkPendingMemories()
        return c.json({
          ...result,
          confirmed,
        })
      },
    )

    // Batch delete (must come before /:id)
    .post(
      "/batch-delete",
      describeRoute({
        summary: "Batch delete memories",
        operationId: "memory.batchDelete",
      }),
      validator(
        "json",
        z.object({
          ids: z.array(z.string()),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const deleted = await Memory.batchRemove(body.ids)
        return c.json({ deleted, total: body.ids.length })
      },
    )

    // List memories with optional filters
    .get(
      "/",
      describeRoute({
        summary: "List memories",
        description: "Get all memories with optional filtering.",
        operationId: "memory.list",
        responses: {
          200: {
            description: "List of memories",
            content: {
              "application/json": {
                schema: resolver(Memory.Info.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          scope: Memory.Scope.optional(),
          category: Memory.Category.optional(),
          status: Memory.Status.optional(),
          method: z.enum(["auto", "manual", "promoted", "pulled"]).optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const memories = await Memory.list({
          scope: query.scope,
          category: query.category,
          status: query.status,
          method: query.method,
        })
        return c.json(memories.sort((a, b) => b.score - a.score))
      },
    )

    // Get single memory
    .get(
      "/:id",
      describeRoute({
        summary: "Get memory",
        description: "Get a single memory by ID.",
        operationId: "memory.get",
        responses: {
          200: {
            description: "Memory details",
            content: {
              "application/json": {
                schema: resolver(Memory.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        const memory = await Memory.get(c.req.param("id"))
        if (!memory) return c.json({ error: "not found" }, 404)
        return c.json(memory)
      },
    )

    // Update memory
    .put(
      "/:id",
      describeRoute({
        summary: "Update memory",
        description: "Update a memory's content, tags, category, or status.",
        operationId: "memory.update",
      }),
      validator(
        "json",
        z.object({
          content: z.string().optional(),
          category: Memory.Category.optional(),
          tags: z.array(z.string()).optional(),
          status: Memory.Status.optional(),
          inject: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const patch = c.req.valid("json")
        const updated = await Memory.update(c.req.param("id"), patch)
        if (!updated) return c.json({ error: "not found" }, 404)
        return c.json(updated)
      },
    )

    // Delete memory
    .delete(
      "/:id",
      describeRoute({
        summary: "Delete memory",
        description: "Delete a memory by ID.",
        operationId: "memory.delete",
      }),
      async (c) => {
        const result = await Memory.remove(c.req.param("id"))
        if (!result) return c.json({ error: "not found" }, 404)
        return c.json({ ok: true })
      },
    ),
)

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

export const SwarmRoutes = lazy(() =>
  new Hono()
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
        const info = await Swarm.launch({ goal: body.goal, config: body.config })
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
      async (c) => {
        const swarms = await Swarm.list()
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
      async (c) => {
        const info = await Swarm.status(c.req.valid("param").id)
        return c.json(info)
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

          function send(type: string, payload: unknown) {
            stream.writeSSE({
              data: JSON.stringify({ type, payload, timestamp: Date.now() }),
            })
          }

          subs.push(
            Bus.subscribe(BoardTask.Event.Updated, (evt) => {
              if (evt.properties.task.swarm_id === swarm) send("task.updated", evt.properties)
            }),
          )
          subs.push(
            Bus.subscribe(BoardArtifact.Event.Created, (evt) => {
              if (evt.properties.artifact.swarm_id === swarm) send("artifact.created", evt.properties)
            }),
          )
          subs.push(
            Bus.subscribe(BoardSignal.Event.Signal, (evt) => {
              if (evt.properties.signal.swarm_id === swarm) send("signal", evt.properties)
            }),
          )
          subs.push(
            Bus.subscribe(Swarm.Event.Updated, (evt) => {
              if (evt.properties.swarm.id === swarm) send("swarm.updated", evt.properties)
            }),
          )
          subs.push(
            Bus.subscribe(Swarm.Event.Completed, (evt) => {
              if (evt.properties.swarm.id === swarm) {
                send("swarm.completed", evt.properties)
                stream.close()
              }
            }),
          )
          subs.push(
            Bus.subscribe(Swarm.Event.Failed, (evt) => {
              if (evt.properties.swarm.id === swarm) {
                send("swarm.failed", evt.properties)
                stream.close()
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

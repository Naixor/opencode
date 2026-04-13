import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { DeliveryStore } from "../../src/delivery/store"
import { Instance } from "../../src/project/instance"
import { SwarmRoutes } from "../../src/server/routes/swarm"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
})

async function withInstance(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true, config: {} })
  await Instance.provide({
    directory: tmp.path,
    fn,
  })
}

function app() {
  return new Hono().route("/swarm", SwarmRoutes())
}

describe("swarm delivery route", () => {
  test("serves the authoritative delivery read model", async () => {
    await withInstance(async () => {
      const server = app()
      const seed = DeliveryStore.launch({
        id: "SW-1",
        goal: "Ship delivery read routes",
        owner_session_id: "SE-1",
      })
      const plan = seed.items.find((item) => item.phase_gate === "plan")
      if (!plan) throw new Error("Expected plan item")
      const impl = seed.items.find((item) => item.phase_gate === "implement")
      if (!impl) throw new Error("Expected implement item")

      DeliveryStore.updateItem(plan.id, { status: "in_progress" })
      DeliveryStore.updateItem(plan.id, { status: "verifying" })
      DeliveryStore.updateItem(plan.id, { status: "completed" })
      DeliveryStore.updateRun(seed.run.id, { phase: "implement" })
      DeliveryStore.updateItem(impl.id, { status: "in_progress" })
      DeliveryStore.createItem({
        id: "SW-1:verify-extra",
        swarm_run_id: seed.run.id,
        title: "Verify split scope",
        status: "verifying",
        owner_role_id: "verifier",
        blocked_by: [impl.id],
        scope: ["packages/opencode/src/server/routes/swarm.ts"],
        phase_gate: "verify",
        verification: {
          status: "running",
          required: true,
          commands: ["bun test"],
          result: null,
          updated_at: null,
        },
        small_mr_required: true,
      })
      DeliveryStore.createDecision({
        id: "DE-1",
        kind: "role_change",
        summary: "Confirm the reassignment",
        source: "alignment",
        status: "proposed",
        requires_user_confirmation: true,
        applies_to: [seed.run.id, impl.id],
        related_question_id: "OQ-1",
      })
      DeliveryStore.createQuestion({
        id: "OQ-1",
        title: "Approve the reassignment",
        context: "The implementation lane needs a new owner",
        options: ["confirm", "reject"],
        recommended_option: "confirm",
        status: "waiting_user",
        deadline_policy: "manual",
        blocking: true,
        affects: [seed.run.id, impl.id],
        related_decision_id: "DE-1",
        raised_by: "conductor",
      })

      const res = await server.request(`/swarm/${seed.run.id}/delivery`)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.run.id).toBe(seed.run.id)
      expect(body.gate.status).toBe("blocked")
      expect(body.decisions.map((item: { id: string }) => item.id)).toContain("DE-1")
      expect(body.questions.map((item: { id: string }) => item.id)).toContain("OQ-1")
      expect(body.small_mr).toMatchObject({
        required: true,
        status: "blocked",
        active: [impl.id, "SW-1:verify-extra"],
      })
      expect(body.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "DE-1", kind: "decision" }),
          expect.objectContaining({ id: "OQ-1", kind: "question" }),
          expect.objectContaining({ id: `${seed.run.id}:small_mr`, kind: "small_mr" }),
        ]),
      )
    })
  })

  test("confirms major role changes through the delivery route", async () => {
    await withInstance(async () => {
      const server = app()
      DeliveryStore.launch({
        id: "SW-1",
        goal: "Ship delivery confirmations",
        owner_session_id: "SE-1",
      })

      DeliveryStore.requestAssignment({
        run_id: "SW-1",
        items: [{ id: "SW-1:implement", owner_role_id: "shipper" }],
        decision_id: "DE-1",
        question_id: "OQ-1",
        reason: "The shipper should own the implementation handoff",
        raised_by: "conductor",
      })

      const res = await server.request(`/swarm/SW-1/delivery/confirm-assignment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision_id: "DE-1",
          answer: "confirm",
          decided_by: "user",
          decided_at: 42,
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "DE-1",
            status: "decided",
            decided_by: "user",
            decided_at: 42,
          }),
        ]),
      )
      expect(body.questions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "OQ-1",
            status: "resolved",
            blocking: false,
          }),
        ]),
      )
      expect(body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "SW-1:implement",
            owner_role_id: "shipper",
          }),
        ]),
      )
    })
  })

  test("answers open questions through the delivery route", async () => {
    await withInstance(async () => {
      const server = app()
      DeliveryStore.launch({
        id: "SW-1",
        goal: "Ship delivery answers",
        owner_session_id: "SE-1",
      })
      DeliveryStore.updateItem("SW-1:plan", { status: "in_progress" })
      DeliveryStore.updateItem("SW-1:plan", { status: "verifying" })
      DeliveryStore.updateItem("SW-1:plan", { status: "completed" })
      DeliveryStore.updateRun("SW-1", { phase: "implement" })
      DeliveryStore.createDecision({
        id: "DE-1",
        kind: "scope_change",
        summary: "Need an answer before implementation continues",
        source: "conductor",
        status: "proposed",
        requires_user_confirmation: false,
        applies_to: ["SW-1", "SW-1:implement"],
        related_question_id: "OQ-1",
      })
      DeliveryStore.createQuestion({
        id: "OQ-1",
        title: "Clarify the implementation boundary",
        context: "The builder needs one final scope answer",
        options: ["ship_it", "revise_scope"],
        recommended_option: "ship_it",
        status: "open",
        deadline_policy: "manual",
        blocking: true,
        affects: ["SW-1", "SW-1:implement"],
        related_decision_id: "DE-1",
        raised_by: "conductor",
      })

      const res = await server.request(`/swarm/SW-1/delivery/questions/OQ-1/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ option: "ship_it" }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.questions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "OQ-1",
            status: "resolved",
            blocking: false,
            recommended_option: "ship_it",
          }),
        ]),
      )
      expect(body.decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "DE-1",
            status: "decided",
            decided_by: "system",
          }),
        ]),
      )
    })
  })

  test("defers and cancels open questions through the delivery routes", async () => {
    await withInstance(async () => {
      const server = app()
      DeliveryStore.launch({
        id: "SW-1",
        goal: "Ship delivery question actions",
        owner_session_id: "SE-1",
      })
      DeliveryStore.createDecision({
        id: "DE-1",
        kind: "scope_change",
        summary: "Revisit the verify gate boundary",
        source: "conductor",
        status: "proposed",
        requires_user_confirmation: false,
        applies_to: ["SW-1:verify"],
        related_question_id: "OQ-1",
      })
      DeliveryStore.createQuestion({
        id: "OQ-1",
        title: "Can verification wait until the next gate?",
        context: "The verifier can answer later without blocking implementation.",
        options: ["ship_it", "revise_scope"],
        recommended_option: "ship_it",
        status: "open",
        deadline_policy: "manual",
        blocking: false,
        affects: ["SW-1:verify"],
        related_decision_id: "DE-1",
        raised_by: "conductor",
      })
      DeliveryStore.createDecision({
        id: "DE-2",
        kind: "scope_change",
        summary: "Cancel the staging clarification",
        source: "conductor",
        status: "proposed",
        requires_user_confirmation: false,
        applies_to: ["SW-1", "SW-1:implement"],
        related_question_id: "OQ-2",
      })
      DeliveryStore.createQuestion({
        id: "OQ-2",
        title: "Keep the clarification open?",
        context: "This question is no longer needed.",
        options: ["keep", "drop"],
        recommended_option: "drop",
        status: "waiting_user",
        deadline_policy: "manual",
        blocking: true,
        affects: ["SW-1", "SW-1:implement"],
        related_decision_id: "DE-2",
        raised_by: "conductor",
      })

      const defer = await server.request(`/swarm/SW-1/delivery/questions/OQ-1/defer`, {
        method: "POST",
      })

      expect(defer.status).toBe(200)
      const first = await defer.json()
      expect(first.questions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "OQ-1",
            status: "deferred",
            blocking: false,
          }),
        ]),
      )
      expect(first.decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "DE-1",
            status: "superseded",
            decided_by: "system",
          }),
        ]),
      )

      const cancel = await server.request(`/swarm/SW-1/delivery/questions/OQ-2/cancel`, {
        method: "POST",
      })

      expect(cancel.status).toBe(200)
      const second = await cancel.json()
      expect(second.questions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "OQ-2",
            status: "cancelled",
            blocking: false,
          }),
        ]),
      )
      expect(second.decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "DE-2",
            status: "cancelled",
            decided_by: "system",
          }),
        ]),
      )
    })
  })
})

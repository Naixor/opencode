import path from "path"
import fs from "fs/promises"
import z from "zod"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Lock } from "@/util/lock"
import { MemoryHindsightBank } from "./bank"

export namespace MemoryHindsightState {
  export const Failure = z.object({
    memory_id: z.string(),
    document_id: z.string(),
    error: z.string(),
    at: z.number().int().nonnegative(),
  })
  export type Failure = z.infer<typeof Failure>

  export const Backfill = z.object({
    status: z.enum(["idle", "running", "paused", "completed", "failed"]).default("idle"),
    mode: z.enum(["manual", "auto"]).default("auto"),
    started_at: z.number().int().nonnegative().optional(),
    updated_at: z.number().int().nonnegative(),
    completed_at: z.number().int().nonnegative().optional(),
    cursor: z.string().optional(),
    last_memory_id: z.string().optional(),
    last_document_id: z.string().optional(),
    processed: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    batch_size: z.number().int().nonnegative(),
    operation_ids: z.array(z.string()),
    failures: z.array(Failure),
  })
  export type Backfill = z.infer<typeof Backfill>

  export const Info = z.object({
    version: z.literal(1),
    bank_id: z.string(),
    workspace_hash: z.string(),
    workspace_scope: z.enum(["worktree"]),
    updated_at: z.number().int().nonnegative(),
    backfill: Backfill,
  })
  export type Info = z.infer<typeof Info>

  function base(dir = Instance.directory) {
    return path.join(Global.Path.data, "memory", encodeURIComponent(dir))
  }

  export function filepath(dir = Instance.directory) {
    return path.join(base(dir), "hindsight.json")
  }

  function fresh(root = Instance.worktree): Info {
    return {
      version: 1,
      bank_id: MemoryHindsightBank.bankId(root),
      workspace_hash: MemoryHindsightBank.worktreeHash(root),
      workspace_scope: "worktree",
      updated_at: 0,
      backfill: {
        status: "idle",
        mode: "auto",
        updated_at: 0,
        processed: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        batch_size: 0,
        operation_ids: [],
        failures: [],
      },
    }
  }

  export function trimFailures(input: Failure[], limit = 100) {
    return input.slice(Math.max(input.length - limit, 0))
  }

  async function read(root = Instance.worktree) {
    const file = Bun.file(filepath())
    if (!(await file.exists())) return fresh(root)
    return Info.parse(await file.json())
  }

  async function write(input: Info) {
    await fs.mkdir(base(), { recursive: true })
    const file = filepath()
    const tmp = `${file}.tmp.${Date.now()}`
    await Bun.write(tmp, JSON.stringify(input, null, 2))
    await fs.rename(tmp, file)
    return input
  }

  function shape(input: Info, now = Date.now()) {
    return Info.parse({
      ...input,
      updated_at: now,
      backfill: {
        ...input.backfill,
        updated_at: now,
        failures: trimFailures(input.backfill.failures),
      },
    })
  }

  export async function load(root = Instance.worktree) {
    using _ = await Lock.read(filepath())
    return read(root)
  }

  export async function save(input: Info) {
    using _ = await Lock.write(filepath())
    return write(shape(input))
  }

  export async function mutate(fn: (state: Info) => Info | Promise<Info>, root = Instance.worktree) {
    using _ = await Lock.write(filepath())
    return write(shape(await fn(await read(root))))
  }
}

import { HindsightClient, createClient, createConfig, sdk, type Client } from "@vectorize-io/hindsight-client"
import { Config } from "@/config/config"
import { Log } from "@/util/log"
import { withTimeout } from "@/util/timeout"
import { MemoryHindsightService } from "./service"

export namespace MemoryHindsightClient {
  const log = Log.create({ service: "memory.hindsight.client" })

  type Cfg = NonNullable<NonNullable<Awaited<ReturnType<typeof Config.get>>["memory"]>["hindsight"]>
  type Match = "any" | "all" | "any_strict" | "all_strict"
  type Budget = "low" | "mid" | "high"
  type Retain = Awaited<ReturnType<HindsightClient["retain"]>>
  type Recall = Awaited<ReturnType<HindsightClient["recall"]>>
  type Doc = NonNullable<Awaited<ReturnType<typeof sdk.getDocument>>["data"]>
  type Docs = NonNullable<Awaited<ReturnType<typeof sdk.listDocuments>>["data"]>
  type Op = NonNullable<Awaited<ReturnType<typeof sdk.getOperationStatus>>["data"]>
  type Ops = NonNullable<Awaited<ReturnType<typeof sdk.listOperations>>["data"]>

  interface Item {
    content: string
    timestamp?: string | Date
    context?: string
    metadata?: Record<string, string>
    document_id?: string
    entities?: Array<{ text: string; type?: string }>
    tags?: string[]
    observation_scopes?: "per_tag" | "combined" | "all_combinations" | string[][]
    strategy?: string
    update_mode?: "replace" | "append"
  }

  interface State {
    cfg: Cfg
    raw: Client
    ready: MemoryHindsightService.Ready
  }

  export interface RetainInput {
    content: string
    timestamp?: string | Date
    context?: string
    metadata?: Record<string, string>
    document_id?: string
    entities?: Array<{ text: string; type?: string }>
    tags?: string[]
    async?: boolean
    update_mode?: "replace" | "append"
  }

  export interface BatchInput {
    items: Item[]
    document_id?: string
    document_tags?: string[]
    async?: boolean
  }

  export interface RecallInput {
    query: string
    types?: string[]
    max_tokens?: number
    budget?: Budget
    trace?: boolean
    query_timestamp?: string
    include_entities?: boolean
    max_entity_tokens?: number
    include_chunks?: boolean
    max_chunk_tokens?: number
    include_source_facts?: boolean
    max_source_facts_tokens?: number
    tags?: string[]
    tags_match?: Match
  }

  export interface DocInput {
    document_id: string
  }

  export interface DocsInput {
    q?: string
    tags?: string[]
    tags_match?: Match
    limit?: number
    offset?: number
  }

  export interface OpInput {
    operation_id: string
  }

  export interface OpsInput {
    status?: string
    type?: string
    limit?: number
    offset?: number
  }

  function text(err: unknown) {
    return err instanceof Error ? err.message : String(err)
  }

  function ms(cfg: Cfg) {
    return cfg.query_timeout_ms ?? 5_000
  }

  function data<T>(op: string, result: { data?: T; error?: unknown }) {
    if (result.data) return result.data
    throw new Error(`${op} failed: ${text(result.error)}`)
  }

  function fail(op: string, bank_id: string, err: unknown) {
    log.warn("hindsight client call failed", {
      op,
      bank_id,
      error: text(err),
    })
  }

  async function ready(): Promise<State | undefined> {
    const cfg = await Config.get()
    const opts = cfg.memory?.hindsight
    if (!opts?.enabled) return
    return MemoryHindsightService.ready().then((result) => {
      if (!result) return
      return {
        cfg: opts,
        ready: result,
        raw: createClient(createConfig({ baseUrl: result.base_url })),
      }
    })
  }

  async function run<T>(op: string, fn: (state: State) => Promise<T>): Promise<T | undefined> {
    const state = await ready()
    if (!state) return
    return withTimeout(fn(state), ms(state.cfg)).catch((err) => {
      fail(op, state.ready.bank_id, err)
      return undefined
    })
  }

  export function retain(input: RetainInput): Promise<Retain | undefined> {
    return run("retain", (state) =>
      state.ready.client.retain(state.ready.bank_id, input.content, {
        timestamp: input.timestamp,
        context: input.context,
        metadata: input.metadata,
        documentId: input.document_id,
        entities: input.entities,
        tags: input.tags,
        async: input.async,
        updateMode: input.update_mode,
      }),
    )
  }

  export function retainBatch(input: BatchInput): Promise<Retain | undefined> {
    return run("retainBatch", (state) =>
      state.ready.client.retainBatch(state.ready.bank_id, input.items, {
        documentId: input.document_id,
        documentTags: input.document_tags,
        async: input.async,
      }),
    )
  }

  export function recall(input: RecallInput): Promise<Recall | undefined> {
    return run("recall", (state) =>
      state.ready.client.recall(state.ready.bank_id, input.query, {
        types: input.types,
        maxTokens: input.max_tokens,
        budget: input.budget,
        trace: input.trace,
        queryTimestamp: input.query_timestamp,
        includeEntities: input.include_entities,
        maxEntityTokens: input.max_entity_tokens,
        includeChunks: input.include_chunks,
        maxChunkTokens: input.max_chunk_tokens,
        includeSourceFacts: input.include_source_facts,
        maxSourceFactsTokens: input.max_source_facts_tokens,
        tags: input.tags,
        tagsMatch: input.tags_match,
      }),
    )
  }

  export function getDocument(input: DocInput): Promise<Doc | undefined> {
    return run("getDocument", (state) =>
      sdk
        .getDocument({
          client: state.raw,
          path: {
            bank_id: state.ready.bank_id,
            document_id: input.document_id,
          },
        })
        .then((result) => data("getDocument", result)),
    )
  }

  export function listDocuments(input: DocsInput = {}): Promise<Docs | undefined> {
    return run("listDocuments", (state) =>
      sdk
        .listDocuments({
          client: state.raw,
          path: {
            bank_id: state.ready.bank_id,
          },
          query: {
            q: input.q,
            tags: input.tags,
            tags_match: input.tags_match,
            limit: input.limit,
            offset: input.offset,
          },
        })
        .then((result) => data("listDocuments", result)),
    )
  }

  export function getOperation(input: OpInput): Promise<Op | undefined> {
    return run("getOperation", (state) =>
      sdk
        .getOperationStatus({
          client: state.raw,
          path: {
            bank_id: state.ready.bank_id,
            operation_id: input.operation_id,
          },
        })
        .then((result) => data("getOperation", result)),
    )
  }

  export function listOperations(input: OpsInput = {}): Promise<Ops | undefined> {
    return run("listOperations", (state) =>
      sdk
        .listOperations({
          client: state.raw,
          path: {
            bank_id: state.ready.bank_id,
          },
          query: {
            status: input.status,
            type: input.type,
            limit: input.limit,
            offset: input.offset,
          },
        })
        .then((result) => data("listOperations", result)),
    )
  }
}

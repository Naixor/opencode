import { Bus } from "../../bus"
import { Log } from "../../util/log"
import { SessionStatus } from "../status"
import { HookChain } from "./index"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryInject } from "../../memory/engine/injector"

// Lazy imports to avoid circular dependency at module load time.
// Session, SessionPrompt, and TuiEvent are resolved on first use.
let _Session: typeof import("../index").Session | undefined
let _SessionPrompt: typeof import("../prompt").SessionPrompt | undefined
let _TuiEvent: typeof import("../../cli/cmd/tui/event").TuiEvent | undefined
let _Command: typeof import("../../command").Command | undefined

async function getSession() {
  if (!_Session) _Session = (await import("../index")).Session
  return _Session
}
async function getSessionPrompt() {
  if (!_SessionPrompt) _SessionPrompt = (await import("../prompt")).SessionPrompt
  return _SessionPrompt
}
async function getTuiEvent() {
  if (!_TuiEvent) _TuiEvent = (await import("../../cli/cmd/tui/event")).TuiEvent
  return _TuiEvent
}
async function getCommand() {
  if (!_Command) _Command = (await import("../../command")).Command
  return _Command
}

export namespace RalphLoop {
  const log = Log.create({ service: "ralph-loop" })

  // --- Constants ---

  const DEFAULT_MAX_ITERATIONS = 100
  const DEFAULT_COMPLETION_PROMISE = "DONE"
  const ULTRAWORK_VERIFICATION_PROMISE = "VERIFIED"

  // --- Types ---

  export interface LoopState {
    active: boolean
    iteration: number
    maxIterations: number
    completionPromise: string
    initialCompletionPromise: string
    prompt: string
    /** The session where the loop was originally started (for UI association) */
    originSessionID: string
    /** The session currently executing (changes each iteration) */
    currentSessionID: string
    startedAt: string
    ultrawork: boolean
    verificationPending: boolean
    verificationSessionID?: string
    /** Path to the memory file in /tmp for cross-iteration context */
    memoryFile: string
  }

  export interface StartOptions {
    maxIterations?: number
    completionPromise?: string
    ultrawork?: boolean
  }

  // --- State (module-level) ---

  /** Keyed by originSessionID */
  const loops = new Map<string, LoopState>()
  /** Maps any active currentSessionID → originSessionID for idle event routing */
  const sessionToOrigin = new Map<string, string>()
  const inFlight = new Set<string>()

  // --- Prompt Templates ---

  function buildIterationPrompt(loopState: LoopState): string {
    const maxLabel = String(loopState.maxIterations)
    const prefix = loopState.ultrawork ? "ultrawork " : ""
    const memoryInstruction =
      loopState.iteration > 1
        ? `\n\nMEMORY FILE: ${loopState.memoryFile}\nRead this file FIRST to understand what previous iterations accomplished. Update it with your progress before finishing.\n`
        : `\n\nMEMORY FILE: ${loopState.memoryFile}\nThis file tracks your progress across iterations. Update it with your progress before finishing.\n`

    if (loopState.verificationPending) {
      return `${prefix}[SYSTEM DIRECTIVE - ULTRAWORK LOOP VERIFICATION ${loopState.iteration}/${maxLabel}]

You already emitted <promise>${loopState.initialCompletionPromise}</promise>. This does NOT finish the loop yet.

REQUIRED NOW:
- Call Oracle using task(subagent_type="oracle", load_skills=[], run_in_background=false, ...)
- Ask Oracle to verify whether the original task is actually complete
- Instruct Oracle to emit <promise>${ULTRAWORK_VERIFICATION_PROMISE}</promise> only if the original task is actually complete
- If Oracle does not verify completion, it must NOT emit that promise and should explain what is still missing
- The system will inspect the Oracle session directly for the verification result
- If Oracle does not verify, continue fixing the task and do not consider it complete
${memoryInstruction}
Original task:
${loopState.prompt}`
    }

    return `${prefix}[SYSTEM DIRECTIVE - RALPH LOOP ${loopState.iteration}/${maxLabel}]

You are continuing an autonomous work loop. ${loopState.iteration === 1 ? "This is the first iteration." : `This is iteration ${loopState.iteration}.`}

IMPORTANT:
- ${loopState.iteration === 1 ? "Start working on the task below" : "Read the memory file FIRST, then continue from where the previous iteration left off"}
- When FULLY complete, output: <promise>${loopState.completionPromise}</promise>
- Do not stop until the task is truly done
- Do not ask questions or wait for confirmation
${memoryInstruction}
Task:
${loopState.prompt}`
  }

  function buildVerificationFailurePrompt(loopState: LoopState): string {
    const maxLabel = String(loopState.maxIterations)
    const prefix = loopState.ultrawork ? "ultrawork " : ""

    return `${prefix}[SYSTEM DIRECTIVE - ULTRAWORK LOOP VERIFICATION FAILED ${loopState.iteration}/${maxLabel}]

Oracle did not emit <promise>VERIFIED</promise>. Verification failed.

REQUIRED NOW:
- Read the memory file FIRST: ${loopState.memoryFile}
- Verification failed. Fix the task until Oracle's review is satisfied
- Oracle does not lie. Treat the verification result as ground truth
- Do not claim completion early or argue with the failed verification
- After fixing the remaining issues, request Oracle review again using task(subagent_type="oracle", load_skills=[], run_in_background=false, ...)
- Instruct Oracle to emit <promise>${ULTRAWORK_VERIFICATION_PROMISE}</promise> only when the original task is actually complete
- Only when the work is ready for review again, output: <promise>${loopState.completionPromise}</promise>

Original task:
${loopState.prompt}`
  }

  // --- Completion Detection ---

  function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  async function detectCompletion(sessionID: string, promise: string): Promise<boolean> {
    const Session = await getSession()
    const msgs = await Session.messages({ sessionID })
    const pattern = new RegExp(`<promise>\\s*${escapeRegex(promise)}\\s*</promise>`, "is")

    for (const msg of msgs) {
      if (msg.info.role !== "assistant") continue
      let text = ""
      for (const part of msg.parts) {
        if (part.type === "text" && "text" in part) {
          text += (text ? "\n" : "") + ((part as { text?: string }).text ?? "")
        }
      }
      if (pattern.test(text)) return true
    }
    return false
  }

  async function detectVerification(sessionID: string): Promise<boolean> {
    if (await detectCompletion(sessionID, ULTRAWORK_VERIFICATION_PROMISE)) return true

    const Session = await getSession()
    const msgs = await Session.messages({ sessionID })
    const pattern = /(^|\n|\r)\s*(?:[-*]\s*)?`?VERIFIED COMPLETE`?\b/i

    for (const msg of msgs) {
      if (msg.info.role !== "assistant") continue
      let text = ""
      for (const part of msg.parts) {
        if (part.type !== "text" || !("text" in part)) continue
        text += (text ? "\n" : "") + ((part as { text?: string }).text ?? "")
      }
      if (pattern.test(text)) return true
    }

    return false
  }

  // --- Memory File ---

  function memoryPath(originSessionID: string): string {
    return join(tmpdir(), `ralph.memory.${originSessionID}.md`)
  }

  async function initMemoryFile(loopState: LoopState): Promise<void> {
    const header = `# ${loopState.ultrawork ? "Ultrawork" : "Ralph"} Loop Memory

- **Task:** ${loopState.prompt}
- **Started:** ${loopState.startedAt}
- **Session:** ${loopState.originSessionID}

---

`
    await Bun.write(loopState.memoryFile, header).catch((err: unknown) => {
      log.error("failed to create memory file", {
        path: loopState.memoryFile,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  async function appendToMemory(loopState: LoopState, label: string, sessionID: string): Promise<void> {
    const Session = await getSession()
    const msgs = await Session.messages({ sessionID })

    // msgs are newest-first; find the last assistant message
    const lastAssistant = msgs.find((m) => m.info.role === "assistant")
    if (!lastAssistant) return

    const texts: string[] = []
    for (const part of lastAssistant.parts) {
      if (part.type === "text" && "text" in part) {
        const t = (part as { text?: string }).text ?? ""
        if (t) texts.push(t)
      }
    }
    const fullText = texts.join("\n")
    const summary = fullText.length > 4000 ? fullText.slice(0, 4000) + "\n... [truncated]" : fullText

    const block = `\n## ${label}\n\n${summary}\n\n---\n`

    const existing = await Bun.file(loopState.memoryFile)
      .text()
      .catch(() => "")
    await Bun.write(loopState.memoryFile, existing + block).catch((err: unknown) => {
      log.error("failed to append to memory file", {
        path: loopState.memoryFile,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  // --- Toast Helper ---

  async function showToast(
    title: string,
    message: string,
    variant: "info" | "success" | "warning" | "error",
  ): Promise<void> {
    const TuiEvent = await getTuiEvent()
    Bus.publish(TuiEvent.ToastShow, { title, message, variant })
  }

  // --- Loop Control ---

  export async function start(sessionID: string, prompt: string, options?: StartOptions): Promise<boolean> {
    if (!registered) return false
    ensureSubscribed()

    const existing = loops.get(sessionID)
    if (existing?.active) {
      log.info("loop already active for session, overwriting", { sessionID })
      sessionToOrigin.delete(existing.currentSessionID)
    }

    const loopState: LoopState = {
      active: true,
      iteration: 1,
      maxIterations: options?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      completionPromise: options?.completionPromise ?? DEFAULT_COMPLETION_PROMISE,
      initialCompletionPromise: options?.completionPromise ?? DEFAULT_COMPLETION_PROMISE,
      prompt,
      originSessionID: sessionID,
      currentSessionID: sessionID,
      startedAt: new Date().toISOString(),
      ultrawork: options?.ultrawork ?? false,
      verificationPending: false,
      memoryFile: memoryPath(sessionID),
    }

    loops.set(sessionID, loopState)
    sessionToOrigin.set(sessionID, sessionID)

    await initMemoryFile(loopState)

    log.info("loop started", {
      sessionID,
      memoryFile: loopState.memoryFile,
      maxIterations: loopState.maxIterations,
      ultrawork: loopState.ultrawork,
      completionPromise: loopState.completionPromise,
    })

    await showToast(
      loopState.ultrawork ? "ULTRAWORK LOOP" : "Ralph Loop",
      `Loop started. Memory: ${loopState.memoryFile}`,
      "info",
    )

    return true
  }

  export async function cancel(sessionID: string): Promise<boolean> {
    const loopState = loops.get(sessionID)
    if (!loopState?.active) return false

    sessionToOrigin.delete(loopState.currentSessionID)
    loops.delete(sessionID)
    log.info("loop cancelled", { sessionID })

    await showToast("Ralph Loop", `Loop cancelled after ${loopState.iteration} iteration(s).`, "info")

    return true
  }

  export function getState(sessionID: string): LoopState | null {
    return loops.get(sessionID) ?? null
  }

  function resolve(sessionID: string): string | undefined {
    if (loops.has(sessionID)) return sessionID

    const originID = sessionToOrigin.get(sessionID)
    if (originID) return originID

    for (const [originID, loopState] of loops) {
      if (loopState.verificationSessionID === sessionID) return originID
    }
  }

  export function getStateForSession(sessionID: string): LoopState | null {
    const originID = resolve(sessionID)
    if (!originID) return null
    return loops.get(originID) ?? null
  }

  export async function cancelForSession(sessionID: string): Promise<boolean> {
    const originID = resolve(sessionID)
    if (!originID) return false
    return cancel(originID)
  }

  export function listActive(): ReadonlyArray<{ sessionID: string; iteration: number; maxIterations: number }> {
    const result: Array<{ sessionID: string; iteration: number; maxIterations: number }> = []
    for (const [, loopState] of loops) {
      if (loopState.active) {
        result.push({
          sessionID: loopState.originSessionID,
          iteration: loopState.iteration,
          maxIterations: loopState.maxIterations,
        })
      }
    }
    return result
  }

  // --- Idle Handler ---

  async function handleIdle(sessionID: string): Promise<void> {
    if (inFlight.has(sessionID)) return

    // Route: find the loop this session belongs to
    const originID = sessionToOrigin.get(sessionID)
    const loopState = originID ? loops.get(originID) : undefined

    if (!loopState?.active) {
      // Check if this session is an oracle verification session
      for (const [, ls] of loops) {
        if (ls.verificationSessionID === sessionID && ls.active) {
          if (inFlight.has(ls.originSessionID)) return
          inFlight.add(ls.originSessionID)
          try {
            await processIdle(ls, true)
          } finally {
            inFlight.delete(ls.originSessionID)
          }
          return
        }
      }
      return
    }

    // Only react when the current session goes idle
    if (loopState.currentSessionID !== sessionID) return

    inFlight.add(sessionID)
    try {
      await processIdle(loopState, false)
    } finally {
      inFlight.delete(sessionID)
    }
  }

  async function processIdle(loopState: LoopState, isOracleIdle: boolean): Promise<void> {
    const { currentSessionID } = loopState

    // Check for ultrawork verification result
    if (loopState.verificationPending) {
      if (!loopState.verificationSessionID) {
        return
      }

      const verified = await detectVerification(isOracleIdle ? loopState.verificationSessionID : currentSessionID)

      if (verified) {
        finishLoop(loopState)
        log.info("ultrawork loop verified and complete", {
          originSessionID: loopState.originSessionID,
          iteration: loopState.iteration,
        })
        await showToast(
          "ULTRAWORK LOOP COMPLETE!",
          `Task completed and verified after ${loopState.iteration} iteration(s)`,
          "success",
        )
        return
      }

      if (isOracleIdle) {
        await handleVerificationFailure(loopState)
        return
      }

      // Parent session idle while awaiting verification — wait for oracle
      return
    }

    // Check for completion promise in current session messages
    const completed = await detectCompletion(currentSessionID, loopState.completionPromise)

    if (completed) {
      await handleCompletion(loopState)
      return
    }

    // Not completed — continue iteration with a new session
    if (loopState.iteration >= loopState.maxIterations) {
      finishLoop(loopState)
      log.info("loop max iterations reached", {
        originSessionID: loopState.originSessionID,
        iteration: loopState.iteration,
      })
      await showToast(
        "Ralph Loop",
        `Max iterations (${loopState.maxIterations}) reached without completion.`,
        "warning",
      )
      return
    }

    // Append progress from current session to the memory file
    await appendToMemory(loopState, `Iteration ${loopState.iteration}`, currentSessionID)

    loopState.iteration++
    log.info("loop continuing with new session", {
      originSessionID: loopState.originSessionID,
      iteration: loopState.iteration,
    })

    await startNewIteration(loopState, buildIterationPrompt(loopState))
  }

  async function handleCompletion(loopState: LoopState): Promise<void> {
    // Ultrawork: transition to verification phase
    if (loopState.ultrawork && !loopState.verificationPending) {
      loopState.verificationPending = true
      loopState.completionPromise = ULTRAWORK_VERIFICATION_PROMISE

      // Append progress before verification session
      await appendToMemory(loopState, `Iteration ${loopState.iteration} (DONE emitted)`, loopState.currentSessionID)

      loopState.iteration++
      await startNewIteration(loopState, buildIterationPrompt(loopState), { inherit: false })

      await showToast("ULTRAWORK LOOP", "DONE detected. Oracle verification is now required.", "info")
      log.info("ultrawork verification phase started", {
        originSessionID: loopState.originSessionID,
        iteration: loopState.iteration,
      })
      return
    }

    // Normal completion (or verified ultrawork)
    finishLoop(loopState)
    const title = loopState.ultrawork ? "ULTRAWORK LOOP COMPLETE!" : "Ralph Loop Complete!"
    const message = `Task completed after ${loopState.iteration} iteration(s)`
    log.info("loop completed", { originSessionID: loopState.originSessionID, iteration: loopState.iteration })
    await showToast(title, message, "success")
  }

  async function handleVerificationFailure(loopState: LoopState): Promise<void> {
    // Append oracle feedback to memory before resetting
    if (loopState.verificationSessionID) {
      await appendToMemory(loopState, "Oracle Verification (FAILED)", loopState.verificationSessionID)
    }

    // Reset to pre-verification state
    loopState.verificationPending = false
    loopState.completionPromise = loopState.initialCompletionPromise
    loopState.verificationSessionID = undefined
    loopState.iteration++

    await startNewIteration(loopState, buildVerificationFailurePrompt(loopState), { inherit: false })

    log.info("ultrawork verification failed, continuing", {
      originSessionID: loopState.originSessionID,
      iteration: loopState.iteration,
    })
    await showToast("ULTRAWORK LOOP", "Oracle verification failed. Resuming work.", "warning")
  }

  // --- Session Management ---

  async function startNewIteration(loopState: LoopState, prompt: string, opts?: { inherit?: boolean }): Promise<void> {
    const Session = await getSession()
    const SessionPrompt = await getSessionPrompt()
    const parentID = loopState.currentSessionID

    // Remove old currentSessionID mapping
    sessionToOrigin.delete(parentID)

    // Create a fresh session for this iteration
    const newSession = await Session.create({
      parentID: loopState.originSessionID,
      title: `${loopState.ultrawork ? "ULW" : "Ralph"} Loop #${loopState.iteration}`,
    }).catch((err: unknown) => {
      log.error("failed to create iteration session", {
        originSessionID: loopState.originSessionID,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    })

    if (!newSession) {
      finishLoop(loopState)
      await showToast("Ralph Loop", "Failed to create new session. Loop stopped.", "error")
      return
    }

    const inherit = opts?.inherit ?? true
    if (inherit) {
      const copied = MemoryInject.inheritResolved(parentID, newSession.id)
      log.info("iteration memory inheritance", {
        originSessionID: loopState.originSessionID,
        parentID,
        sessionID: newSession.id,
        copied,
      })
    }

    // Update loop state to point to the new session
    loopState.currentSessionID = newSession.id
    sessionToOrigin.set(newSession.id, loopState.originSessionID)

    log.info("new iteration session created", {
      originSessionID: loopState.originSessionID,
      currentSessionID: newSession.id,
      iteration: loopState.iteration,
    })

    // Send the prompt to the new session
    await SessionPrompt.prompt({
      sessionID: newSession.id,
      parts: [{ type: "text", text: prompt }],
    }).catch((err: unknown) => {
      log.error("failed to send iteration prompt", {
        sessionID: newSession.id,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  function finishLoop(loopState: LoopState): void {
    sessionToOrigin.delete(loopState.currentSessionID)
    loops.delete(loopState.originSessionID)
  }

  // --- Track Oracle Sessions ---

  export function setVerificationSession(parentSessionID: string, oracleSessionID: string): void {
    // parentSessionID could be the originSessionID or the currentSessionID
    const originID = sessionToOrigin.get(parentSessionID) ?? parentSessionID
    const loopState = loops.get(originID)
    if (!loopState?.verificationPending) return
    loopState.verificationSessionID = oracleSessionID
    log.info("oracle verification session bound", { parentSessionID, oracleSessionID })
  }

  // --- Registration ---
  // Bus.subscribe requires Instance context, so we defer actual subscription
  // until the first session idle event is possible (i.e., until start() is called).

  let registered = false
  let unsubscribeIdle: (() => void) | undefined
  let unsubscribeCommand: (() => void) | undefined

  const RALPH_LOOP_COMMANDS = new Set(["ralph-loop", "ultrawork"])

  function ensureSubscribed(): void {
    if (unsubscribeIdle) return

    unsubscribeIdle = Bus.subscribe(SessionStatus.Event.Status, async (evt) => {
      if (evt.properties.status.type !== "idle") return
      await handleIdle(evt.properties.sessionID).catch((err: unknown) => {
        log.error("idle handler error", {
          sessionID: evt.properties.sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    })

    // Subscribe to command execution to auto-start loops from /ralph-loop and /ultrawork
    getCommand()
      .then((Command) => {
        unsubscribeCommand = Bus.subscribe(Command.Event.Executed, async (evt) => {
          if (!RALPH_LOOP_COMMANDS.has(evt.properties.name)) return
          const sessionID = evt.properties.sessionID
          const prompt = evt.properties.arguments
          const isUltrawork = evt.properties.name === "ultrawork"

          await start(sessionID, prompt, { ultrawork: isUltrawork })

          // The command already ran the first LLM turn via prompt().
          // The session may already be idle, so immediately check for completion.
          await handleIdle(sessionID).catch((err: unknown) => {
            log.error("post-command idle check error", {
              sessionID,
              error: err instanceof Error ? err.message : String(err),
            })
          })
        })
      })
      .catch((err: unknown) => {
        log.error("failed to subscribe to Command.Event.Executed", {
          error: err instanceof Error ? err.message : String(err),
        })
      })

    log.info("ralph-loop bus subscription active")
  }

  export function register(): void {
    registered = true

    // Use a session-lifecycle hook to activate Bus subscriptions once Instance context is available.
    // This ensures the /ralph-loop and /ultrawork command listeners are ready before any command fires.
    HookChain.register("ralph-loop-activator", "session-lifecycle", 999, async () => {
      ensureSubscribed()
    })

    log.info("ralph-loop registered (subscription deferred until first session event)")
  }

  export function unregister(): void {
    registered = false
    if (unsubscribeIdle) {
      unsubscribeIdle()
      unsubscribeIdle = undefined
    }
    if (unsubscribeCommand) {
      unsubscribeCommand()
      unsubscribeCommand = undefined
    }
  }

  // --- Reset (for testing) ---

  export function reset(): void {
    unregister()
    loops.clear()
    sessionToOrigin.clear()
    inFlight.clear()
  }
}

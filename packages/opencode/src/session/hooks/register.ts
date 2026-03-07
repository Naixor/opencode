import { ContextInjectionHooks } from "./context-injection"
import { DetectionCheckingHooks } from "./detection-checking"
import { ErrorRecoveryHooks } from "./error-recovery"
import { OutputManagementHooks } from "./output-management"
import { AgentEnforcementHooks } from "./agent-enforcement"
import { LLMParameterHooks } from "./llm-parameters"
import { SessionLifecycleHooks } from "./session-lifecycle"

export function registerAllHooks(): void {
  ContextInjectionHooks.register()
  DetectionCheckingHooks.register()
  ErrorRecoveryHooks.register()
  OutputManagementHooks.register()
  AgentEnforcementHooks.register()
  LLMParameterHooks.register()
  SessionLifecycleHooks.register()
}

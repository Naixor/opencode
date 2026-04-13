import { runSecurityDoctor, type SecurityDiagnostic } from "./security/doctor"
import { runDoctorChecks, type DoctorCheck } from "./sandbox/doctor"

export type DoctorLevel = "error" | "warn" | "info"

export interface DoctorItem {
  source: "sandbox" | "security"
  level: DoctorLevel
  message: string
  fix?: string
}

export function doctorFromSandbox(list: DoctorCheck[]): DoctorItem[] {
  return list.map((item) => ({
    source: "sandbox",
    level: sandboxLevel(item.status),
    message: `${item.name}: ${item.message}`,
    fix: item.fix,
  }))
}

export function doctorFromSecurity(list: SecurityDiagnostic[]): DoctorItem[] {
  return list.map((item) => ({
    source: "security",
    level: item.level,
    message: item.message,
    fix: item.fix,
  }))
}

export function doctorCount(list: DoctorItem[]) {
  return {
    error: list.filter((item) => item.level === "error").length,
    warn: list.filter((item) => item.level === "warn").length,
    info: list.filter((item) => item.level === "info").length,
  }
}

export async function runDoctor(root: string) {
  return [...doctorFromSandbox(await runDoctorChecks()), ...doctorFromSecurity(await runSecurityDoctor(root))]
}

function sandboxLevel(status: DoctorCheck["status"]): DoctorLevel {
  if (status === "fail") return "error"
  if (status === "skip") return "warn"
  return "info"
}

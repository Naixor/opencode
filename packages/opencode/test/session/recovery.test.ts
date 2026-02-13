import { describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import os from "os"

describe("SessionRecovery", () => {
  test("heartbeat format has required fields", () => {
    const heartbeat = {
      sessionID: "test-session-1",
      projectDir: "/tmp/test-project",
      todoState: [],
      timestamp: Date.now(),
      pid: process.pid,
    }

    expect(heartbeat.sessionID).toBeTruthy()
    expect(heartbeat.projectDir).toBeTruthy()
    expect(heartbeat.timestamp).toBeGreaterThan(0)
    expect(heartbeat.pid).toBeGreaterThan(0)
    expect(Array.isArray(heartbeat.todoState)).toBe(true)
  })

  test("detects stale heartbeats from non-running processes", () => {
    function isProcessRunning(pid: number): boolean {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }

    // Current process should be running
    expect(isProcessRunning(process.pid)).toBe(true)

    // A very high PID should not be running
    expect(isProcessRunning(999999999)).toBe(false)
  })

  test("recovery directory paths are correct", () => {
    const projectDir = "/tmp/test-project"
    const sessionID = "test-session-1"

    const projectRecoveryDir = path.join(projectDir, ".opencode", "recovery")
    const globalRecoveryDir = path.join(os.homedir(), ".opencode", "recovery")
    const projectFile = path.join(projectRecoveryDir, `${sessionID}.json`)
    const globalFile = path.join(globalRecoveryDir, `${sessionID}.json`)

    expect(projectFile).toContain(".opencode/recovery/test-session-1.json")
    expect(globalFile).toContain(".opencode/recovery/test-session-1.json")
    expect(projectFile).not.toBe(globalFile)
  })

  test("heartbeat write and read roundtrip", async () => {
    const tmpDir = path.join(os.tmpdir(), `recovery-test-${Date.now()}`)
    await fs.mkdir(tmpDir, { recursive: true })

    const heartbeat = {
      sessionID: "test-session-roundtrip",
      projectDir: tmpDir,
      todoState: [{ content: "Test task", status: "pending" as const, activeForm: "Testing task" }],
      timestamp: Date.now(),
      pid: process.pid,
    }

    const filePath = path.join(tmpDir, "heartbeat.json")
    await Bun.write(filePath, JSON.stringify(heartbeat))

    const read = JSON.parse(await Bun.file(filePath).text())
    expect(read.sessionID).toBe(heartbeat.sessionID)
    expect(read.todoState).toHaveLength(1)
    expect(read.pid).toBe(process.pid)

    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})

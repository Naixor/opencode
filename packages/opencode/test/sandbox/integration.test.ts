import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { SeatbeltSandbox } from "../../src/sandbox/seatbelt"
import { generateFullProfile } from "../../src/sandbox/profile"
import { getSandbox } from "../../src/sandbox"
import fs from "fs/promises"
import path from "path"
import os from "os"

const IS_MACOS = process.platform === "darwin"

let testDir: string
let allowedDir: string
let deniedDir: string
let extraDir: string

beforeAll(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-test-"))
  allowedDir = path.join(testDir, "allowed")
  deniedDir = path.join(testDir, "denied")
  extraDir = path.join(testDir, "extra")

  await fs.mkdir(allowedDir, { recursive: true })
  await fs.mkdir(deniedDir, { recursive: true })
  await fs.mkdir(extraDir, { recursive: true })

  await fs.writeFile(path.join(allowedDir, "hello.txt"), "hello from allowed")
  await fs.writeFile(path.join(deniedDir, "secret.txt"), "secret content")
  await fs.writeFile(path.join(extraDir, "bonus.txt"), "extra content")
})

afterAll(async () => {
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
})

describe("platform detection", () => {
  test("getSandbox returns Sandbox on macOS, null elsewhere", async () => {
    const sandbox = await getSandbox()
    if (IS_MACOS) {
      expect(sandbox).not.toBeNull()
    } else {
      expect(sandbox).toBeNull()
    }
  })

  test("unsupported platform gracefully degrades", async () => {
    if (!IS_MACOS) {
      expect(await getSandbox()).toBeNull()
    }
  })
})

describe.if(IS_MACOS)("sandbox-exec integration", () => {
  let sandbox: SeatbeltSandbox

  beforeAll(async () => {
    sandbox = new SeatbeltSandbox()

    const available = await sandbox.isAvailable()
    if (!available) throw new Error("sandbox-exec not available on this macOS system")

    await sandbox.generatePolicy({
      projectRoot: testDir,
      allowlist: ["allowed/**"],
      deny: [{ pattern: "denied", deniedOperations: ["read", "write"] }],
      extraPaths: [extraDir],
    })
  })

  test("sandboxed bash CAN read files in allowlist", async () => {
    const cmd = sandbox.wrap(["cat", path.join(allowedDir, "hello.txt")])
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const stdout = await new Response(proc.stdout).text()
    const code = await proc.exited
    expect(code).toBe(0)
    expect(stdout.trim()).toBe("hello from allowed")
  })

  test("sandboxed bash CAN write files in allowlist", async () => {
    const outFile = path.join(allowedDir, "output.txt")
    const cmd = sandbox.wrap(["/bin/sh", "-c", `echo "written" > ${outFile}`])
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const code = await proc.exited
    expect(code).toBe(0)
    const content = await fs.readFile(outFile, "utf-8")
    expect(content.trim()).toBe("written")
  })

  test("sandboxed bash cannot write files outside allowlist", async () => {
    const homeFile = path.join(os.homedir(), `.sandbox-test-${Date.now()}`)
    const cmd = sandbox.wrap(["/bin/sh", "-c", `echo "hack" > ${homeFile}`])
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const stderr = await new Response(proc.stderr).text()
    const code = await proc.exited
    await fs.rm(homeFile).catch(() => {})
    expect(code !== 0 || stderr.includes("Operation not permitted")).toBe(true)
  })

  test("sandboxed python cannot read denied files", async () => {
    const secretFile = path.join(deniedDir, "secret.txt")
    const cmd = sandbox.wrap([
      "python3",
      "-c",
      `open('${secretFile}').read()`,
    ])
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const stderr = await new Response(proc.stderr).text()
    const code = await proc.exited
    expect(code !== 0 || stderr.includes("Permission") || stderr.includes("deny")).toBe(true)
  })

  test("deny rule paths blocked even when parent is in allowlist", async () => {
    const cmd = sandbox.wrap(["cat", path.join(deniedDir, "secret.txt")])
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const stderr = await new Response(proc.stderr).text()
    const code = await proc.exited
    expect(code !== 0 || stderr.includes("Operation not permitted") || stderr.includes("deny")).toBe(true)
  })

  test("built-in whitelist paths accessible (tmp)", async () => {
    const tmpFile = path.join(os.tmpdir(), `sandbox-builtin-${Date.now()}.txt`)
    await fs.writeFile(tmpFile, "tmp content")
    const cmd = sandbox.wrap(["cat", tmpFile])
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const stdout = await new Response(proc.stdout).text()
    const code = await proc.exited
    await fs.rm(tmpFile).catch(() => {})
    expect(code).toBe(0)
    expect(stdout.trim()).toBe("tmp content")
  })

  test("user-configured extra paths accessible", async () => {
    const cmd = sandbox.wrap(["cat", path.join(extraDir, "bonus.txt")])
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const stdout = await new Response(proc.stdout).text()
    const code = await proc.exited
    expect(code).toBe(0)
    expect(stdout.trim()).toBe("extra content")
  })
})

describe.if(IS_MACOS)("SBPL profile generation", () => {
  test("full profile includes version header and allow default", async () => {
    const profile = await generateFullProfile({
      projectRoot: testDir,
      allowlist: [],
      deny: [],
      extraPaths: [],
    })
    expect(profile).toStartWith("(version 1)")
    expect(profile).toContain("(allow default)")
  })

  test("full profile includes global write deny", async () => {
    const profile = await generateFullProfile({
      projectRoot: testDir,
      allowlist: [],
      deny: [],
      extraPaths: [],
    })
    expect(profile).toContain(`(deny file-write* (subpath "/"))`)
  })

  test("full profile allows writes to temp directories", async () => {
    const profile = await generateFullProfile({
      projectRoot: testDir,
      allowlist: [],
      deny: [],
      extraPaths: [],
    })
    expect(profile).toContain("Temp directories")
    expect(profile).toContain("(allow file-write*")
  })

  test("full profile allows writes to /dev devices", async () => {
    const profile = await generateFullProfile({
      projectRoot: testDir,
      allowlist: [],
      deny: [],
      extraPaths: [],
    })
    expect(profile).toContain("/dev/null")
    expect(profile).toContain("/dev/urandom")
  })
})

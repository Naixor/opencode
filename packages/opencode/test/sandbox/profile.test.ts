import { test, expect, beforeAll } from "bun:test"
import { generateProfile, type ProfileInput } from "../../src/sandbox/profile"
import fs from "fs/promises"
import path from "path"

// Use a resolved path to avoid macOS /tmp → /private/tmp issues in assertions
const RAW_PROJECT_ROOT = "/tmp/test-project"
let PROJECT_ROOT = RAW_PROJECT_ROOT

beforeAll(async () => {
  // Resolve /tmp symlink so assertions match the profile output
  const resolvedTmp = await fs.realpath("/tmp").catch(() => "/tmp")
  PROJECT_ROOT = path.join(resolvedTmp, "test-project")
})

function makeInput(overrides: Partial<ProfileInput> = {}): ProfileInput {
  return {
    projectRoot: RAW_PROJECT_ROOT,
    allowlist: [],
    deny: [],
    extraPaths: [],
    ...overrides,
  }
}

test("empty allowlist produces minimal profile", async () => {
  const profile = await generateProfile(makeInput())
  expect(profile).toContain("(version 1)")
  expect(profile).toContain("(allow default)")
  expect(profile).not.toContain("file-write*")
})

test("directory glob pattern generates subpath write allow rule", async () => {
  const profile = await generateProfile(
    makeInput({
      allowlist: [{ pattern: "src/**", type: "directory" }],
    }),
  )
  expect(profile).toContain("(allow file-write*")
  expect(profile).toContain(`(subpath "${path.join(PROJECT_ROOT, "src")}")`)
})

test("file pattern generates literal write allow rule", async () => {
  const profile = await generateProfile(
    makeInput({
      allowlist: [{ pattern: "package.json", type: "file" }],
    }),
  )
  expect(profile).toContain("(allow file-write*")
  expect(profile).toContain(`(literal "${path.join(PROJECT_ROOT, "package.json")}")`)
})

test("deny directory generates subpath deny rule", async () => {
  const profile = await generateProfile(
    makeInput({
      deny: [{ pattern: "secrets", type: "directory", deniedOperations: ["read", "write"], allowedRoles: [] }],
    }),
  )
  expect(profile).toContain("(deny file-read* file-write*")
  expect(profile).toContain(`(subpath "${path.join(PROJECT_ROOT, "secrets")}")`)
})

test("deny file generates literal deny rule", async () => {
  const profile = await generateProfile(
    makeInput({
      deny: [{ pattern: ".env", type: "file", deniedOperations: ["read"], allowedRoles: [] }],
    }),
  )
  expect(profile).toContain("(deny file-read* file-write*")
  expect(profile).toContain(`(literal "${path.join(PROJECT_ROOT, ".env")}")`)
})

test("deny rules appear after allow rules", async () => {
  const profile = await generateProfile(
    makeInput({
      allowlist: [{ pattern: "src/**", type: "directory" }],
      deny: [{ pattern: "src/secret/**", type: "directory", deniedOperations: ["read"], allowedRoles: [] }],
    }),
  )
  const allowIdx = profile.indexOf("Allowlist write rules")
  const denyIdx = profile.indexOf("Deny rules")
  expect(allowIdx).toBeLessThan(denyIdx)
})

test("symlink resolution for /tmp on macOS", async () => {
  if (process.platform !== "darwin") return
  const profile = await generateProfile(
    makeInput({
      allowlist: [{ pattern: "/tmp/testdir", type: "directory" }],
    }),
  )
  // On macOS, /tmp → /private/tmp
  expect(profile).toContain("/private/tmp/testdir")
})

test("extra paths added as write allow rules", async () => {
  const profile = await generateProfile(
    makeInput({
      extraPaths: ["/custom/path"],
    }),
  )
  expect(profile).toContain("(allow file-write*")
  expect(profile).toContain(`(subpath "/custom/path")`)
})

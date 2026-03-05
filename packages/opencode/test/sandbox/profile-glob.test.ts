import { test, expect, beforeAll } from "bun:test"
import { generateProfile, type ProfileInput } from "../../src/sandbox/profile"
import fs from "fs/promises"
import path from "path"

const RAW_PROJECT_ROOT = "/tmp/test-profile-glob"
let PROJECT_ROOT = RAW_PROJECT_ROOT

beforeAll(async () => {
  const resolvedTmp = await fs.realpath("/tmp").catch(() => "/tmp")
  PROJECT_ROOT = path.join(resolvedTmp, "test-profile-glob")
  await fs.mkdir(path.join(RAW_PROJECT_ROOT, "src"), { recursive: true })
  await fs.mkdir(path.join(RAW_PROJECT_ROOT, "secrets"), { recursive: true })
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

test("deny glob pattern produces (deny ... (regex ...)) rule", async () => {
  const profile = await generateProfile(
    makeInput({
      deny: [
        {
          pattern: "**/*.key",
          type: "file",
          deniedOperations: ["read", "write"],
          allowedRoles: [],
        },
      ],
    }),
  )
  expect(profile).toContain(";; glob: **/*.key")
  expect(profile).toMatch(/\(deny file-read\* file-write\* \(regex ".*"\)\)/)
})

test("allowlist glob pattern produces (allow ... (regex ...)) rule", async () => {
  const profile = await generateProfile(
    makeInput({
      allowlist: [{ pattern: "src/**/*.ts", type: "file" }],
    }),
  )
  expect(profile).toContain(";; glob: src/**/*.ts")
  expect(profile).toMatch(/\(allow file-write\* \(regex ".*"\)\)/)
})

test("mixed concrete + glob patterns use correct filter types", async () => {
  const profile = await generateProfile(
    makeInput({
      allowlist: [
        { pattern: "src", type: "directory" },
        { pattern: "src/**/*.ts", type: "file" },
      ],
      deny: [
        {
          pattern: "secrets",
          type: "directory",
          deniedOperations: ["read", "write"],
          allowedRoles: [],
        },
        {
          pattern: "**/*.key",
          type: "file",
          deniedOperations: ["read", "write"],
          allowedRoles: [],
        },
      ],
    }),
  )
  // Concrete: literal/subpath
  expect(profile).toContain(`(subpath "${PROJECT_ROOT}/src")`)
  expect(profile).toContain(`(subpath "${PROJECT_ROOT}/secrets")`)
  // Glob: regex
  expect(profile).toContain(";; glob: src/**/*.ts")
  expect(profile).toContain(";; glob: **/*.key")
  expect(profile).toMatch(/\(regex ".*"\)/)
})

test("deny regex appears AFTER allowlist regex (last-match-wins)", async () => {
  const profile = await generateProfile(
    makeInput({
      allowlist: [{ pattern: "src/**/*.ts", type: "file" }],
      deny: [
        {
          pattern: "**/*.key",
          type: "file",
          deniedOperations: ["read", "write"],
          allowedRoles: [],
        },
      ],
    }),
  )
  const allowIdx = profile.indexOf("(allow file-write*")
  const denyIdx = profile.indexOf("(deny file-read* file-write*")
  expect(allowIdx).toBeGreaterThan(-1)
  expect(denyIdx).toBeGreaterThan(-1)
  expect(denyIdx).toBeGreaterThan(allowIdx)
})

test("deniedOperations ['read','write'] generates deny regex in profile", async () => {
  const profile = await generateProfile(
    makeInput({
      deny: [
        {
          pattern: "**/*.secret",
          type: "file",
          deniedOperations: ["read", "write"],
          allowedRoles: [],
        },
      ],
    }),
  )
  expect(profile).toContain("(deny file-read* file-write*")
})

test("deniedOperations ['llm'] generates deny regex in profile", async () => {
  const profile = await generateProfile(
    makeInput({
      deny: [
        {
          pattern: "**/*.secret",
          type: "file",
          deniedOperations: ["llm"],
          allowedRoles: [],
        },
      ],
    }),
  )
  // llm rules still produce deny entries (filtering happens in init.ts, not profile.ts)
  expect(profile).toContain("(deny file-read* file-write*")
})

test("concrete deny entry for directory uses subpath", async () => {
  const profile = await generateProfile(
    makeInput({
      deny: [
        {
          pattern: "secrets",
          type: "directory",
          deniedOperations: ["read", "write"],
          allowedRoles: [],
        },
      ],
    }),
  )
  expect(profile).toContain(`(deny file-read* file-write* (subpath "${PROJECT_ROOT}/secrets"))`)
})

test("concrete deny entry for file uses literal", async () => {
  const profile = await generateProfile(
    makeInput({
      deny: [
        {
          pattern: ".env",
          type: "file",
          deniedOperations: ["read", "write"],
          allowedRoles: [],
        },
      ],
    }),
  )
  expect(profile).toContain(`(deny file-read* file-write* (literal "${PROJECT_ROOT}/.env"))`)
})

test("glob deny regex contains valid anchored pattern", async () => {
  const profile = await generateProfile(
    makeInput({
      deny: [
        {
          pattern: "*secretchat*",
          type: "file",
          deniedOperations: ["read", "write"],
          allowedRoles: [],
        },
      ],
    }),
  )
  // Extract the regex from the profile
  const match = profile.match(/\(regex "([^"]+)"\)/)
  expect(match).not.toBeNull()
  const regex = match![1]
  expect(regex.startsWith("^")).toBe(true)
  expect(regex.endsWith("$")).toBe(true)
  // Should match a file in project root
  const re = new RegExp(regex)
  expect(re.test(`${PROJECT_ROOT}/secretchat.txt`)).toBe(true)
  // Should NOT cross directories
  expect(re.test(`${PROJECT_ROOT}/sub/secretchat.txt`)).toBe(false)
})

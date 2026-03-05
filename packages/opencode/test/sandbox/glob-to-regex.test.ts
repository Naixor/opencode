import { test, expect, beforeAll } from "bun:test"
import { isGlobPattern, globToSbplRegex } from "../../src/sandbox/glob-to-regex"
import fs from "fs/promises"
import path from "path"

const RAW_PROJECT_ROOT = "/tmp/test-glob-project"
let PROJECT_ROOT = RAW_PROJECT_ROOT

beforeAll(async () => {
  const resolvedTmp = await fs.realpath("/tmp").catch(() => "/tmp")
  PROJECT_ROOT = path.join(resolvedTmp, "test-glob-project")
  // Create test directories for realpath resolution
  await fs.mkdir(path.join(RAW_PROJECT_ROOT, "src"), { recursive: true })
})

// --- isGlobPattern tests ---

test("isGlobPattern detects *", () => {
  expect(isGlobPattern("*.key")).toBe(true)
  expect(isGlobPattern("**/*.key")).toBe(true)
  expect(isGlobPattern("*secretchat*")).toBe(true)
})

test("isGlobPattern detects ?", () => {
  expect(isGlobPattern("file?.txt")).toBe(true)
})

test("isGlobPattern detects [", () => {
  expect(isGlobPattern("file[0-9].txt")).toBe(true)
})

test("isGlobPattern detects {", () => {
  expect(isGlobPattern("*.{ts,js}")).toBe(true)
})

test("isGlobPattern returns false for concrete paths", () => {
  expect(isGlobPattern("src/config.ts")).toBe(false)
  expect(isGlobPattern("README.md")).toBe(false)
  expect(isGlobPattern("/absolute/path/file.txt")).toBe(false)
  expect(isGlobPattern("src")).toBe(false)
})

// --- globToSbplRegex tests ---

test("*secretchat* matches only project root files", async () => {
  const regex = await globToSbplRegex("*secretchat*", RAW_PROJECT_ROOT)
  const re = new RegExp(regex)
  // Should match files in project root with secretchat in name
  expect(re.test(`${PROJECT_ROOT}/secretchat.txt`)).toBe(true)
  expect(re.test(`${PROJECT_ROOT}/my-secretchat-file`)).toBe(true)
  // Should NOT match files in subdirectories (no **)
  expect(re.test(`${PROJECT_ROOT}/sub/secretchat.txt`)).toBe(false)
  expect(re.test(`${PROJECT_ROOT}/a/b/secretchat.txt`)).toBe(false)
})

test("**/*secretchat* matches files at any depth", async () => {
  const regex = await globToSbplRegex("**/*secretchat*", RAW_PROJECT_ROOT)
  const re = new RegExp(regex)
  expect(re.test(`${PROJECT_ROOT}/secretchat.txt`)).toBe(true)
  expect(re.test(`${PROJECT_ROOT}/sub/secretchat.txt`)).toBe(true)
  expect(re.test(`${PROJECT_ROOT}/a/b/c/my-secretchat-file`)).toBe(true)
})

test("**/*.key matches .key files at any depth", async () => {
  const regex = await globToSbplRegex("**/*.key", RAW_PROJECT_ROOT)
  const re = new RegExp(regex)
  expect(re.test(`${PROJECT_ROOT}/secret.key`)).toBe(true)
  expect(re.test(`${PROJECT_ROOT}/ssh/id_rsa.key`)).toBe(true)
  expect(re.test(`${PROJECT_ROOT}/a/b/c/cert.key`)).toBe(true)
  // Should NOT match .keys or .key.bak
  expect(re.test(`${PROJECT_ROOT}/file.keys`)).toBe(false)
  expect(re.test(`${PROJECT_ROOT}/file.key.bak`)).toBe(false)
})

test("src/**/*.test.ts matches .test.ts files under src at any depth", async () => {
  const regex = await globToSbplRegex("src/**/*.test.ts", RAW_PROJECT_ROOT)
  const re = new RegExp(regex)
  expect(re.test(`${PROJECT_ROOT}/src/foo.test.ts`)).toBe(true)
  expect(re.test(`${PROJECT_ROOT}/src/a/b/bar.test.ts`)).toBe(true)
  // Should NOT match outside src/
  expect(re.test(`${PROJECT_ROOT}/test/foo.test.ts`)).toBe(false)
  // Should NOT match non-.test.ts
  expect(re.test(`${PROJECT_ROOT}/src/foo.ts`)).toBe(false)
})

test("*.swift matches .swift files in project root only", async () => {
  const regex = await globToSbplRegex("*.swift", RAW_PROJECT_ROOT)
  const re = new RegExp(regex)
  expect(re.test(`${PROJECT_ROOT}/App.swift`)).toBe(true)
  expect(re.test(`${PROJECT_ROOT}/main.swift`)).toBe(true)
  // Should NOT cross directories
  expect(re.test(`${PROJECT_ROOT}/Sources/App.swift`)).toBe(false)
})

test("src/Crypto*.swift matches Crypto-prefixed .swift in src/", async () => {
  const regex = await globToSbplRegex("src/Crypto*.swift", RAW_PROJECT_ROOT)
  const re = new RegExp(regex)
  expect(re.test(`${PROJECT_ROOT}/src/CryptoUtils.swift`)).toBe(true)
  expect(re.test(`${PROJECT_ROOT}/src/CryptoKit.swift`)).toBe(true)
  // Should NOT match non-Crypto
  expect(re.test(`${PROJECT_ROOT}/src/Utils.swift`)).toBe(false)
  // Should NOT match nested dirs
  expect(re.test(`${PROJECT_ROOT}/src/sub/CryptoUtils.swift`)).toBe(false)
})

test("src/lib*/*.key matches lib-prefixed dirs under src/", async () => {
  const regex = await globToSbplRegex("src/lib*/*.key", RAW_PROJECT_ROOT)
  const re = new RegExp(regex)
  // Fixed prefix is src (lib* has wildcard, so stops)
  expect(re.test(`${PROJECT_ROOT}/src/lib-xxx/foo.key`)).toBe(true)
  expect(re.test(`${PROJECT_ROOT}/src/libcrypto/cert.key`)).toBe(true)
  // Should NOT match non-lib prefix
  expect(re.test(`${PROJECT_ROOT}/src/other/foo.key`)).toBe(false)
  // Should NOT match deeper nesting
  expect(re.test(`${PROJECT_ROOT}/src/lib-xxx/sub/foo.key`)).toBe(false)
})

test("special characters are properly escaped", async () => {
  const regex = await globToSbplRegex("src/*.config.ts", RAW_PROJECT_ROOT)
  const re = new RegExp(regex)
  // . in "config.ts" should be literal, not regex wildcard
  expect(re.test(`${PROJECT_ROOT}/src/app.config.ts`)).toBe(true)
  expect(re.test(`${PROJECT_ROOT}/src/appXconfigXts`)).toBe(false)
})

test("regex is anchored with ^ and $", async () => {
  const regex = await globToSbplRegex("*.key", RAW_PROJECT_ROOT)
  expect(regex.startsWith("^")).toBe(true)
  expect(regex.endsWith("$")).toBe(true)
})

test("output is valid POSIX ERE (no \\d, \\w etc.)", async () => {
  const regex = await globToSbplRegex("**/*.key", RAW_PROJECT_ROOT)
  // Should not contain PCRE-only escapes
  expect(regex).not.toMatch(/\\d|\\w|\\s|\\b/)
})

test("projectRoot joining produces absolute path regex", async () => {
  const regex = await globToSbplRegex("*.txt", RAW_PROJECT_ROOT)
  // Should start with ^/
  expect(regex).toMatch(/^\^\//)
})

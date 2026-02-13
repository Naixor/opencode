import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { SecurityConfig } from "@/security/config"
import { SecuritySchema } from "@/security/schema"
import { AccessGuard } from "./access-guard"
import type { MonitorReport } from "./access-guard"

const FIXTURES_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures")
const KEYS_DIR = path.join(FIXTURES_DIR, "keys")

function base64UrlEncode(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function signJWT(header: object, payload: object, privateKeyPem: string): string {
  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)))
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)))
  const signatureInput = `${headerB64}.${payloadB64}`
  const signer = crypto.createSign("RSA-SHA256")
  signer.update(signatureInput)
  const signature = signer.sign(privateKeyPem)
  return `${signatureInput}.${base64UrlEncode(signature)}`
}

/**
 * Write .opencode-security.json to a directory and load it as the active security config.
 */
export async function setupSecurityConfig(config: SecuritySchema.SecurityConfig, tempDir?: string): Promise<string> {
  const dir = tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "sec-test-"))
  const configPath = path.join(dir, ".opencode-security.json")
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  // Initialize a .git directory so findGitRoot works
  const gitDir = path.join(dir, ".git")
  if (!fs.existsSync(gitDir)) {
    fs.mkdirSync(gitDir)
  }
  await SecurityConfig.loadSecurityConfig(dir)
  return dir
}

/**
 * Reset security config to empty state.
 */
export function teardownSecurityConfig(): void {
  SecurityConfig.resetConfig()
}

/**
 * Create a symlink and return a cleanup function that removes it.
 */
export function createTempSymlink(target: string, linkPath: string): () => void {
  const linkDir = path.dirname(linkPath)
  if (!fs.existsSync(linkDir)) {
    fs.mkdirSync(linkDir, { recursive: true })
  }
  fs.symlinkSync(target, linkPath)
  return () => {
    fs.rmSync(linkPath, { force: true })
  }
}

/**
 * Generate a JWT with exp in the past, signed with the test private key.
 */
export function generateExpiredToken(role: string, privateKeyPath?: string): string {
  const keyPath = privateKeyPath ?? path.join(KEYS_DIR, "test-private.pem")
  const privateKey = fs.readFileSync(keyPath, "utf8")
  const header = { alg: "RS256", typ: "JWT" }
  const payload = {
    role,
    iat: Math.floor(Date.now() / 1000) - 7200,
    exp: Math.floor(Date.now() / 1000) - 3600,
    jti: crypto.randomUUID(),
  }
  return signJWT(header, payload, privateKey)
}

/**
 * Generate a JWT signed with the wrong private key (forgery test).
 */
export function generateForgedToken(role: string, wrongPrivateKeyPath?: string): string {
  const keyPath = wrongPrivateKeyPath ?? path.join(KEYS_DIR, "wrong-private.pem")
  const privateKey = fs.readFileSync(keyPath, "utf8")
  const header = { alg: "RS256", typ: "JWT" }
  const payload = {
    role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400,
    jti: crypto.randomUUID(),
  }
  return signJWT(header, payload, privateKey)
}

/**
 * Generate a valid JWT for positive test cases.
 */
export function generateValidToken(role: string, privateKeyPath?: string, expiresInDays = 1): string {
  const keyPath = privateKeyPath ?? path.join(KEYS_DIR, "test-private.pem")
  const privateKey = fs.readFileSync(keyPath, "utf8")
  const header = { alg: "RS256", typ: "JWT" }
  const payload = {
    role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInDays * 86400,
    jti: crypto.randomUUID(),
  }
  return signJWT(header, payload, privateKey)
}

/**
 * Assert that calling fn throws an error containing 'Security' or 'Access denied'.
 */
export async function assertBlocked(fn: () => unknown | Promise<unknown>): Promise<void> {
  const result = await Promise.resolve()
    .then(() => fn())
    .then(() => ({ threw: false as const }))
    .catch((err: Error) => ({ threw: true as const, error: err }))

  if (!result.threw) {
    throw new Error("Expected function to throw a security error, but it did not throw")
  }
  const msg = result.error.message ?? String(result.error)
  const isSecurityError = /security|access denied|denied|blocked|protected/i.test(msg)
  if (!isSecurityError) {
    throw new Error(`Expected a security-related error, but got: ${msg}`)
  }
}

/**
 * Assert that calling fn does NOT throw.
 */
export async function assertAllowed(fn: () => unknown | Promise<unknown>): Promise<void> {
  await Promise.resolve()
    .then(() => fn())
    .catch((err: Error) => {
      throw new Error(`Expected function to succeed, but it threw: ${err.message}`)
    })
}

/**
 * Load the base security config fixture.
 */
export function loadBaseConfig(): SecuritySchema.SecurityConfig {
  const configPath = path.join(FIXTURES_DIR, "base-security-config.json")
  const content = fs.readFileSync(configPath, "utf8")
  return JSON.parse(content) as SecuritySchema.SecurityConfig
}

/**
 * Get the path to a test key file.
 */
export function keyPath(name: "test-private" | "test-public" | "wrong-private"): string {
  return path.join(KEYS_DIR, `${name}.pem`)
}

/**
 * Get the path to a protected fixture file.
 */
export function protectedFilePath(relativePath: string): string {
  return path.join(FIXTURES_DIR, "protected-files", relativePath)
}

/**
 * Get the fixtures directory path.
 */
export function fixturesDir(): string {
  return FIXTURES_DIR
}

/**
 * Write a token to a temp file and return the path. Useful with SecurityToken.verifyRoleToken().
 */
export function writeTokenFile(token: string, dir?: string): string {
  const tokenDir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "sec-token-"))
  const tokenPath = path.join(tokenDir, ".opencode-role.token")
  fs.writeFileSync(tokenPath, token)
  return tokenPath
}

// ============================================================================
// Access Guard Helpers
// ============================================================================

let activeGuard: AccessGuard | undefined

/**
 * Start an AccessGuard monitor for protected file patterns.
 * Auto-detects privileged vs unprivileged mode.
 */
export async function startAccessGuard(
  patterns: string[],
  options?: { cwd?: string; logPath?: string },
): Promise<AccessGuard> {
  const guard = new AccessGuard(patterns, options)
  await guard.start()
  activeGuard = guard
  return guard
}

/**
 * Stop the active AccessGuard and return its report.
 * Optionally cross-reference with the application audit log.
 */
export async function stopAccessGuard(appLogPath?: string): Promise<MonitorReport> {
  if (!activeGuard) {
    throw new Error("No active AccessGuard — call startAccessGuard() first")
  }
  const report = await activeGuard.report(appLogPath)
  activeGuard = undefined
  return report
}

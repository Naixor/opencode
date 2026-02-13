import { describe, test, expect, afterEach } from "bun:test"
import { SecurityConfig } from "@/security/config"
import { LLMScanner } from "@/security/llm-scanner"
import { SecuritySchema } from "@/security/schema"
import { setupSecurityConfig, teardownSecurityConfig, loadBaseConfig } from "../helpers"

afterEach(() => {
  teardownSecurityConfig()
})

// =============================================================================
// CASE-MCP-001: getMcpPolicy returns 'blocked' for blocked-server
// =============================================================================
describe("CASE-MCP-001: getMcpPolicy returns 'blocked' for blocked-server", () => {
  test("blocked-server returns 'blocked' policy", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const policy = SecurityConfig.getMcpPolicy("blocked-server")
    expect(policy).toBe("blocked")
  })

  test("blocked server tools should not be registered — policy check prevents registration", async () => {
    // In prompt.ts, when policy === "blocked", the code `continue`s the loop,
    // skipping tool registration entirely. We verify the policy value here;
    // actual tool registration skipping is an integration concern tested by
    // confirming getMcpPolicy returns "blocked".
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const policy = SecurityConfig.getMcpPolicy("blocked-server")
    expect(policy).toBe("blocked")

    // Document: In prompt.ts lines 756-766, `if (policy === "blocked") { continue }`
    // skips registering the tool. The server's tools never appear in the available tool set.
    // [INFO] This is correct security behavior — tools from blocked servers are never callable.
  })

  test("multiple calls to getMcpPolicy for same blocked server are consistent", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    expect(SecurityConfig.getMcpPolicy("blocked-server")).toBe("blocked")
    expect(SecurityConfig.getMcpPolicy("blocked-server")).toBe("blocked")
    expect(SecurityConfig.getMcpPolicy("blocked-server")).toBe("blocked")
  })
})

// =============================================================================
// CASE-MCP-002: getMcpPolicy returns 'enforced' for enforced-server
// =============================================================================
describe("CASE-MCP-002: getMcpPolicy returns 'enforced' for enforced-server", () => {
  test("enforced-server returns 'enforced' policy", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const policy = SecurityConfig.getMcpPolicy("enforced-server")
    expect(policy).toBe("enforced")
  })

  test("enforced policy means inputs AND outputs are scanned by LLMScanner", async () => {
    // In prompt.ts:
    // - Lines 794-817: Before execution, tool args are JSON.stringify'd and scanned via LLMScanner.scanForProtectedContent()
    // - Lines 824-849: After execution, tool output text content is scanned and redacted if matches found
    // Verify that LLMScanner correctly detects protected content that would appear in MCP tool I/O
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const policy = SecurityConfig.getMcpPolicy("enforced-server")
    expect(policy).toBe("enforced")

    // Simulate scanning tool input that contains a protected file path reference
    const toolInput = JSON.stringify({ path: "secrets/key.pem", action: "read" })
    const inputMatches = LLMScanner.scanForProtectedContent(toolInput, baseConfig)
    expect(inputMatches.length).toBeGreaterThan(0)
    expect(inputMatches.some((m) => m.ruleType === "pattern")).toBe(true)
  })

  test("enforced policy scans tool output text for protected markers", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Simulate MCP tool returning output that contains protected markers
    const toolOutput = ["File contents:", "// @secure-start", "const SECRET_KEY = 'abc123'", "// @secure-end"].join(
      "\n",
    )

    const outputMatches = LLMScanner.scanForProtectedContent(toolOutput, baseConfig)
    const markerMatches = outputMatches.filter((m) => m.ruleType === "marker")
    expect(markerMatches.length).toBeGreaterThan(0)
  })
})

// =============================================================================
// CASE-MCP-003: getMcpPolicy returns 'trusted' for trusted-server
// =============================================================================
describe("CASE-MCP-003: getMcpPolicy returns 'trusted' for trusted-server", () => {
  test("trusted-server returns 'trusted' policy", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const policy = SecurityConfig.getMcpPolicy("trusted-server")
    expect(policy).toBe("trusted")
  })

  test("trusted policy means NO scanning is applied — document trust implications", async () => {
    // In prompt.ts, the scanning blocks are guarded by `if (policy === "enforced")`.
    // When policy is "trusted", neither input scanning (lines 794-817) nor output
    // scanning (lines 824-849) executes. This means:
    // [INFO] Trusted servers can send and receive any content, including protected data.
    // [INFO] Trust is absolute — there's no partial trust or content-specific filtering.
    // [INFO] If a trusted MCP server is compromised, it can exfiltrate all protected content.
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const policy = SecurityConfig.getMcpPolicy("trusted-server")
    expect(policy).toBe("trusted")

    // Even though protected content exists, trusted servers bypass all scanning
    const protectedContent = "// @secure-start\nSECRET=abc\n// @secure-end"
    const matches = LLMScanner.scanForProtectedContent(protectedContent, baseConfig)
    // The scanner itself still FINDS matches — but in prompt.ts, the scan is never called for trusted servers
    expect(matches.length).toBeGreaterThan(0)
    // Document: The bypass is NOT in the scanner — it's in prompt.ts skipping the scan entirely.
    // A compromised trusted server receives unscanned content.
  })
})

// =============================================================================
// CASE-MCP-004: Unlisted server falls back to defaultMcpPolicy
// =============================================================================
describe("CASE-MCP-004: Unlisted server falls back to defaultMcpPolicy", () => {
  test("unlisted server returns defaultPolicy from base config ('enforced')", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // "unknown-server" is not listed in base config's mcp.servers
    const policy = SecurityConfig.getMcpPolicy("unknown-server")
    // Base config has defaultPolicy: "enforced"
    expect(policy).toBe("enforced")
  })

  test("custom defaultPolicy 'blocked' is used for unlisted servers", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      mcp: {
        defaultPolicy: "blocked",
        servers: {
          "allowed-server": "trusted",
        },
      },
    }
    await setupSecurityConfig(config)

    expect(SecurityConfig.getMcpPolicy("unlisted-server")).toBe("blocked")
    expect(SecurityConfig.getMcpPolicy("some-random-server")).toBe("blocked")
    // But the explicitly listed server uses its own policy
    expect(SecurityConfig.getMcpPolicy("allowed-server")).toBe("trusted")
  })

  test("custom defaultPolicy 'trusted' is used for unlisted servers", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      mcp: {
        defaultPolicy: "trusted",
        servers: {},
      },
    }
    await setupSecurityConfig(config)

    expect(SecurityConfig.getMcpPolicy("any-server")).toBe("trusted")
  })

  test("config with NO mcp section returns 'trusted' for all servers", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      roles: [{ name: "viewer", level: 10 }],
      rules: [],
    }
    await setupSecurityConfig(config)

    // getMcpPolicy: if (!config.mcp) return "trusted"
    expect(SecurityConfig.getMcpPolicy("any-server")).toBe("trusted")
    expect(SecurityConfig.getMcpPolicy("blocked-server")).toBe("trusted")
    expect(SecurityConfig.getMcpPolicy("")).toBe("trusted")
  })

  test("config with mcp but empty servers object uses defaultPolicy", async () => {
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      mcp: {
        defaultPolicy: "enforced",
        servers: {},
      },
    }
    await setupSecurityConfig(config)

    expect(SecurityConfig.getMcpPolicy("new-server")).toBe("enforced")
  })
})

// =============================================================================
// CASE-MCP-005: LLMScanner catches protected content in MCP tool output
// =============================================================================
describe("CASE-MCP-005: LLMScanner catches protected content in MCP tool output", () => {
  test("scanner detects .env path reference in tool output text", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Simulate MCP tool output containing a reference to a protected file path
    const toolOutput = "I found the configuration in .env.production with DATABASE_URL=postgres://..."
    const matches = LLMScanner.scanForProtectedContent(toolOutput, baseConfig)

    const patternMatches = matches.filter((m) => m.ruleType === "pattern")
    expect(patternMatches.length).toBeGreaterThan(0)
    expect(patternMatches.some((m) => m.matchedText === ".env")).toBe(true)
  })

  test("scanner detects secrets/ path in tool output", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const toolOutput = "Contents of secrets/key.pem:\n-----BEGIN RSA PRIVATE KEY-----\nMIIE..."
    const matches = LLMScanner.scanForProtectedContent(toolOutput, baseConfig)

    const patternMatches = matches.filter((m) => m.ruleType === "pattern")
    expect(patternMatches.length).toBeGreaterThan(0)
    expect(patternMatches.some((m) => m.matchedText === "secrets/")).toBe(true)
  })

  test("scanner detects protected markers in MCP tool output", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const toolOutput = [
      "Result from database query:",
      "// @secure-start",
      "api_key: sk-prod-12345",
      "// @secure-end",
    ].join("\n")

    const matches = LLMScanner.scanForProtectedContent(toolOutput, baseConfig)
    const markerMatches = matches.filter((m) => m.ruleType === "marker")
    expect(markerMatches.length).toBeGreaterThan(0)
  })

  test("scanner detects multiple protected references in single output", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const toolOutput = [
      "Files found:",
      "1. .env - database config",
      "2. .env.production - production secrets",
      "3. secrets/key.pem - private key",
      "4. src/auth/keys.ts - auth keys",
    ].join("\n")

    const matches = LLMScanner.scanForProtectedContent(toolOutput, baseConfig)
    // Should detect .env references and secrets/ and src/auth/keys.ts
    expect(matches.length).toBeGreaterThanOrEqual(3)
  })

  test("scanner does not flag clean output with no protected content", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    const toolOutput = "Operation completed successfully. Processed 42 records in 1.2s."
    const matches = LLMScanner.scanForProtectedContent(toolOutput, baseConfig)

    expect(matches.length).toBe(0)
  })

  test("[KNOWN_LIMITATION] scanner does not detect base64-encoded protected content in MCP output", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Base64 encode "secrets/key.pem"
    const encoded = Buffer.from("secrets/key.pem").toString("base64")
    const toolOutput = `Encoded path: ${encoded}`
    const matches = LLMScanner.scanForProtectedContent(toolOutput, baseConfig)

    // Scanner operates on raw text only — base64 encoding evades detection
    // [KNOWN_LIMITATION] MEDIUM: Base64-encoded paths in MCP tool output bypass scanner
    expect(matches.length).toBe(0)
  })
})

// =============================================================================
// CASE-MCP-006: Server identity trust model — based on config key, not self-reported
// =============================================================================
describe("CASE-MCP-006: Server identity is based on config key name, not self-reported", () => {
  test("server identity comes from the config key, not from the server itself", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // The server name used for getMcpPolicy is derived from the tool key in prompt.ts:
    // `const underscoreIndex = key.indexOf("_")`
    // `const serverName = underscoreIndex > 0 ? key.slice(0, underscoreIndex) : key`
    // This means the server name is extracted from the registered tool key, which
    // comes from the MCP tool registry — NOT self-reported by the server.

    // Document: The trust model works as follows:
    // 1. MCP servers are registered via config with a name key (e.g., "trusted-server")
    // 2. When tools are loaded, the tool key format is "serverName_toolName"
    // 3. getMcpPolicy() looks up the server name in config.mcp.servers
    // 4. The server cannot influence its own name in the config lookup

    // Verify: A server named "blocked-server" cannot claim to be "trusted-server"
    expect(SecurityConfig.getMcpPolicy("blocked-server")).toBe("blocked")
    expect(SecurityConfig.getMcpPolicy("trusted-server")).toBe("trusted")

    // These are independent lookups — no server self-identification involved
  })

  test("server name extraction from tool key uses first underscore split", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // In prompt.ts, server name extraction: key.slice(0, key.indexOf("_"))
    // Tool key "enforced-server_readFile" → server name "enforced-server"
    // Tool key "trusted-server_execute" → server name "trusted-server"

    // Test the extraction logic matches getMcpPolicy behavior
    const toolKey1 = "enforced-server_readFile"
    const underscoreIndex1 = toolKey1.indexOf("_")
    const serverName1 = underscoreIndex1 > 0 ? toolKey1.slice(0, underscoreIndex1) : toolKey1
    expect(SecurityConfig.getMcpPolicy(serverName1)).toBe("enforced")

    const toolKey2 = "blocked-server_someAction"
    const underscoreIndex2 = toolKey2.indexOf("_")
    const serverName2 = underscoreIndex2 > 0 ? toolKey2.slice(0, underscoreIndex2) : toolKey2
    expect(SecurityConfig.getMcpPolicy(serverName2)).toBe("blocked")
  })

  test("tool key without underscore uses entire key as server name", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // If tool key has no underscore, the entire key is used as server name
    // `const serverName = underscoreIndex > 0 ? key.slice(0, underscoreIndex) : key`
    const toolKey = "trusted-server"
    const underscoreIndex = toolKey.indexOf("_")
    const serverName = underscoreIndex > 0 ? toolKey.slice(0, underscoreIndex) : toolKey
    expect(serverName).toBe("trusted-server")
    expect(SecurityConfig.getMcpPolicy(serverName)).toBe("trusted")
  })

  test("[INFO] server name with underscores in server name itself — only first underscore is used for split", async () => {
    // If a server is registered as "my_custom_server", tools would be keyed as
    // "my_custom_server_toolName". The extraction `key.indexOf("_")` finds the FIRST
    // underscore, extracting "my" as the server name — NOT "my_custom_server".
    // This is a potential misconfiguration vector.
    const config: SecuritySchema.SecurityConfig = {
      version: "1.0",
      mcp: {
        defaultPolicy: "enforced",
        servers: {
          my_custom_server: "blocked",
          my: "trusted",
        },
      },
    }
    await setupSecurityConfig(config)

    // Tool key "my_custom_server_readFile" → first underscore at index 2 → server name "my"
    const toolKey = "my_custom_server_readFile"
    const underscoreIndex = toolKey.indexOf("_")
    const extractedName = underscoreIndex > 0 ? toolKey.slice(0, underscoreIndex) : toolKey
    expect(extractedName).toBe("my")
    // Looks up "my" (trusted), NOT "my_custom_server" (blocked)
    expect(SecurityConfig.getMcpPolicy(extractedName)).toBe("trusted")
    // [INFO] Server names with underscores cause identity mismatch — the config key
    // "my_custom_server" would never be matched because tool key extraction splits on first underscore.
    // This is a configuration gotcha, not a security bypass per se.
  })

  test("empty string server name falls back to defaultPolicy", async () => {
    const baseConfig = loadBaseConfig()
    await setupSecurityConfig(baseConfig)

    // Edge case: empty string as server name
    const policy = SecurityConfig.getMcpPolicy("")
    // "" is not in servers map → falls back to defaultPolicy: "enforced"
    expect(policy).toBe("enforced")
  })
})

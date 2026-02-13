import { describe, test, expect } from "bun:test"
import { SecuritySegments } from "@/security/segments"
import { SecuritySchema } from "@/security/schema"
import { loadBaseConfig, protectedFilePath } from "../helpers"
import fs from "fs"

// ============================================================================
// CASE-SEG-*: Segment Detection Evasion Cases
//
// Tests that marker and AST segment detection cannot be evaded through
// whitespace tricks, comment style variations, eval wrapping, aliasing,
// computed properties, re-exports, and unsupported languages.
// ============================================================================

const baseConfig = loadBaseConfig()
const markers = baseConfig.segments!.markers!
const astRules = baseConfig.segments!.ast!

// ---------------------------------------------------------------------------
// CASE-SEG-001: Extra whitespace in marker comments
// Severity: INFO
// Verify '//   @secure-start' (extra whitespace) is detected
// ---------------------------------------------------------------------------
describe("CASE-SEG-001: Extra whitespace in marker comments is still detected", () => {
  test("single extra space: '//  @secure-start' is detected", () => {
    const content = [
      "const a = 1",
      "//  @secure-start",
      "const secret = 'hidden'",
      "//  @secure-end",
      "const b = 2",
    ].join("\n")

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(1)
    expect(content.slice(segments[0].start, segments[0].end)).toContain("secret")
  })

  test("multiple extra spaces: '//    @secure-start' is detected", () => {
    const content = [
      "const a = 1",
      "//    @secure-start",
      "const secret = 'hidden'",
      "//    @secure-end",
      "const b = 2",
    ].join("\n")

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(1)
  })

  test("tab instead of space: '//\\t@secure-start' is detected (\\s matches tab)", () => {
    const content = "const a = 1\n//\t@secure-start\nconst secret = 'hidden'\n//\t@secure-end\nconst b = 2"

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(1)
  })

  test("hash with extra whitespace: '#   @secure-start' is detected", () => {
    const content = "#   @secure-start\nsecret = 'hidden'\n#   @secure-end"

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(1)
  })

  test("block comment with extra whitespace: '/*   @secure-start   */' is detected", () => {
    const content = "/*   @secure-start   */\nconst secret = 'hidden'\n/*   @secure-end   */"

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// CASE-SEG-002: Bare marker without comment prefix
// Severity: INFO (correct behavior)
// Verify bare '@secure-start' without comment prefix is NOT detected
// ---------------------------------------------------------------------------
describe("CASE-SEG-002: Bare '@secure-start' without comment prefix is NOT detected", () => {
  test("bare '@secure-start' on its own line is not detected", () => {
    const content = ["const a = 1", "@secure-start", "const secret = 'hidden'", "@secure-end", "const b = 2"].join("\n")

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(0)
  })

  test("bare marker inline with code is not detected", () => {
    const content = 'const marker = "@secure-start"\nconst secret = "hidden"\nconst end = "@secure-end"'

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(0)
  })

  test("marker prefixed with a non-comment character is not detected", () => {
    const content = "x @secure-start\nconst secret = 'hidden'\nx @secure-end"

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// CASE-SEG-003: Block comment style '/* @secure-start */' is detected
// Severity: INFO
// ---------------------------------------------------------------------------
describe("CASE-SEG-003: Block comment style '/* @secure-start */' is detected", () => {
  test("basic block comment markers are detected", () => {
    const content = [
      "const public1 = 'safe'",
      "/* @secure-start */",
      "const secret = 'hidden-in-block'",
      "/* @secure-end */",
      "const public2 = 'safe'",
    ].join("\n")

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(1)
    expect(content.slice(segments[0].start, segments[0].end)).toContain("hidden-in-block")
  })

  test("block comment markers on same line as code are detected", () => {
    const content = "const a = 1; /* @secure-start */\nconst secret = 'x'\n/* @secure-end */ const b = 2"

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(1)
  })

  test("HTML comment markers <!-- @secure-start --> are detected", () => {
    const content = "<!-- @secure-start -->\n<p>Secret HTML content</p>\n<!-- @secure-end -->"

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(1)
    expect(content.slice(segments[0].start, segments[0].end)).toContain("Secret HTML content")
  })

  test("Python triple-quote markers are detected", () => {
    const content = '""" @secure-start """\nsecret = "hidden"\n""" @secure-end """'

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(1)
  })

  test("Python single-quote triple markers are detected", () => {
    const content = "''' @secure-start '''\nsecret = 'hidden'\n''' @secure-end '''"

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// CASE-SEG-004: Multi-line block comment '/* \n @secure-start \n */' behavior
// Severity: INFO — document if not detected
// The regex patterns match single-line block comments /* marker */ only.
// A multi-line block comment with the marker on a separate line is NOT detected.
// ---------------------------------------------------------------------------
describe("CASE-SEG-004: Multi-line block comment marker detection behavior", () => {
  test("multi-line block comment IS detected because \\s* matches newlines in /* pattern", () => {
    // The regex `/\*\s*@secure-start\s*\*/` uses \s* which matches newlines.
    // So `/*\n  @secure-start\n*/` is matched by the block comment pattern.
    // This is actually GOOD security behavior: wrapping markers in multi-line
    // block comments does NOT evade detection.
    const content = [
      "const a = 1",
      "/*",
      "  @secure-start",
      "*/",
      "const secret = 'hidden'",
      "/*",
      "  @secure-end",
      "*/",
      "const b = 2",
    ].join("\n")

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    // The `/*\s*@secure-start\s**/` pattern matches across newlines because \s includes \n
    expect(segments.length).toBe(1)
    expect(content.slice(segments[0].start, segments[0].end)).toContain("secret")
  })

  test("[KNOWN_LIMITATION] bare marker buried in unrelated block comment text is NOT detected", () => {
    // If the marker text appears without ANY recognized comment prefix
    // (no //, #, /*, <!--, """, '''), it won't be detected.
    // This test uses plain text wrapping that doesn't match any pattern.
    const content = [
      "const a = 1",
      "BLOCK_BEGIN @secure-start BLOCK_END",
      "const secret = 'hidden'",
      "BLOCK_BEGIN @secure-end BLOCK_END",
      "const b = 2",
    ].join("\n")

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    // No recognized comment prefix → not detected
    expect(segments.length).toBe(0)
  })

  test("single-line block comment IS detected (contrast)", () => {
    const content = "const a = 1\n/* @secure-start */\nconst secret = 'hidden'\n/* @secure-end */\nconst b = 2"

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    expect(segments.length).toBe(1)
  })

  test("[KNOWN_LIMITATION] marker on second line of multi-line block comment — # style on its own line IS detected", () => {
    // The `#\\s*@secure-start` pattern matches the `# @secure-start` line inside
    // the block comment because it scans independently of comment context.
    const content = [
      "const a = 1",
      "/*",
      "# @secure-start",
      "*/",
      "const secret = 'hidden'",
      "/*",
      "# @secure-end",
      "*/",
      "const b = 2",
    ].join("\n")

    const segments = SecuritySegments.findMarkerSegments(content, markers)
    // The `# @secure-start` inside the block comment matches the `#\\s*@marker` pattern
    expect(segments.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// CASE-SEG-005: eval('function encryptData() {}') is NOT detected by AST parser
// Severity: KNOWN_LIMITATION
// The AST parser analyzes static source code. Functions defined inside eval
// strings are not visible to the TypeScript compiler API.
// ---------------------------------------------------------------------------
describe("CASE-SEG-005: eval wrapping evades AST detection [KNOWN_LIMITATION]", () => {
  test("function declared inside eval string is NOT detected", () => {
    const content = [
      "// Function hidden inside eval",
      "eval('function encryptData() { return \"encrypted\" }')",
      "",
      "// Regular function IS detected",
      "function decryptPayload() { return 'decrypted' }",
    ].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, astRules)
    // Only decryptPayload should be detected, not the eval'd encryptData
    expect(segments.length).toBe(1)
    expect(segments[0].nodeType).toBe("function")
    // The detected function should be decryptPayload, not encryptData
    expect(content.slice(segments[0].start, segments[0].end)).toContain("decryptPayload")
    expect(content.slice(segments[0].start, segments[0].end)).not.toContain("eval")
  })

  test("Function constructor is NOT detected", () => {
    const content = [
      "const encryptData = new Function('data', 'return data')",
      "",
      "function verifySignature() { return true }",
    ].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, astRules)
    // new Function() call is a CallExpression, not a FunctionDeclaration.
    // The variable `encryptData` is assigned a `new` expression, NOT an ArrowFunction
    // or FunctionExpression, so it won't match arrow_function nodeType.
    // Only verifySignature should be detected.
    expect(segments.length).toBe(1)
    expect(content.slice(segments[0].start, segments[0].end)).toContain("verifySignature")
  })

  test("template literal function definition is NOT detected", () => {
    const content = ["const code = `function encryptData() { return 'encrypted' }`", "eval(code)"].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, astRules)
    // Template literal content is a string, not parsed as code by TypeScript compiler
    expect(segments.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// CASE-SEG-006: Alias evasion — 'const enc = encryptData; enc()' behavior
// Severity: INFO
// Original function is protected but alias is not
// ---------------------------------------------------------------------------
describe("CASE-SEG-006: Function alias evasion — original protected, alias not", () => {
  test("original function declaration IS detected", () => {
    const content = [
      "function encryptData(data: string): string {",
      "  return data",
      "}",
      "",
      "const enc = encryptData",
      "enc('test')",
    ].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, astRules)
    // encryptData declaration is detected. The alias `const enc = encryptData` is a
    // VariableDeclaration where the initializer is an Identifier (not ArrowFunction/FunctionExpression),
    // so it does NOT match the arrow_function nodeType.
    expect(segments.length).toBe(1)
    expect(content.slice(segments[0].start, segments[0].end)).toContain("encryptData")
  })

  test("alias assignment to non-function-name variable is NOT detected", () => {
    const content = [
      "function encryptData(data: string): string { return data }",
      "",
      "const safeAlias = encryptData",
      "const result = safeAlias('test')",
    ].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, astRules)
    // Only the original function is detected, not safeAlias
    expect(segments.length).toBe(1)
    // safeAlias is not in any segment
    const segmentText = content.slice(segments[0].start, segments[0].end)
    expect(segmentText).not.toContain("safeAlias")
  })

  test("re-assigned arrow function with non-matching name evades detection", () => {
    const content = [
      "const encryptData = (data: string) => data",
      "",
      "const helper = encryptData",
      "// Only encryptData's arrow function definition is protected",
    ].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, astRules)
    // encryptData IS an arrow_function and IS detected
    expect(segments.length).toBe(1)
    expect(content.slice(segments[0].start, segments[0].end)).toContain("encryptData")
  })

  test("destructured import alias is NOT detected", () => {
    // Simulating: import { encryptData as enc } from './module'
    // After import, `enc` is used but its name doesn't match pattern
    const content = [
      "// Simulated destructured import",
      "const { encryptData: enc } = { encryptData: (d: string) => d }",
      "enc('test')",
    ].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, astRules)
    // Destructuring pattern with `encryptData: enc` — the variable declaration
    // uses an ObjectBindingPattern, not an Identifier. getNodeInfo requires
    // ts.isIdentifier(node.name) which fails for binding patterns.
    expect(segments.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// CASE-SEG-007: Computed method name class Foo { ['encryptData']() {} }
// Severity: INFO
// Check if AST detects string literal method names
// ---------------------------------------------------------------------------
describe("CASE-SEG-007: Computed method name detection behavior", () => {
  // The base config only has nodeTypes: ["function", "arrow_function"].
  // To test method detection, we need a custom rule with "method" nodeType.
  const methodRules: SecuritySchema.ASTConfig[] = [
    {
      languages: ["typescript", "javascript"],
      nodeTypes: ["function", "arrow_function", "method"],
      namePattern: "encrypt|decrypt|sign|verify",
      deniedOperations: ["read", "llm"],
      allowedRoles: ["admin"],
    },
  ]

  test("[KNOWN_LIMITATION] string literal computed method name ['encryptData']() is NOT detected", () => {
    // TypeScript AST: computed property name wraps the expression in a ComputedPropertyName node.
    // node.name is ComputedPropertyName, NOT StringLiteral directly.
    // getNodeInfo checks ts.isIdentifier(node.name) and ts.isStringLiteral(node.name),
    // both return false for ComputedPropertyName. The string literal is at
    // node.name.expression, but getNodeInfo doesn't unwrap ComputedPropertyName.
    const content = [
      "class CryptoService {",
      "  ['encryptData'](data: string): string {",
      "    return data",
      "  }",
      "}",
    ].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, methodRules)
    // [KNOWN_LIMITATION] INFO: Computed property names with string literals are
    // not unwrapped by getNodeInfo. An attacker can wrap a method name in
    // ['brackets'] to evade AST detection.
    expect(segments.length).toBe(0)
  })

  test("base config does NOT include 'method' nodeType — class methods evade default rules", () => {
    const content = [
      "class CryptoService {",
      "  encryptData(data: string): string {",
      "    return data",
      "  }",
      "}",
    ].join("\n")

    // Using base config's astRules which only has ["function", "arrow_function"]
    const segments = SecuritySegments.findASTSegments("test.ts", content, astRules)
    // [INFO] Method nodeType is not in base config's nodeTypes, so class methods
    // with matching names are NOT detected by default configuration.
    expect(segments.length).toBe(0)
  })

  test("variable-based computed method name is NOT detected", () => {
    const content = [
      "const methodName = 'encryptData'",
      "class CryptoService {",
      "  [methodName](data: string): string {",
      "    return data",
      "  }",
      "}",
    ].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, methodRules)
    // Variable-based computed property cannot be statically resolved
    expect(segments.length).toBe(0)
  })

  test("template literal computed method name is NOT detected", () => {
    const content = [
      "class CryptoService {",
      "  [`encryptData`](data: string): string {",
      "    return data",
      "  }",
      "}",
    ].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, methodRules)
    // Template literal (NoSubstitutionTemplateLiteral) is NOT a StringLiteral
    // and NOT an Identifier — getNodeInfo returns undefined
    expect(segments.length).toBe(0)
  })

  test("numeric computed method name is NOT detected (no pattern match possible)", () => {
    const content = ["class CryptoService {", "  [42](data: string): string {", "    return data", "  }", "}"].join(
      "\n",
    )

    const segments = SecuritySegments.findASTSegments("test.ts", content, methodRules)
    expect(segments.length).toBe(0)
  })

  test("regular identifier method IS detected with method nodeType rule", () => {
    const content = [
      "class CryptoService {",
      "  encryptData(data: string): string {",
      "    return data",
      "  }",
      "}",
    ].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, methodRules)
    expect(segments.length).toBe(1)
    expect(segments[0].nodeType).toBe("method")
  })
})

// ---------------------------------------------------------------------------
// CASE-SEG-008: Re-export 'export { encryptData as safeFunction }' behavior
// Severity: INFO
// Check which name is matched — the original or the alias
// ---------------------------------------------------------------------------
describe("CASE-SEG-008: Re-export aliasing behavior", () => {
  test("original function definition is detected regardless of re-export alias", () => {
    const content = [
      "function encryptData(data: string): string {",
      "  return data",
      "}",
      "",
      "export { encryptData as safeFunction }",
    ].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, astRules)
    // The FunctionDeclaration `encryptData` is detected by AST.
    // The ExportSpecifier `encryptData as safeFunction` is not a function/arrow/class/method
    // so it's not matched by getNodeInfo.
    expect(segments.length).toBe(1)
    expect(content.slice(segments[0].start, segments[0].end)).toContain("encryptData")
  })

  test("re-export with matching alias name does NOT create additional segment", () => {
    const content = [
      "function processData(data: string): string {",
      "  return data",
      "}",
      "",
      "export { processData as encryptData }",
    ].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, astRules)
    // processData does not match the pattern. The ExportSpecifier's alias name
    // `encryptData` is not checked because export specifiers are not handled
    // by getNodeInfo. This is an evasion vector: the consumer sees `encryptData`
    // but the source declaration (processData) evades detection.
    expect(segments.length).toBe(0)
  })

  test("default export of matching function IS detected at declaration", () => {
    const content = ["export default function encryptData(data: string): string {", "  return data", "}"].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, astRules)
    // Export default function with a name — the FunctionDeclaration is detected
    expect(segments.length).toBe(1)
  })

  test("anonymous default export is NOT detected (no name to match)", () => {
    const content = ["export default function(data: string): string {", "  return data", "}"].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, astRules)
    // Anonymous function has no name → getNodeInfo returns undefined (node.name is undefined)
    expect(segments.length).toBe(0)
  })

  test("barrel re-export from module is not analyzed", () => {
    // export * from './crypto' — this is a re-export declaration, not a function
    const content = ["export * from './crypto'", "export { default as encryptData } from './crypto'"].join("\n")

    const segments = SecuritySegments.findASTSegments("test.ts", content, astRules)
    // Re-export declarations are not function/arrow/class/method nodes
    expect(segments.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// CASE-SEG-009: AST rules for Python/Go/Rust return empty arrays
// Severity: KNOWN_LIMITATION MEDIUM
// Only TypeScript and JavaScript are supported by the AST parser
// ---------------------------------------------------------------------------
describe("CASE-SEG-009: AST rules for unsupported languages return empty [KNOWN_LIMITATION]", () => {
  test("Python file (.py) returns empty segments", () => {
    const content = [
      "def encrypt_data(data):",
      "    return data",
      "",
      "def decrypt_payload(ciphertext):",
      "    return ciphertext",
    ].join("\n")

    const pythonRules: SecuritySchema.ASTConfig[] = [
      {
        languages: ["python"],
        nodeTypes: ["function"],
        namePattern: "encrypt|decrypt|sign|verify",
        deniedOperations: ["read", "llm"],
        allowedRoles: ["admin"],
      },
    ]

    const segments = SecuritySegments.findASTSegments("crypto.py", content, pythonRules)
    // [KNOWN_LIMITATION] MEDIUM: Python is not supported by the TypeScript-based
    // AST parser. Python files with matching function names are completely unprotected.
    expect(segments.length).toBe(0)
  })

  test("Go file (.go) returns empty segments", () => {
    const content = [
      "package crypto",
      "",
      "func EncryptData(data []byte) []byte {",
      "    return data",
      "}",
      "",
      "func DecryptPayload(ciphertext []byte) []byte {",
      "    return ciphertext",
      "}",
    ].join("\n")

    const goRules: SecuritySchema.ASTConfig[] = [
      {
        languages: ["go"],
        nodeTypes: ["function"],
        namePattern: "Encrypt|Decrypt|Sign|Verify",
        deniedOperations: ["read", "llm"],
        allowedRoles: ["admin"],
      },
    ]

    const segments = SecuritySegments.findASTSegments("crypto.go", content, goRules)
    expect(segments.length).toBe(0)
  })

  test("Rust file (.rs) returns empty segments", () => {
    const content = [
      "pub fn encrypt_data(data: &[u8]) -> Vec<u8> {",
      "    data.to_vec()",
      "}",
      "",
      "pub fn verify_signature(data: &[u8], sig: &[u8]) -> bool {",
      "    true",
      "}",
    ].join("\n")

    const rustRules: SecuritySchema.ASTConfig[] = [
      {
        languages: ["rust"],
        nodeTypes: ["function"],
        namePattern: "encrypt|decrypt|sign|verify",
        deniedOperations: ["read", "llm"],
        allowedRoles: ["admin"],
      },
    ]

    const segments = SecuritySegments.findASTSegments("crypto.rs", content, rustRules)
    expect(segments.length).toBe(0)
  })

  test("Java file (.java) returns empty segments", () => {
    const content = [
      "public class CryptoService {",
      "    public byte[] encryptData(byte[] data) {",
      "        return data;",
      "    }",
      "}",
    ].join("\n")

    const javaRules: SecuritySchema.ASTConfig[] = [
      {
        languages: ["java"],
        nodeTypes: ["function", "method"],
        namePattern: "encrypt|decrypt|sign|verify",
        deniedOperations: ["read", "llm"],
        allowedRoles: ["admin"],
      },
    ]

    const segments = SecuritySegments.findASTSegments("CryptoService.java", content, javaRules)
    expect(segments.length).toBe(0)
  })

  test("C file (.c) returns empty segments", () => {
    const content = ["void encrypt_data(unsigned char* data, int len) {", "    // encryption logic", "}"].join("\n")

    const cRules: SecuritySchema.ASTConfig[] = [
      {
        languages: ["c"],
        nodeTypes: ["function"],
        namePattern: "encrypt|decrypt|sign|verify",
        deniedOperations: ["read", "llm"],
        allowedRoles: ["admin"],
      },
    ]

    const segments = SecuritySegments.findASTSegments("crypto.c", content, cRules)
    expect(segments.length).toBe(0)
  })

  test("TypeScript IS supported (contrast test)", () => {
    const content = "function encryptData(data: string): string { return data }"

    const segments = SecuritySegments.findASTSegments("test.ts", content, astRules)
    expect(segments.length).toBe(1)
  })

  test("JavaScript IS supported (contrast test)", () => {
    const content = "function encryptData(data) { return data }"

    const segments = SecuritySegments.findASTSegments("test.js", content, astRules)
    expect(segments.length).toBe(1)
  })

  test(".mjs and .cjs extensions are supported", () => {
    const content = "function verifySignature(data, sig) { return true }"

    const mjsSegments = SecuritySegments.findASTSegments("test.mjs", content, astRules)
    expect(mjsSegments.length).toBe(1)

    const cjsSegments = SecuritySegments.findASTSegments("test.cjs", content, astRules)
    expect(cjsSegments.length).toBe(1)
  })

  test(".tsx and .jsx extensions are supported", () => {
    const content = "function encryptData(data: string): string { return data }"

    const tsxSegments = SecuritySegments.findASTSegments("test.tsx", content, astRules)
    expect(tsxSegments.length).toBe(1)

    const jsxContent = "function encryptData(data) { return data }"
    const jsxSegments = SecuritySegments.findASTSegments("test.jsx", jsxContent, astRules)
    expect(jsxSegments.length).toBe(1)
  })
})

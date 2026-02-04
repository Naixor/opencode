import ts from "typescript"
import { SecuritySchema } from "./schema"

export namespace SecuritySegments {
  export interface MarkerSegment {
    start: number
    end: number
    rule: SecuritySchema.MarkerConfig
  }

  export interface ASTSegment {
    start: number
    end: number
    rule: SecuritySchema.ASTConfig
    nodeType: string
  }

  interface MarkerMatch {
    index: number
    isStart: boolean
    rule: SecuritySchema.MarkerConfig
  }

  /**
   * Find all protected code segments based on comment markers.
   * Supports common comment styles: //, #, <!-- -->
   * Handles nested markers (inner markers inherit outer protection)
   * and multiple separate marker blocks in the same file.
   */
  export function findMarkerSegments(
    content: string,
    markers: SecuritySchema.MarkerConfig[],
  ): MarkerSegment[] {
    const allMatches: MarkerMatch[] = []

    // Find all start and end markers in the content
    for (const marker of markers) {
      const startPatterns = buildMarkerPatterns(marker.start)
      const endPatterns = buildMarkerPatterns(marker.end)

      // Find all start markers
      for (const pattern of startPatterns) {
        let match: RegExpExecArray | null
        while ((match = pattern.exec(content)) !== null) {
          allMatches.push({
            index: match.index,
            isStart: true,
            rule: marker,
          })
        }
      }

      // Find all end markers
      for (const pattern of endPatterns) {
        let match: RegExpExecArray | null
        while ((match = pattern.exec(content)) !== null) {
          allMatches.push({
            index: match.index + match[0].length,
            isStart: false,
            rule: marker,
          })
        }
      }
    }

    // Sort matches by position
    allMatches.sort((a, b) => a.index - b.index)

    // Process matches using a stack for nested markers
    const segments: MarkerSegment[] = []
    const stack: { index: number; rule: SecuritySchema.MarkerConfig }[] = []

    for (const match of allMatches) {
      if (match.isStart) {
        // Push start marker onto stack
        stack.push({ index: match.index, rule: match.rule })
      }
      if (!match.isStart) {
        // Find matching start marker for this end marker
        const matchingStartIndex = findMatchingStartIndex(stack, match.rule)
        if (matchingStartIndex >= 0) {
          const startMatch = stack[matchingStartIndex]
          segments.push({
            start: startMatch.index,
            end: match.index,
            rule: startMatch.rule,
          })
          stack.splice(matchingStartIndex, 1)
        }
      }
    }

    // Sort segments by start position for consistent output
    segments.sort((a, b) => a.start - b.start)

    return segments
  }

  /**
   * Find all protected code segments based on AST analysis for TypeScript/JavaScript.
   * Detects function declarations, arrow functions, class declarations, and class methods.
   * Matches names against regex patterns from the AST config rules.
   *
   * @param filePath - Path to the file (used for determining language from extension)
   * @param content - Source code content to parse
   * @param astRules - Array of AST config rules to match against
   * @returns Array of AST segments with start/end positions, rule, and node type
   */
  export function findASTSegments(
    filePath: string,
    content: string,
    astRules: SecuritySchema.ASTConfig[],
  ): ASTSegment[] {
    const extension = filePath.split(".").pop()?.toLowerCase() ?? ""
    const isTypeScript = extension === "ts" || extension === "tsx"
    const isJavaScript = extension === "js" || extension === "jsx" || extension === "mjs" || extension === "cjs"

    // Only process TypeScript/JavaScript files
    if (!isTypeScript && !isJavaScript) {
      return []
    }

    // Filter rules that apply to this language
    const applicableRules = astRules.filter((rule) => {
      const languages = rule.languages.map((l) => l.toLowerCase())
      if (isTypeScript) {
        return languages.includes("typescript") || languages.includes("ts")
      }
      return languages.includes("javascript") || languages.includes("js")
    })

    if (applicableRules.length === 0) {
      return []
    }

    // Parse the source file using TypeScript compiler API
    const sourceFile = parseSourceFile(filePath, content, isTypeScript)
    if (!sourceFile) {
      return []
    }

    const segments: ASTSegment[] = []

    // Walk the AST to find matching nodes
    visitNode(sourceFile, sourceFile, applicableRules, segments)

    // Sort segments by start position
    segments.sort((a, b) => a.start - b.start)

    return segments
  }

  /**
   * Parse source code into a TypeScript AST.
   * Returns undefined if parsing fails.
   */
  function parseSourceFile(
    filePath: string,
    content: string,
    isTypeScript: boolean,
  ): ts.SourceFile | undefined {
    const scriptKind = isTypeScript
      ? filePath.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS
      : filePath.endsWith(".jsx")
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS

    return ts
      .createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind)
      // TypeScript createSourceFile doesn't throw on syntax errors, but we catch any unexpected errors
  }

  /**
   * Recursively visit AST nodes to find matching declarations.
   */
  function visitNode(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    rules: SecuritySchema.ASTConfig[],
    segments: ASTSegment[],
  ): void {
    const nodeMatch = matchNode(node, sourceFile, rules)
    if (nodeMatch) {
      segments.push(nodeMatch)
    }

    // Continue traversing child nodes
    ts.forEachChild(node, (child) => visitNode(child, sourceFile, rules, segments))
  }

  /**
   * Check if a node matches any of the AST rules.
   * Returns an ASTSegment if it matches, undefined otherwise.
   */
  function matchNode(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    rules: SecuritySchema.ASTConfig[],
  ): ASTSegment | undefined {
    const nodeInfo = getNodeInfo(node)
    if (!nodeInfo) {
      return undefined
    }

    // Check each rule to see if this node matches
    for (const rule of rules) {
      if (!rule.nodeTypes.includes(nodeInfo.nodeType)) {
        continue
      }

      // Try to match the name pattern
      const namePattern = new RegExp(rule.namePattern)
      if (namePattern.test(nodeInfo.name)) {
        return {
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          rule,
          nodeType: nodeInfo.nodeType,
        }
      }
    }

    return undefined
  }

  /**
   * Extract node type and name from a TypeScript AST node.
   * Returns undefined for nodes that don't have a matchable name.
   */
  function getNodeInfo(node: ts.Node): { nodeType: string; name: string } | undefined {
    // Function declaration: function foo() {}
    if (ts.isFunctionDeclaration(node) && node.name) {
      return { nodeType: "function", name: node.name.text }
    }

    // Variable declaration with arrow function: const foo = () => {}
    if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        return { nodeType: "arrow_function", name: node.name.text }
      }
    }

    // Class declaration: class Foo {}
    if (ts.isClassDeclaration(node) && node.name) {
      return { nodeType: "class", name: node.name.text }
    }

    // Class method: inside class { methodName() {} }
    if (ts.isMethodDeclaration(node) && node.name) {
      const methodName = ts.isIdentifier(node.name)
        ? node.name.text
        : ts.isStringLiteral(node.name)
          ? node.name.text
          : undefined
      if (methodName) {
        return { nodeType: "method", name: methodName }
      }
    }

    // Property declaration with arrow function in class: myProp = () => {}
    if (ts.isPropertyDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        return { nodeType: "method", name: node.name.text }
      }
    }

    return undefined
  }

  /**
   * Build regex patterns for a marker text that support common comment styles.
   * Supports: //, #, <!-- -->
   */
  function buildMarkerPatterns(markerText: string): RegExp[] {
    const escapedMarker = escapeRegExp(markerText)
    const patterns: RegExp[] = []

    // Pattern for // style comments (JavaScript, TypeScript, C, C++, Java, etc.)
    patterns.push(new RegExp(`//\\s*${escapedMarker}`, "g"))

    // Pattern for # style comments (Python, Ruby, Shell, etc.)
    patterns.push(new RegExp(`#\\s*${escapedMarker}`, "g"))

    // Pattern for <!-- --> style comments (HTML, XML, Markdown)
    patterns.push(new RegExp(`<!--\\s*${escapedMarker}\\s*-->`, "g"))

    // Pattern for /* */ style comments (C, JavaScript, etc.)
    patterns.push(new RegExp(`/\\*\\s*${escapedMarker}\\s*\\*/`, "g"))

    // Pattern for """ or ''' docstrings (Python)
    patterns.push(new RegExp(`"""\\s*${escapedMarker}\\s*"""`, "g"))
    patterns.push(new RegExp(`'''\\s*${escapedMarker}\\s*'''`, "g"))

    return patterns
  }

  /**
   * Escape special regex characters in a string.
   */
  function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  /**
   * Find the index of the matching start marker in the stack.
   * Looks for the most recent start marker with matching rule markers.
   */
  function findMatchingStartIndex(
    stack: { index: number; rule: SecuritySchema.MarkerConfig }[],
    endRule: SecuritySchema.MarkerConfig,
  ): number {
    // Search from the end of the stack (most recent first)
    for (let i = stack.length - 1; i >= 0; i--) {
      const item = stack[i]
      if (item.rule.start === endRule.start && item.rule.end === endRule.end) {
        return i
      }
    }
    return -1
  }
}

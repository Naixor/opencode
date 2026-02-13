import path from "path"

export namespace BashScanner {
  const FILE_ACCESS_COMMANDS = new Set(["cat", "less", "head", "tail", "vim", "nano", "grep", "find", "sed", "awk"])

  // Flags that take a value argument (next arg is not a file path)
  const FLAGS_WITH_VALUES: Record<string, Set<string>> = {
    grep: new Set([
      "-e",
      "--regexp",
      "-f",
      "--file",
      "-m",
      "--max-count",
      "--label",
      "-C",
      "-A",
      "-B",
      "--color",
      "--include",
      "--exclude",
      "--exclude-dir",
    ]),
    find: new Set([
      "-name",
      "-iname",
      "-type",
      "-maxdepth",
      "-mindepth",
      "-newer",
      "-perm",
      "-user",
      "-group",
      "-size",
      "-exec",
      "-execdir",
      "-printf",
      "-fprintf",
    ]),
    sed: new Set(["-e", "--expression", "-f", "--file", "-i"]),
    awk: new Set(["-F", "-v", "--field-separator", "--assign", "-f", "--file"]),
    head: new Set(["-n", "--lines", "-c", "--bytes"]),
    tail: new Set(["-n", "--lines", "-c", "--bytes", "-s", "--sleep-interval", "--pid"]),
  }

  function isFlag(arg: string): boolean {
    return arg.startsWith("-")
  }

  function isAwkPattern(arg: string): boolean {
    return (
      arg.includes("{") || arg.includes("BEGIN") || arg.includes("END") || arg.startsWith("'") || arg.startsWith('"')
    )
  }

  function isSedExpression(arg: string): boolean {
    return (
      arg.startsWith("s/") || arg.startsWith("s|") || arg.startsWith("y/") || arg.startsWith("'") || arg.startsWith('"')
    )
  }

  function resolvePath(filePath: string, cwd: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath
    }
    return path.resolve(cwd, filePath)
  }

  function stripQuotes(arg: string): string {
    if ((arg.startsWith("'") && arg.endsWith("'")) || (arg.startsWith('"') && arg.endsWith('"'))) {
      return arg.slice(1, -1)
    }
    return arg
  }

  function extractPathsFromCommand(command: string, args: string[], cwd: string): string[] {
    const paths: string[] = []
    const flagsWithValues = FLAGS_WITH_VALUES[command] ?? new Set<string>()

    let skipNext = false
    for (let i = 0; i < args.length; i++) {
      if (skipNext) {
        skipNext = false
        continue
      }

      const arg = stripQuotes(args[i])

      // Skip flags
      if (isFlag(arg)) {
        // Check if this flag takes a value argument
        if (flagsWithValues.has(arg)) {
          skipNext = true
        }
        // Handle combined flags like -n5 for head/tail
        continue
      }

      // Command-specific filtering
      if (command === "awk" && isAwkPattern(arg)) {
        continue
      }

      if (command === "sed" && isSedExpression(arg)) {
        continue
      }

      // For grep, first non-flag non-option arg is typically the pattern, rest are files
      if (command === "grep" && paths.length === 0 && !arg.includes("/") && !arg.includes(".")) {
        // Likely a pattern, not a file - but we still add it in case it's a file
        // Better to be conservative and flag it
      }

      // For find, the first non-flag arg is typically the search directory
      if (command === "find") {
        // find arguments after -exec are part of the exec command, stop parsing
        if (args.slice(0, i).includes("-exec") || args.slice(0, i).includes("-execdir")) {
          break
        }
      }

      // Looks like a file path
      if (arg && !arg.startsWith("-")) {
        paths.push(resolvePath(arg, cwd))
      }
    }

    return paths
  }

  function tokenize(command: string): string[] {
    const tokens: string[] = []
    let current = ""
    let inSingleQuote = false
    let inDoubleQuote = false
    let escaped = false

    for (const char of command) {
      if (escaped) {
        current += char
        escaped = false
        continue
      }

      if (char === "\\" && !inSingleQuote) {
        escaped = true
        current += char
        continue
      }

      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote
        current += char
        continue
      }

      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote
        current += char
        continue
      }

      if ((char === " " || char === "\t") && !inSingleQuote && !inDoubleQuote) {
        if (current) {
          tokens.push(current)
          current = ""
        }
        continue
      }

      current += char
    }

    if (current) {
      tokens.push(current)
    }

    return tokens
  }

  function splitPipeline(command: string): string[] {
    const segments: string[] = []
    let current = ""
    let inSingleQuote = false
    let inDoubleQuote = false
    let escaped = false

    for (let i = 0; i < command.length; i++) {
      const char = command[i]

      if (escaped) {
        current += char
        escaped = false
        continue
      }

      if (char === "\\" && !inSingleQuote) {
        escaped = true
        current += char
        continue
      }

      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote
        current += char
        continue
      }

      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote
        current += char
        continue
      }

      if (!inSingleQuote && !inDoubleQuote && (char === "|" || char === ";" || char === "&")) {
        // Handle && and ||
        if ((char === "&" && command[i + 1] === "&") || (char === "|" && command[i + 1] === "|")) {
          if (current.trim()) {
            segments.push(current.trim())
          }
          current = ""
          i++ // skip next char
          continue
        }

        // Handle single | ; &
        if (current.trim()) {
          segments.push(current.trim())
        }
        current = ""
        continue
      }

      current += char
    }

    if (current.trim()) {
      segments.push(current.trim())
    }

    return segments
  }

  export function scanBashCommand(command: string, cwd: string = process.cwd()): string[] {
    const allPaths: string[] = []
    const segments = splitPipeline(command)

    for (const segment of segments) {
      const tokens = tokenize(segment)
      if (tokens.length === 0) {
        continue
      }

      // Handle sudo prefix
      const cmdIndex = tokens[0] === "sudo" ? 1 : 0
      const cmd = tokens[cmdIndex]

      if (!cmd) {
        continue
      }

      // Extract base command name (handle paths like /usr/bin/cat)
      const baseName = path.basename(cmd)

      if (FILE_ACCESS_COMMANDS.has(baseName)) {
        const cmdArgs = tokens.slice(cmdIndex + 1)
        const paths = extractPathsFromCommand(baseName, cmdArgs, cwd)
        allPaths.push(...paths)
      }
    }

    // Deduplicate
    return [...new Set(allPaths)]
  }
}

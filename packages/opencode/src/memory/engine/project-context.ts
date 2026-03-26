import z from "zod"
import path from "path"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"

export namespace ProjectContext {
  const log = Log.create({ service: "memory.project-context" })

  export const Info = z.object({
    projectId: z.string(),
    languages: z.array(z.string()),
    techStack: z.array(z.string()),
    currentModulePath: z.string().optional(),
  })
  export type Info = z.infer<typeof Info>

  /**
   * Detect current project context by scanning config files.
   * Uses Instance.directory as the project root.
   */
  export async function detect(): Promise<Info> {
    const projectRoot = Instance.directory

    const projectId = path.basename(projectRoot)
    const languages = await detectLanguages(projectRoot)
    const techStack = await detectTechStack(projectRoot)

    const cwd = process.cwd()
    const currentModulePath = cwd.startsWith(projectRoot) ? path.relative(projectRoot, cwd) || undefined : undefined

    return { projectId, languages, techStack, currentModulePath }
  }

  // --- Language detection ---

  const LANGUAGE_MARKERS: Array<{ file: string; language: string }> = [
    { file: "tsconfig.json", language: "typescript" },
    { file: "jsconfig.json", language: "javascript" },
    { file: "pyproject.toml", language: "python" },
    { file: "requirements.txt", language: "python" },
    { file: "setup.py", language: "python" },
    { file: "go.mod", language: "go" },
    { file: "Cargo.toml", language: "rust" },
    { file: "Gemfile", language: "ruby" },
    { file: "mix.exs", language: "elixir" },
    { file: "build.gradle", language: "java" },
    { file: "pom.xml", language: "java" },
    { file: "build.gradle.kts", language: "kotlin" },
    { file: "Package.swift", language: "swift" },
    { file: "deno.json", language: "typescript" },
    { file: "deno.jsonc", language: "typescript" },
  ]

  export async function detectLanguages(root: string): Promise<string[]> {
    const found = new Set<string>()
    for (const marker of LANGUAGE_MARKERS) {
      if (await Bun.file(path.join(root, marker.file)).exists()) {
        found.add(marker.language)
      }
    }
    // package.json without tsconfig → javascript
    if ((await Bun.file(path.join(root, "package.json")).exists()) && !found.has("typescript")) {
      found.add("javascript")
    }
    return [...found]
  }

  // --- Tech stack detection ---

  const NODE_STACK_KEYWORDS: Record<string, string> = {
    hono: "hono",
    express: "express",
    fastify: "fastify",
    koa: "koa",
    react: "react",
    "react-dom": "react",
    vue: "vue",
    svelte: "svelte",
    next: "next",
    nuxt: "nuxt",
    "drizzle-orm": "drizzle",
    prisma: "prisma",
    typeorm: "typeorm",
    vitest: "vitest",
    jest: "jest",
    mocha: "mocha",
    tailwindcss: "tailwind",
    ink: "ink",
    "bun-types": "bun",
    electron: "electron",
    elysia: "elysia",
  }

  const PYTHON_STACK_KEYWORDS: Record<string, string> = {
    fastapi: "fastapi",
    django: "django",
    flask: "flask",
    sqlalchemy: "sqlalchemy",
    pytest: "pytest",
    celery: "celery",
    pydantic: "pydantic",
    numpy: "numpy",
    pandas: "pandas",
    torch: "pytorch",
    tensorflow: "tensorflow",
  }

  export async function detectTechStack(root: string): Promise<string[]> {
    const found = new Set<string>()

    // Node.js: check package.json dependencies
    const pkgFile = Bun.file(path.join(root, "package.json"))
    if (await pkgFile.exists()) {
      try {
        const pkg = await pkgFile.json()
        const allDeps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
        }
        for (const dep of Object.keys(allDeps)) {
          if (dep in NODE_STACK_KEYWORDS) {
            found.add(NODE_STACK_KEYWORDS[dep])
          }
        }
      } catch (err) {
        log.warn("failed to parse package.json", { error: String(err) })
      }
    }

    // Python: check pyproject.toml dependencies
    const pyFile = Bun.file(path.join(root, "pyproject.toml"))
    if (await pyFile.exists()) {
      try {
        const raw = await pyFile.text()
        for (const [pkg, stack] of Object.entries(PYTHON_STACK_KEYWORDS)) {
          if (raw.includes(pkg)) {
            found.add(stack)
          }
        }
      } catch (err) {
        log.warn("failed to parse pyproject.toml", { error: String(err) })
      }
    }

    // Go: check go.mod for popular modules
    const goFile = Bun.file(path.join(root, "go.mod"))
    if (await goFile.exists()) {
      try {
        const raw = await goFile.text()
        if (raw.includes("github.com/gin-gonic/gin")) found.add("gin")
        if (raw.includes("github.com/labstack/echo")) found.add("echo")
        if (raw.includes("github.com/gofiber/fiber")) found.add("fiber")
        if (raw.includes("gorm.io/gorm")) found.add("gorm")
      } catch (err) {
        log.warn("failed to parse go.mod", { error: String(err) })
      }
    }

    // Rust: check Cargo.toml for popular crates
    const cargoFile = Bun.file(path.join(root, "Cargo.toml"))
    if (await cargoFile.exists()) {
      try {
        const raw = await cargoFile.text()
        if (raw.includes("actix-web")) found.add("actix")
        if (raw.includes("axum")) found.add("axum")
        if (raw.includes("tokio")) found.add("tokio")
        if (raw.includes("serde")) found.add("serde")
      } catch (err) {
        log.warn("failed to parse Cargo.toml", { error: String(err) })
      }
    }

    return [...found]
  }
}

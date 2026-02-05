import { cmd } from "../cmd"
import path from "path"
import fs from "fs"

const TEMPLATE = {
  version: "1.0",
  roles: [
    { name: "admin", level: 100 },
    { name: "developer", level: 50 },
    { name: "viewer", level: 10 },
  ],
  rules: [
    {
      pattern: "**/.env*",
      type: "file",
      deniedOperations: ["read", "write", "llm"],
      allowedRoles: ["admin"],
    },
    {
      pattern: "secrets/**",
      type: "directory",
      deniedOperations: ["read", "write", "llm"],
      allowedRoles: ["admin"],
    },
    {
      pattern: "**/credentials.*",
      type: "file",
      deniedOperations: ["read", "write", "llm"],
      allowedRoles: ["admin"],
    },
    {
      pattern: "**/*.pem",
      type: "file",
      deniedOperations: ["read", "llm"],
      allowedRoles: ["admin"],
    },
  ],
  segments: {
    markers: [
      {
        start: "SECURITY-START",
        end: "SECURITY-END",
        deniedOperations: ["read", "llm"],
        allowedRoles: ["admin", "developer"],
      },
    ],
  },
}

export const SecurityInitCommand = cmd({
  command: "init",
  describe: "generate a template security configuration file",
  handler: async () => {
    const configPath = path.resolve(process.cwd(), ".opencode-security.json")

    if (fs.existsSync(configPath)) {
      console.error(`Error: ${configPath} already exists. Remove it first if you want to regenerate.`)
      process.exitCode = 1
      return
    }

    const content = JSON.stringify(TEMPLATE, null, 2) + "\n"
    fs.writeFileSync(configPath, content, "utf-8")
    console.log(`Created ${configPath}`)
    console.log()
    console.log("Template includes:")
    console.log("  Roles:    admin (100), developer (50), viewer (10)")
    console.log("  Rules:    .env files, secrets/ directory, credentials files, .pem files")
    console.log("  Segments: SECURITY-START / SECURITY-END comment markers")
    console.log()
    console.log("Edit the file to customize your security configuration.")
  },
})

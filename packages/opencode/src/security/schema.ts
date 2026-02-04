import z from "zod"

export namespace SecuritySchema {
  export const Operation = z.enum(["read", "write", "llm"])
  export type Operation = z.infer<typeof Operation>

  export const Role = z.object({
    name: z.string(),
    level: z.number(),
  })
  export type Role = z.infer<typeof Role>

  export const RuleType = z.enum(["directory", "file"])
  export type RuleType = z.infer<typeof RuleType>

  export const Rule = z.object({
    pattern: z.string(),
    type: RuleType,
    deniedOperations: z.array(Operation),
    allowedRoles: z.array(z.string()),
  })
  export type Rule = z.infer<typeof Rule>

  export const MarkerConfig = z.object({
    start: z.string(),
    end: z.string(),
    deniedOperations: z.array(Operation),
    allowedRoles: z.array(z.string()),
  })
  export type MarkerConfig = z.infer<typeof MarkerConfig>

  export const ASTConfig = z.object({
    languages: z.array(z.string()),
    nodeTypes: z.array(z.string()),
    namePattern: z.string(),
    deniedOperations: z.array(Operation),
    allowedRoles: z.array(z.string()),
  })
  export type ASTConfig = z.infer<typeof ASTConfig>

  export const Segments = z.object({
    markers: z.array(MarkerConfig).optional(),
    ast: z.array(ASTConfig).optional(),
  })
  export type Segments = z.infer<typeof Segments>

  export const Logging = z.object({
    path: z.string(),
    level: z.enum(["verbose", "normal"]),
    maxSizeMB: z.number(),
    retentionDays: z.number(),
  })
  export type Logging = z.infer<typeof Logging>

  export const Authentication = z.object({
    publicKey: z.string(),
    revokedTokens: z.array(z.string()),
  })
  export type Authentication = z.infer<typeof Authentication>

  export const McpPolicy = z.enum(["enforced", "trusted", "blocked"])
  export type McpPolicy = z.infer<typeof McpPolicy>

  export const McpConfig = z.object({
    defaultPolicy: McpPolicy,
    servers: z.record(z.string(), McpPolicy),
  })
  export type McpConfig = z.infer<typeof McpConfig>

  export const securityConfigSchema = z.object({
    version: z.string(),
    roles: z.array(Role).optional(),
    rules: z.array(Rule).optional(),
    segments: Segments.optional(),
    logging: Logging.optional(),
    authentication: Authentication.optional(),
    mcp: McpConfig.optional(),
  })

  export type SecurityConfig = z.infer<typeof securityConfigSchema>
}

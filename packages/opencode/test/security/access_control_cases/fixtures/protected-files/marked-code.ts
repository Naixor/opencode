// Public code above the protected region
export const publicConfig = {
  appName: "TestApp",
  version: "1.0.0",
}

// @secure-start
// This region contains sensitive configuration
const internalApiKey = "SENSITIVE_KEY_INSIDE_MARKER"
const databaseCredentials = {
  host: "internal-db.example.com",
  password: "marker-protected-password",
}
// @secure-end

// Public code below the protected region
export function getAppName() {
  return publicConfig.appName
}

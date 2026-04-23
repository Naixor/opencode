import { renderpage } from "./workflow-screen-harness"

export { renderpage }

if (import.meta.main) {
  process.stdout.write(renderpage())
}

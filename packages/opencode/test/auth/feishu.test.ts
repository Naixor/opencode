import { describe, test, expect, beforeEach } from "bun:test"
import { FeishuAuth } from "../../src/auth/feishu"

const VALID: FeishuAuth.Info = {
  refresh_token: "rt_abc",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  name: "Test User",
  email: "test@example.com",
  wellknown_url: "https://ai.corp.com",
}

beforeEach(async () => {
  // Clean up from previous test
  await FeishuAuth.remove()
})

describe("FeishuAuth", () => {
  test("read returns null when file does not exist", async () => {
    const result = await FeishuAuth.read()
    expect(result).toBeNull()
  })

  test("write then read round-trip", async () => {
    await FeishuAuth.write(VALID)
    const result = await FeishuAuth.read()
    expect(result).toEqual(VALID)
  })

  test("write validates data with zod", async () => {
    expect(FeishuAuth.write({ refresh_token: "rt", expires_at: 123 } as any)).rejects.toThrow()
  })

  test("read returns null for invalid JSON shape", async () => {
    // Write arbitrary data directly
    const path = await import("path")
    const { Global } = await import("../../src/global")
    const { Filesystem } = await import("../../src/util/filesystem")
    await Filesystem.writeJson(path.join(Global.Path.data, "feishu-auth.json"), { invalid: true }, 0o600)
    const result = await FeishuAuth.read()
    expect(result).toBeNull()
  })

  test("remove deletes the file", async () => {
    await FeishuAuth.write(VALID)
    const before = await FeishuAuth.read()
    expect(before).not.toBeNull()

    await FeishuAuth.remove()
    const after = await FeishuAuth.read()
    expect(after).toBeNull()
  })

  test("remove is safe when file does not exist", async () => {
    // Should not throw
    await FeishuAuth.remove()
    await FeishuAuth.remove()
  })

  test("overwrites previous data", async () => {
    await FeishuAuth.write(VALID)
    const updated = { ...VALID, name: "Updated User", refresh_token: "rt_new" }
    await FeishuAuth.write(updated)
    const result = await FeishuAuth.read()
    expect(result).toEqual(updated)
  })
})

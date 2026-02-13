import { describe, test, expect } from "bun:test"
import { CommentChecker } from "@/tool/comment_checker"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("CommentChecker", () => {
  test("returns undefined for clean code", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const code = `
const x = 1
const y = 2
function add(a: number, b: number) {
  return a + b
}
`.trim()
        const result = await CommentChecker.check(code, "test.ts")
        expect(result).toBeUndefined()
      },
    })
  })

  test("detects excessive comment density", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const code = `
// this is a comment
// another comment
// yet another comment
// more comments
// even more comments
// still commenting
// wow so many comments
// cannot stop commenting
// one more comment
// last comment
const x = 1
`.trim()
        const result = await CommentChecker.check(code, "test.ts")
        expect(result).toContain("excessive comments")
      },
    })
  })

  test("detects obvious AI-slop comment patterns", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const code = `
// Initialize the variable
const x = 1
// Create the array
const arr = []
// Set the value
const val = "hello"
// Define the constant
const FOO = "bar"
// Return the result
function foo() { return 1 }
const y = 2
const z = 3
const a = 4
const b = 5
const c = 6
`.trim()
        const result = await CommentChecker.check(code, "test.ts")
        expect(result).toContain("excessive comments")
      },
    })
  })

  test("detects comment duplicating next line", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const code = `
// const result = fetchData()
const result = fetchData()
const x = 1
const y = 2
const z = 3
`.trim()
        const result = await CommentChecker.check(code, "test.ts")
        expect(result).toContain("excessive comments")
      },
    })
  })
})

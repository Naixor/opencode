import z from "zod"
import fs from "fs"
import fsp from "fs/promises"
import path from "path"
import crypto from "crypto"
import { Global } from "@/global"

export namespace Lockfile {
  export const Schema = z.object({
    pid: z.number(),
    port: z.number(),
    token: z.string().nullable(),
    createdAt: z.number(),
  })

  export type Data = z.infer<typeof Schema>

  /** Encode an absolute directory path into a safe filename, truncated + SHA-256 suffix if over 255 bytes. */
  function encode(dir: string): string {
    const raw = dir.replace(/\//g, "_")
    if (Buffer.byteLength(raw) <= 200) return raw
    const hash = crypto.createHash("sha256").update(dir).digest("hex").slice(0, 16)
    return raw.slice(0, 200) + "_" + hash
  }

  /** Resolve the lock file path for a given project directory. */
  export function filepath(dir: string): string {
    return path.join(Global.Path.data, encode(dir), "worker.lock")
  }

  /** Atomically create a lock file. Returns true on success, false if file already exists (another Worker won). */
  export async function create(dir: string, data: Data): Promise<boolean> {
    const p = filepath(dir)
    await fsp.mkdir(path.dirname(p), { recursive: true })
    const content = JSON.stringify(data, null, 2)
    try {
      const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
      fs.writeSync(fd, content)
      fs.closeSync(fd)
      return true
    } catch (e: unknown) {
      if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "EEXIST") return false
      throw e
    }
  }

  /** Read and validate the lock file. Returns parsed data or undefined if not found or invalid. */
  export async function read(dir: string): Promise<Data | undefined> {
    const p = filepath(dir)
    try {
      const raw = await Bun.file(p).text()
      const parsed = Schema.safeParse(JSON.parse(raw))
      if (!parsed.success) return undefined
      return parsed.data
    } catch {
      return undefined
    }
  }

  /** Check if a process with the given PID is alive. */
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** Read the lock file and check for staleness. If stale (process dead), clean up and return undefined. */
  export async function acquire(dir: string): Promise<Data | undefined> {
    const data = await read(dir)
    if (!data) return undefined
    if (alive(data.pid)) return data
    await remove(dir)
    return undefined
  }

  /** Remove the lock file. */
  export async function remove(dir: string): Promise<void> {
    const p = filepath(dir)
    try {
      await fsp.unlink(p)
    } catch {
      // ignore if already gone
    }
  }
}

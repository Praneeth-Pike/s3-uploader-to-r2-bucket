/**
 * Upload a folder to R2/S3-compatible storage (Bun S3Client).
 *
 * Env (Bun loads .env automatically):
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_ENDPOINT
 *   R2_BUCKET
 *
 * Usage:
 *   bun scripts/upload-folder.ts <dir> [--concurrency N] [--no-skip-junk]
 *     [--max-retries N] [--initial-delay-ms N]
 */

import { S3Client } from 'bun'
import { readdir, stat } from 'node:fs/promises'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { parseArgs } from 'node:util'

const MAX_BACKOFF_MS = 30_000

function usage(): void {
  console.error(`Usage: bun scripts/upload-folder.ts <directory> [options]

Options:
  --concurrency, -c     Parallel uploads for non-YAML phase (default: 4)
  --no-skip-junk        Do not skip .DS_Store, Thumbs.db, __MACOSX
  --max-retries         Attempts per file (default: 5)
  --initial-delay-ms    First retry delay, doubles with cap (default: 500)
  --help, -h            Show this message

Requires env: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET`)
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) {
    console.error(`Invalid ${name}: expected positive integer, got "${raw}"`)
    process.exit(1)
  }
  return n
}

function isYamlPath(absolutePath: string): boolean {
  const ext = path.extname(absolutePath).toLowerCase()
  return ext === '.yml' || ext === '.yaml'
}

function isJunkFile(absolutePath: string, rootAbs: string): boolean {
  const base = path.basename(absolutePath)
  if (base === '.DS_Store') return true
  if (base.toLowerCase() === 'thumbs.db') return true
  const rel = path.relative(rootAbs, absolutePath)
  const parts = rel.split(path.sep)
  return parts.includes('__MACOSX')
}

async function collectFiles(rootAbs: string): Promise<string[]> {
  const out: string[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(full)
      } else if (ent.isFile()) {
        out.push(full)
      }
    }
  }

  await walk(rootAbs)
  return out
}

function toObjectKey(rootAbs: string, filePath: string): string {
  const rel = path.relative(rootAbs, filePath)
  return rel.split(path.sep).join('/')
}

function isNonRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /403|401|InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied/i.test(msg)
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxRetries: number,
  initialDelayMs: number,
): Promise<T> {
  let delay = initialDelayMs
  let lastError: unknown

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      if (isNonRetryableError(e)) {
        console.error(`${label}: non-retryable error:`, e instanceof Error ? e.message : e)
        throw e
      }
      if (attempt === maxRetries) break
      console.warn(
        `${label}: attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms —`,
        e instanceof Error ? e.message : e,
      )
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, MAX_BACKOFF_MS)
    }
  }

  throw lastError
}

async function uploadOne(
  s3: S3Client,
  absolutePath: string,
  key: string,
  maxRetries: number,
  initialDelayMs: number,
): Promise<void> {
  const file = Bun.file(absolutePath)
  await withRetry(
    `[upload] ${key}`,
    () => Bun.write(s3.file(key), file),
    maxRetries,
    initialDelayMs,
  )
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return
  const n = Math.min(concurrency, items.length)
  let next = 0

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await fn(items[i]!)
    }
  }

  await Promise.all(Array.from({ length: n }, () => worker()))
}

function createPrompter(): { ask: (q: string) => Promise<string>; close: () => void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return {
    ask: (q: string) => new Promise((resolve) => rl.question(q, resolve)),
    close: () => rl.close(),
  }
}

function wantsYes(line: string): boolean {
  const s = line.trim().toLowerCase()
  return s === 'y' || s === 'yes'
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      concurrency: { type: 'string', short: 'c' },
      'no-skip-junk': { type: 'boolean', default: false },
      'max-retries': { type: 'string' },
      'initial-delay-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  })

  if (values.help) {
    usage()
    process.exit(0)
  }

  const dirArg = positionals[0]
  if (!dirArg) {
    usage()
    process.exit(1)
  }

  const rootAbs = path.resolve(dirArg)
  try {
    const st = await stat(rootAbs)
    if (!st.isDirectory()) {
      console.error(`Not a directory: ${rootAbs}`)
      process.exit(1)
    }
  } catch {
    console.error(`Directory not found: ${rootAbs}`)
    process.exit(1)
  }

  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const endpoint = process.env.R2_ENDPOINT
  const bucket = process.env.R2_BUCKET

  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
    console.error(
      'Missing env: set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET',
    )
    process.exit(1)
  }

  const concurrency = parsePositiveInt('concurrency', values.concurrency, 4)
  const maxRetries = parsePositiveInt('max-retries', values['max-retries'], 5)
  const initialDelayMs = parsePositiveInt('initial-delay-ms', values['initial-delay-ms'], 500)
  const skipJunk = !values['no-skip-junk']

  const s3 = new S3Client({
    accessKeyId,
    secretAccessKey,
    endpoint,
    region: 'auto',
    bucket,
  })

  let allFiles = await collectFiles(rootAbs)
  if (skipJunk) {
    allFiles = allFiles.filter((p) => !isJunkFile(p, rootAbs))
  }

  const yamlFiles = allFiles.filter(isYamlPath).sort()
  const nonYamlFiles = allFiles.filter((p) => !isYamlPath(p)).sort()

  console.log(`Root: ${rootAbs}`)
  console.log(`Non-YAML files: ${nonYamlFiles.length}, YAML files: ${yamlFiles.length}`)
  console.log(`Concurrency: ${concurrency}, max retries: ${maxRetries}, skip junk: ${skipJunk}`)

  let hadFailure = false

  console.log('\n--- Phase 1: non-YAML uploads ---\n')
  await runPool(nonYamlFiles, concurrency, async (abs) => {
    const key = toObjectKey(rootAbs, abs)
    try {
      await uploadOne(s3, abs, key, maxRetries, initialDelayMs)
      console.log(`OK  ${key}`)
    } catch (e) {
      hadFailure = true
      console.error(`FAIL ${key}:`, e instanceof Error ? e.message : e)
    }
  })

  if (yamlFiles.length === 0) {
    console.log('\nNo YAML files to upload.')
    process.exit(hadFailure ? 1 : 0)
  }

  console.log('\n--- Phase 2: YAML uploads (per-file confirmation) ---\n')
  const { ask, close } = createPrompter()
  try {
    for (const abs of yamlFiles) {
      const key = toObjectKey(rootAbs, abs)
      const answer = await ask(`Upload ${key}? [y/N] `)
      if (!wantsYes(answer)) {
        console.log(`Skipped ${key}`)
        continue
      }
      try {
        await uploadOne(s3, abs, key, maxRetries, initialDelayMs)
        console.log(`OK  ${key}`)
      } catch (e) {
        hadFailure = true
        console.error(`FAIL ${key}:`, e instanceof Error ? e.message : e)
      }
    }
  } finally {
    close()
  }

  process.exit(hadFailure ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

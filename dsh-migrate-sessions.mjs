#!/usr/bin/env node
/**
 * dsh-migrate-sessions — publish a current-format generation for historical JSONL sessions
 * that a DeepSeek Harness build refuses to open.
 *
 * Why this exists: the JSONL persistence backend only reads a stored log by running the
 * adjacent format migration chain, and a released migration edge refuses anything outside
 * its audited vocabulary (for example a message `source.kind` written by a plugin). The
 * refusal leaves the historical file byte-identical, so the Session simply cannot be opened.
 *
 * This tool performs the upgrade once, using the published Harness format packages: it
 * restores the stored log into current logical events, re-encodes them as a current
 * generation beside the original, and never touches the source file. A host then prefers the
 * newest generation and reads it natively, so the refusing edge is never reached again.
 *
 * The result is the released current format, encoded with the released encoder and framed
 * exactly like the backend (one header frame, then line-aligned plaintext slices). The
 * installed package version therefore decides what can be migrated: point `--packages` at a
 * build that understands your log.
 *
 * Usage:
 *   node dsh-migrate-sessions.mjs [--dry-run] [--root <dir>] [--packages <dir>]
 *                                 [--marker <text>] [--help] [session-dir ...]
 *
 * Exit codes: 0 = every planned session published or already current; 1 = at least one failure.
 */
import { mkdir, readdir, rm, stat, link, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { resolvePackages } from './lib/packages.mjs'
import { encodeFramedLog, logLines, readLogText } from './lib/zstd.mjs'

const USAGE = [
  'usage: dsh-migrate-sessions [--dry-run] [--root <dir>] [--packages <dir>] [--marker <text>] [session-dir ...]',
  '',
  '  --dry-run        classify only; never opens or writes a session',
  '  --root <dir>     session root (default: $DSH_SESSIONS_ROOT or ~/.dsh/sessions)',
  '  --packages <dir> directory whose node_modules holds the published @deepseek-ai packages',
  '                   (default: $DSH_PACKAGES, then this tools directory)',
  '  --marker <text>  stored vocabulary that marks a session for repair (default: agent-teams-command)',
  '  session-dir ...  restrict to these session directories (default: every session under the root)',
  '',
  'Publishes the current generation beside a stored log; source generations are never modified.',
].join('\n')

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log(USAGE)
  process.exit(0)
}

/** Read the value that follows one flag, or `undefined`. */
function flagValue(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const dryRun = args.includes('--dry-run')
const root = flagValue('--root')
  ?? process.env['DSH_SESSIONS_ROOT']
  ?? join(process.env['HOME'] ?? '.', '.dsh', 'sessions')
const packagesDir = flagValue('--packages')
const marker = flagValue('--marker') ?? 'agent-teams-command'
const consumed = new Set()
for (const name of ['--root', '--packages', '--marker']) {
  const index = args.indexOf(name)
  if (index !== -1) consumed.add(index + 1)
}
const only = args.filter((value, index) => !value.startsWith('--') && !consumed.has(index))

const GENERATION = /^session(?:\.v([0-9]+))?\.jsonl(\.zstd)?$/

const resolved = await resolvePackages(packagesDir)
const { sessionFormatCatalog } = await resolved.load('@deepseek-ai/dsh-session-format-catalog')
const currentVersion = sessionFormatCatalog.currentVersion

/** Generation number encoded in one stored filename, or `-1`. */
function generationOf(name) {
  const match = GENERATION.exec(name)
  if (match === null) return -1
  return match[1] === undefined ? 0 : Number(match[1])
}

/** Current-generation filename matching a stored log's compression. */
function currentName(compressed) {
  return `session.v${String(currentVersion)}.jsonl${compressed ? '.zstd' : ''}`
}

/** Every session directory beneath the root. */
async function sessionDirs() {
  const dirs = []
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    for (const session of await readdir(projectPath, { withFileTypes: true })) {
      if (session.isDirectory()) dirs.push(join(projectPath, session.name))
    }
  }
  return dirs
}

/** Whether a stored log still carries the marker vocabulary. */
async function hasMarker(path) {
  for await (const line of logLines(path)) {
    if (line.includes(marker)) return true
  }
  return false
}

/** First JSONL record of a stored log. */
async function readHeaderRow(path) {
  const text = await readLogText(path)
  const end = text.indexOf('\n')
  return JSON.parse(end === -1 ? text : text.slice(0, end))
}

/** One session directory's plan, or `undefined` when it needs no publication. */
async function planSession(directory) {
  const entries = await readdir(directory)
  const stored = entries.filter(name => generationOf(name) >= 0)
  if (stored.length === 0) return undefined
  const current = entries.filter(name => name === currentName(true) || name === currentName(false))
  const historical = stored
    .filter(name => generationOf(name) < currentVersion)
    .sort((left, right) => generationOf(left) - generationOf(right))
  if (historical.length === 0) {
    const newest = stored.map(generationOf).sort((left, right) => right - left)[0]
    return { directory, skip: `already reads as v${String(newest)}` }
  }
  if (current.length > 0) return { directory, skip: `already has ${current[0]}` }
  const source = historical.at(-1)
  const sourcePath = join(directory, source)
  if (!(await hasMarker(sourcePath))) return undefined
  const header = await readHeaderRow(sourcePath)
  return { directory, source, sourcePath, id: header.id, version: generationOf(source) }
}

/** Restore a stored log into the current logical artifact. */
async function restoreArtifact(sourcePath, header) {
  const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'transformed' })
  let rows = 0
  for await (const line of logLines(sourcePath)) {
    rows += 1
    if (rows === 1) continue
    restore.decodeRow(JSON.parse(line))
  }
  return restore.finish()
}

/** Publish the current generation beside a stored log. */
async function publish(candidate) {
  const header = await readHeaderRow(candidate.sourcePath)
  const artifact = await restoreArtifact(candidate.sourcePath, header)
  const compressed = candidate.sourcePath.endsWith('.zstd')
  const rows = [sessionFormatCatalog.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount)]
  for (const event of artifact.events) rows.push(sessionFormatCatalog.encodeCurrentEvent(event))
  const name = currentName(compressed)
  const target = join(candidate.directory, name)
  const bytes = compressed
    ? await encodeFramedLog(rows)
    : Buffer.from(rows.map(row => JSON.stringify(row)).join('\n'), 'utf8')
  await mkdir(candidate.directory, { recursive: true })
  const staging = join(candidate.directory, `.${basename(target)}.staging`)
  await writeFile(staging, bytes)
  try {
    // Publication never overwrites: a concurrent writer wins and we discard our staging file.
    await link(staging, target)
  } catch (error) {
    if (error?.code === 'EEXIST') return { target, name, skipped: true }
    throw error
  } finally {
    await unlink(staging).catch(() => {})
  }
  return { target, name, skipped: false }
}

const directories = only.length > 0 ? only : await sessionDirs()
const plans = []
for (const directory of directories) {
  const candidate = await planSession(resolve(directory.startsWith('/') ? directory : join(root, directory)))
  if (candidate !== undefined) plans.push(candidate)
}

console.log(`packages: ${resolved.base}`)
console.log(`root: ${root}`)
console.log(`current format: v${String(currentVersion)}\n`)

let migrated = 0
let failed = 0
for (const candidate of plans) {
  if (candidate.skip !== undefined) {
    console.log(`SKIP  ${candidate.directory} — ${candidate.skip}`)
    continue
  }
  const label = `${candidate.id} (v${String(candidate.version)})`
  if (dryRun) {
    console.log(`PLAN  ${label}  ${candidate.sourcePath}`)
    continue
  }
  try {
    const result = await publish(candidate)
    const size = (await stat(result.target)).size
    migrated += 1
    console.log(`OK    ${label} -> ${result.name}${result.skipped ? ' (already published)' : ` (${String(size)} bytes)`}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${label}: ${error?.constructor?.name ?? 'Error'} - ${error?.message ?? String(error)}`)
  }
}
console.log(`\nplanned ${String(plans.length)}; migrated ${String(migrated)}; failed ${String(failed)}`)
if (failed > 0) process.exitCode = 1

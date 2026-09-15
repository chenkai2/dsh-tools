#!/usr/bin/env node
/**
 * dsh-migrate-sessions — publish a current (v3) generation for historical JSONL sessions
 * that the released v2->v3 source audit refuses to migrate.
 *
 * Why this exists: `MessageSourceMap` is merge-extensible, so plugins may persist their own
 * message source kinds. The released v2->v3 migration edge classifies unknown source kinds as
 * un-migratable and leaves the historical file alone, so such sessions cannot be opened at all.
 * This tool performs the upgrade once, through the shipped persistence backend's own write-open
 * (migration + Worker verification + no-overwrite publication), after which the stock host reads
 * `session.v3.jsonl.*` natively. It never edits or deletes a source generation.
 *
 * Usage:
 *   node dsh-migrate-sessions.mjs [--dry-run] [--root <dir>] [--marker <text>] [--help] [session-dir ...]
 *
 * Requires DSH_CHECKOUT to point at a checkout whose built packages contain the v2->v3 fix for
 * the marker kind (otherwise the publication refuses exactly as the host does).
 *
 * Exit codes: 0 = every planned session published or already current; 1 = at least one failure.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const REPO = process.env.DSH_CHECKOUT
  ?? '/Users/chenkai2/data1/www/htdocs/deepseek-harness'
const args = process.argv.slice(2)

const USAGE = [
  'usage: dsh-migrate-sessions [--dry-run] [--root <dir>] [--marker <text>] [session-dir ...]',
  '',
  '  --dry-run         classify only; never opens or writes a session',
  '  --root <dir>      session root (default: $DSH_SESSIONS_ROOT or ~/.dsh/sessions)',
  '  --marker <text>   source kind that marks a session for repair (default: agent-teams-command)',
  '  session-dir ...   restrict to these session directories (default: every session under the root)',
  '',
  'Publishes the current (v3) generation through the host persistence backend; source generations are never modified.',
].join('\n')
if (args.includes('--help')) {
  console.log(USAGE)
  process.exit(0)
}
const dryRun = args.includes('--dry-run')
const rootIndex = args.indexOf('--root')
const root = rootIndex === -1 ? (process.env.DSH_SESSIONS_ROOT ?? '/Users/chenkai2/.dsh/sessions') : args[rootIndex + 1]
const markerIndex = args.indexOf('--marker')
const marker = markerIndex === -1 ? 'agent-teams-command' : args[markerIndex + 1]
const consumed = new Set()
if (rootIndex !== -1) consumed.add(rootIndex + 1)
if (markerIndex !== -1) consumed.add(markerIndex + 1)
const only = args.filter((value, index) => !value.startsWith('--') && !consumed.has(index))

const { Context } = await import(REPO + '/vendor/cordis/lib/index.js')
const { default: JsonlSessionPersistence } = await import(REPO + '/packages/session/session-persistence-jsonl/lib/index.js')
const { SessionId } = await import(REPO + '/packages/core/session/lib/index.js')

const V3_NAMES = new Set(['session.v3.jsonl', 'session.v3.jsonl.zstd'])
const HISTORICAL = /^session(?:\.v([0-9]+))?\.jsonl(\.zstd)?$/

/** Spawn one streaming `zstd -dc` reader over a historical log. */
function stream(path) {
  return spawn('zstd', ['-dc', path], { stdio: ['ignore', 'pipe', 'ignore'] })
}

/** Read only the leading physical header row. */
function readHeaderRow(path) {
  return new Promise((resolve, reject) => {
    const child = stream(path)
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end !== -1) {
        child.kill('SIGKILL')
        resolve(JSON.parse(buffer.slice(0, end)))
      }
    })
    child.on('error', reject)
    child.on('close', () => {
      if (buffer.length === 0) return
      try { resolve(JSON.parse(buffer)) } catch (error) { reject(error) }
    })
  })
}

/** Whether this log still carries the source kind the repair exists for, without full decompression. */
async function needsRepair(path) {
  const child = stream(path)
  const needle = Buffer.from(marker, 'utf8')
  let carry = Buffer.alloc(0)
  try {
    for await (const chunk of child.stdout) {
      const window = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
      if (window.includes(needle)) return true
      carry = window.subarray(Math.max(0, window.length - needle.length))
    }
    return false
  } finally {
    child.kill('SIGKILL')
    await once(child, 'close').catch(() => {})
  }
}

/** Every session directory beneath the root, regardless of project key. */
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

/** Plan one session directory, or `undefined` when it needs no v3 publication. */
async function plan(directory) {
  const entries = await readdir(directory)
  const current = entries.filter(name => V3_NAMES.has(name))
  const historical = entries.filter(name => HISTORICAL.test(name) && !V3_NAMES.has(name))
  if (historical.length === 0) return undefined
  if (current.length > 0) return { directory, skip: 'already has a v3 generation' }
  const version = name => {
    const match = HISTORICAL.exec(name)
    return match?.[1] === undefined ? 0 : Number(match[1])
  }
  historical.sort((a, b) => version(a) - version(b))
  const source = join(directory, historical.at(-1))
  if (!await needsRepair(source)) return undefined
  const header = await readHeaderRow(source)
  return { directory, source, id: header.id, version: versionOf(historical.at(-1)) }
  function versionOf(name) { return version(name) }
}

const directories = only.length > 0 ? only : await sessionDirs()
const plans = []
for (const directory of directories) {
  const candidate = await plan(directory.startsWith('/') ? directory : join(root, directory))
  if (candidate !== undefined) plans.push(candidate)
}

const context = new Context()
await context.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
let migrated = 0
let failed = 0
for (const candidate of plans) {
  if (candidate.skip !== undefined) {
    console.log('SKIP  ' + candidate.directory + ' — ' + candidate.skip)
    continue
  }
  const label = candidate.id + ' (v' + String(candidate.version) + ')'
  if (dryRun) {
    console.log('PLAN  ' + label + '  ' + candidate.source)
    continue
  }
  try {
    const handle = await context.sessionPersistence.open(SessionId(candidate.id), 'write')
    await handle.close()
    const published = join(candidate.directory, 'session.v3.jsonl.zstd')
    const identity = await stat(published).catch(() => undefined)
    migrated += 1
    console.log('OK    ' + label + ' -> session.v3.jsonl.zstd'
      + (identity === undefined ? '' : ' (' + String(identity.size) + ' bytes)'))
  } catch (error) {
    failed += 1
    console.log('FAIL  ' + label + ': ' + (error?.constructor?.name ?? 'Error') + ' - ' + (error?.message ?? String(error)))
  }
}
await context.fiber.dispose()
console.log('\nplanned ' + String(plans.length) + '; migrated ' + String(migrated) + '; failed ' + String(failed))
if (failed > 0) process.exitCode = 1

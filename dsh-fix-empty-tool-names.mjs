#!/usr/bin/env node
/**
 * dsh-fix-empty-tool-names — restore dropped tool names in a stored v0/v1/v2 JSONL session.
 *
 * Background: some historical writers kept the FIRST `tool-call-delta.name`, but a later delta
 * that repeated the name as "" overwrote the final `tool-call` block, the settled
 * `assistant/message` content, and the `tool/call` event. The name is therefore NOT lost —
 * it is still present earlier in the same event run, and this tool restores it verbatim.
 *
 * Safety:
 *  - Never invents a name: a call id with no recoverable non-empty name in its own stream is
 *    reported and left untouched (so the migration still refuses rather than fabricating).
 *  - Only `name` fields that are exactly `""` are rewritten; arguments, ids and order are untouched.
 *  - Atomic write through a temporary file in the same directory; `--apply` keeps a `.bak.<utc>`.
 *
 * Usage:
 *   node dsh-fix-empty-tool-names.mjs <session-dir-or-log> [--dry-run|--apply] [--json|--help]
 */
import { copyFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { encodeFramedLog, readLogText } from './lib/zstd.mjs'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const asJson = args.includes('--json')

const USAGE = [
  'usage: dsh-fix-empty-tool-names <session-dir-or-log> [--dry-run|--apply] [--json]',
  '',
  '  <session-dir-or-log>  session directory (newest historical generation) or one log file',
  '  --dry-run             report only (default); writes nothing',
  '  --apply               rewrite the log, keeping a .bak.<utc> copy first',
  '  --json                emit the report as JSON',
  '  --help                print this usage',
  '',
  'Restores tool names that a later empty tool-call-delta overwrote. Only empty name fields are',
  'rewritten, and only with a name recovered from the same call id; arguments and order are untouched.',
].join('\n')
if (args.includes('--help')) {
  console.log(USAGE)
  process.exit(0)
}
const target = args.find(value => !value.startsWith('--'))
if (target === undefined) {
  console.error(USAGE)
  process.exit(2)
}

/** Resolve the newest historical generation inside a session directory. */
async function resolveLog(path) {
  const info = await stat(path)
  if (info.isFile()) return path
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(path)
  const version = name => {
    const match = /^session(?:\.v([0-9]+))?\.jsonl(\.zstd)?$/.exec(name)
    return match === null ? -1 : (match[1] === undefined ? 0 : Number(match[1]))
  }
  const candidates = entries.filter(name => version(name) >= 0).sort((a, b) => version(a) - version(b))
  if (candidates.length === 0) throw new Error('no session log in ' + path)
  return join(path, candidates.at(-1))
}

/** Decompress (if needed) and parse one line into a JSON value. */
function parseLine(line) {
  if (line.length === 0) return undefined
  try { return JSON.parse(line) } catch { return undefined }
}

const logPath = await resolveLog(target)
const compressed = logPath.endsWith('.zstd')
const text = await readLogText(logPath)
const lines = text.split('\n')

// Pass 1: the first non-empty name per call id, taken from the run that produced the call.
const firstNames = new Map()
const emptyOccurrences = new Map()
function noteName(id, name) {
  if (typeof id === 'string' && typeof name === 'string' && name !== '' && !firstNames.has(id)) firstNames.set(id, name)
}
for (const line of lines) {
  const event = parseLine(line)
  if (event === undefined) continue
  const data = event?.data
  if (event.type === 'assistant/chunk') {
    const chunk = data?.chunk
    if (chunk?.type === 'tool-call-delta') noteName(chunk.id, chunk.name)
    if (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call' && chunk.block.name === '') {
      emptyOccurrences.set(chunk.block.id, (emptyOccurrences.get(chunk.block.id) ?? 0) + 1)
    }
  }
  if (event.type === 'tool-call-chunks') noteName(data?.id, data?.name)
  if (event.type === 'assistant/message') {
    for (const block of data?.message?.content ?? []) {
      if (block?.type === 'tool-call' && block.name === '') emptyOccurrences.set(block.id, (emptyOccurrences.get(block.id) ?? 0) + 1)
    }
  }
  if (event.type === 'tool/call' && data?.name === '') emptyOccurrences.set(data.callId, (emptyOccurrences.get(data.callId) ?? 0) + 1)
}

const recoverable = [...emptyOccurrences.keys()].filter(id => firstNames.has(id))
const unrecoverable = [...emptyOccurrences.keys()].filter(id => !firstNames.has(id))

// Pass 2: rewrite only the exact `"name":""` occurrences belonging to recoverable call ids.
const recoverableIds = new Set(recoverable)
let patched = 0
const patchedLines = lines.map(line => {
  if (line.length === 0) return line
  const event = parseLine(line)
  if (event === undefined) return line
  let next = line
  const replace = (id, from) => {
    if (typeof id !== 'string' || !recoverableIds.has(id)) return
    const after = '"name":' + JSON.stringify(firstNames.get(id))
    if (!next.includes(from)) return
    next = next.replace(from, after)
    patched += 1
  }
  const data = event?.data
  if (event.type === 'assistant/chunk') {
    const chunk = data?.chunk
    if (chunk?.type === 'tool-call-delta' && chunk.name === '') {
      const needle = '"type":"tool-call-delta","index":' + String(chunk.index) + ',"id":' + JSON.stringify(chunk.id) + ',"name":""'
      if (next.includes(needle)) {
        next = next.replace(needle, needle.slice(0, -2) + JSON.stringify(firstNames.get(chunk.id) ?? ''))
        patched += 1
      }
    }
    if (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call' && chunk.block.name === '') {
      // rewrite exactly this block's empty name (arguments stay byte-identical)
      const needle = '"type":"tool-call","id":' + JSON.stringify(chunk.block.id) + ',"name":""'
      if (next.includes(needle)) {
        next = next.replace(needle, '"type":"tool-call","id":' + JSON.stringify(chunk.block.id) + ',"name":' + JSON.stringify(firstNames.get(chunk.block.id) ?? ''))
        patched += 1
      }
    }
  }
  if (event.type === 'tool-call-chunks' && data?.name === '') replace(data.id, '"name":""')
  if (event.type === 'tool/call' && data?.name === '') replace(data.callId, '"name":""')
  if (event.type === 'assistant/message') {
    for (const block of data?.message?.content ?? []) {
      if (block?.type !== 'tool-call' || block.name !== '') continue
      const needle = '"type":"tool-call","id":' + JSON.stringify(block.id) + ',"name":""'
      if (next.includes(needle)) {
        next = next.replace(needle, '"type":"tool-call","id":' + JSON.stringify(block.id) + ',"name":' + JSON.stringify(firstNames.get(block.id) ?? ''))
        patched += 1
      }
    }
  }
  return next
})

const summary = {
  log: logPath,
  emptyCalls: emptyOccurrences.size,
  recoverable: recoverable.map(id => ({ id, name: firstNames.get(id), occurrences: emptyOccurrences.get(id) })),
  unrecoverable,
  nameFieldsPatched: patched,
  applied: apply,
}

if (!apply) {
  if (asJson) console.log(JSON.stringify(summary, null, 1))
  else {
    console.log('log:', logPath)
    console.log('空名调用:', summary.emptyCalls, ' 可恢复:', summary.recoverable.length, ' 不可恢复:', summary.unrecoverable.length)
    console.log('将改写 name 字段数:', patched)
    for (const item of summary.recoverable) console.log('  ', item.id, '->', item.name, '(' + item.occurrences + ' 处)')
    for (const id of summary.unrecoverable) console.log('   ! 无法恢复:', id)
    console.log('\n(dry-run，未写入；加 --apply 才落盘)')
  }
  process.exit(0)
}

const patchedText = patchedLines.join('\n')
if (patchedText === text) {
  console.log('没有可改写的字段；未写入')
  process.exit(0)
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = logPath + '.bak.' + stamp
await copyFile(logPath, backup)
const temporary = join(dirname(logPath), '.' + basename(logPath) + '.repair-tmp')

// The first independently decodable frame must contain exactly one header line
// (plaintext ends with the single newline); every later frame may hold any complete rows.
await writeFile(temporary, compressed
  ? await encodeFramedLog(patchedLines)
  : Buffer.from(patchedText, 'utf8'))
await rename(temporary, logPath)
console.log(JSON.stringify({ ...summary, backup }, null, 1))

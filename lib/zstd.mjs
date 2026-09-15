/**
 * Zstandard frame helpers for the concatenated-frame container the JSONL persistence
 * backend uses: a stored log is one header frame followed by one or more body frames.
 *
 * Node's built-in zstd binding (Node 24+) decompresses a single frame only — it stops at the
 * first frame end — so this module scans frame boundaries itself and concatenates the
 * plaintext of every frame. Compression uses the same binding, and both directions fall back
 * to a `zstd` executable on `PATH` when the binding is missing.
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** Plaintext bytes per frame after the header frame; matches the backend's slice size. */
const FRAME_SLICE_BYTES = 1024 * 1024
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const NEWLINE = 0x0a
const FRAME_MAGIC = 0xfd2fb528

const nativeZstd = typeof zstdDecompressSync === 'function' && typeof zstdCompressSync === 'function'

/**
 * Report an actionable failure when neither zstd source is usable.
 * @param cause - underlying spawn error, when any.
 * @returns an Error describing how to obtain zstd support.
 */
function zstdUnavailable(cause) {
  return new Error(
    'no zstd support available: this Node has no node:zlib zstd binding and no `zstd` executable was found on PATH.\n'
    + 'Use Node 24+ or install zstd (for example `brew install zstd`).',
    cause === undefined ? undefined : { cause },
  )
}

/**
 * Length of the Zstandard frame starting at `offset`.
 * @param buffer - complete frame bytes.
 * @param offset - frame start.
 * @returns exclusive frame end, or `undefined` when the file has no further frame.
 */
function frameEnd(buffer, offset) {
  if (buffer.length - offset < 4) return undefined
  if (buffer.readUInt32LE(offset) !== FRAME_MAGIC) {
    throw new Error(`stored log is not a Zstandard frame container (bad magic at byte ${String(offset)})`)
  }
  let cursor = offset + 4
  if (cursor === buffer.length) return undefined
  const descriptor = buffer.readUInt8(cursor)
  cursor += 1
  if ((descriptor & 0x18) !== 0) throw new Error('stored log uses reserved Zstandard frame-header bits')
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  if (buffer.length - cursor < headerBytes) return undefined
  cursor += headerBytes
  for (;;) {
    if (buffer.length - cursor < 3) return undefined
    const blockHeader = buffer.readUIntLE(cursor, 3)
    cursor += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 0x03
    const blockSize = blockHeader >>> 3
    if (blockType === 0x03) throw new Error('stored log contains a reserved Zstandard block type')
    const payloadBytes = blockType === 0x01 ? 1 : blockSize
    if (buffer.length - cursor < payloadBytes) return undefined
    cursor += payloadBytes
    if (lastBlock) break
  }
  if (checksum) {
    if (buffer.length - cursor < 4) return undefined
    cursor += 4
  }
  return cursor
}

/**
 * Concatenate the plaintext of every Zstandard frame in a container.
 * @param buffer - concatenated frame bytes.
 * @returns the complete plaintext.
 */
export function decompressFrames(buffer) {
  const parts = []
  for (let offset = 0; offset < buffer.length;) {
    const end = frameEnd(buffer, offset)
    if (end === undefined) break
    parts.push(zstdDecompressSync(buffer.subarray(offset, end)))
    offset = end
  }
  if (parts.length === 0) throw new Error('stored log contains no complete Zstandard frame')
  return Buffer.concat(parts)
}

/** Decode a stored log with the `zstd` executable as a fallback. */
function decodeWithCli(path) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('zstd', ['-dc', path], { stdio: ['ignore', 'pipe', 'inherit'] })
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.on('error', error => reject(zstdUnavailable(error)))
    child.on('close', code => {
      if (code === 0) resolvePromise(Buffer.concat(chunks))
      else reject(new Error(`zstd failed to decode ${path} (exit ${String(code)})`))
    })
  })
}

/**
 * Decode a stored log to its plaintext bytes.
 * @param path - `.jsonl.zstd` or plain `.jsonl` file.
 * @returns the plaintext log.
 */
export async function readLogBytes(path) {
  const bytes = await readFile(path)
  if (!path.endsWith('.zstd')) return bytes
  if (nativeZstd) return decompressFrames(bytes)
  return decodeWithCli(path)
}

/**
 * Read a whole stored log as text.
 * @param path - `.jsonl.zstd` or plain `.jsonl` file.
 * @returns the plaintext log.
 */
export async function readLogText(path) {
  return (await readLogBytes(path)).toString('utf8')
}

/**
 * Decode a stored log as an async iterable of lines.
 * @param path - `.jsonl.zstd` or plain `.jsonl` file.
 * @returns async iterable of non-empty lines.
 */
export async function* logLines(path) {
  const text = await readLogText(path)
  let start = 0
  for (;;) {
    const end = text.indexOf('\n', start)
    if (end === -1) break
    if (end > start) yield text.slice(start, end)
    start = end + 1
  }
  if (start < text.length) yield text.slice(start)
}

/**
 * Compress one buffer into exactly one Zstandard frame.
 * @param buffer - frame plaintext.
 * @returns compressed frame bytes.
 */
export async function compressFrame(buffer) {
  if (nativeZstd) return zstdCompressSync(buffer, CHECKSUM_OPTIONS)
  return new Promise((resolvePromise, reject) => {
    const child = spawn('zstd', ['-q', '-c'], { stdio: ['pipe', 'pipe', 'inherit'] })
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.on('error', error => reject(zstdUnavailable(error)))
    child.on('close', code => {
      if (code === 0) resolvePromise(Buffer.concat(chunks))
      else reject(new Error(`zstd failed to compress a frame (exit ${String(code)})`))
    })
    child.stdin.end(buffer)
  })
}

/**
 * Encode one JSONL log as concatenated frames. The first frame must contain exactly the
 * header line, because the reader treats the first frame as independently decodable header
 * metadata; later frames are sliced on line boundaries.
 * @param rows - physical JSONL records in file order.
 * @returns encoded log bytes.
 */
export async function encodeFramedLog(rows) {
  const lines = rows.map(row => JSON.stringify(row))
  const header = lines[0]
  if (header === undefined) throw new Error('a stored log requires a header record')
  const body = lines.slice(1).join('\n')
  const frames = [await compressFrame(Buffer.from(header + '\n', 'utf8'))]
  for (let offset = 0; offset < body.length; offset += FRAME_SLICE_BYTES) {
    frames.push(await compressFrame(Buffer.from(body.slice(offset, offset + FRAME_SLICE_BYTES), 'utf8')))
  }
  return Buffer.concat(frames)
}

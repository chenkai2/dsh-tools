/**
 * Locate the published DeepSeek Harness packages these tools import.
 *
 * Nothing here is tied to a source checkout or to one machine. A base may be a project
 * directory (with `package.json` plus `node_modules`), a `node_modules` directory, or a
 * globally installed `@deepseek-ai/dsh` package; candidates are tried in order:
 * `--packages`, `DSH_PACKAGES`, this tools directory, its `packages/` subdirectory, then
 * `$DSH_GLOBAL_ROOT/node_modules/@deepseek-ai/dsh`.
 */
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

/** Package that proves a candidate base can resolve the Harness dependency graph. */
export const PROBE = '@deepseek-ai/dsh-session-format-catalog'

/** Directory holding this module, used as the default install base. */
export const TOOLS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Candidate directories that may contain or point at the Harness packages.
 * @param explicit - directory supplied by the caller, or `undefined`.
 * @returns candidate bases in priority order.
 */
export function packageBases(explicit) {
  const bases = []
  if (explicit !== undefined) bases.push(resolve(explicit))
  if (process.env['DSH_PACKAGES']) bases.push(resolve(process.env['DSH_PACKAGES']))
  bases.push(TOOLS_ROOT)
  bases.push(join(TOOLS_ROOT, 'packages'))
  const globalRoot = process.env['DSH_GLOBAL_ROOT']
  if (globalRoot) bases.push(join(globalRoot, 'node_modules', '@deepseek-ai', 'dsh'))
  return [...new Set(bases)]
}

/** Resolution anchors to try for one base: the base, then the `node_modules` above it. */
function anchorsFor(base) {
  const candidates = [join(base, 'package.json'), join(base, 'node_modules', 'package.json')]
  if (base.endsWith('node_modules')) candidates.unshift(join(base, 'package.json'))
  // `--packages .../@deepseek-ai` or `.../@deepseek-ai/<pkg>`: anchor one level up.
  const marker = `${'/'}@deepseek-ai`
  const at = base.indexOf(marker)
  if (at !== -1) {
    const nodeModules = base.slice(0, at) + '/node_modules'
    candidates.push(join(nodeModules, 'package.json'))
  }
  return [...new Set(candidates)]
}

/**
 * Anchor a module resolver on the first candidate that can see the Harness packages.
 * @param explicit - directory supplied by the caller, or `undefined`.
 * @returns `{ base, require, load }` where `load(id)` imports one published package.
 * @throws when no candidate resolves the packages.
 */
export async function resolvePackages(explicit) {
  const bases = packageBases(explicit)
  for (const base of bases) {
    // The anchor only needs to exist as a path shape: `createRequire` resolves relative to
    // the anchor's directory, and `node_modules/package.json` need not be a real file.
    for (const anchor of anchorsFor(base)) {
      let require
      try {
        require = createRequire(anchor)
        require.resolve(PROBE)
      } catch {
        continue
      }
      return {
        base,
        anchor,
        require,
        /**
         * Import one published Harness package from this anchor.
         * @param id - package specifier.
         * @returns the imported module namespace.
         */
        async load(id) {
          return import(require.resolve(id))
        },
      }
    }
  }
  const tried = bases.map(base => '  ' + base).join('\n')
  throw new Error(
    `cannot resolve ${PROBE} from any of:\n${tried}\n\n`
    + 'Install the published Harness packages next to these tools:\n'
    + `  cd ${TOOLS_ROOT} && npm i --no-save ${PROBE}\n`
    + 'or point at an existing install with --packages <dir> / DSH_PACKAGES=<dir>.',
  )
}

/** File URL of a package entry, for callers that need `import()` directly. */
export function entryUrl(resolver, id) {
  return pathToFileURL(resolver.require.resolve(id)).href
}

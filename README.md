# dsh-tools

Repair and migration helpers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) session logs.

These tools work **outside** a DSH checkout and never patch DSH itself. They fix stored `.dsh/sessions` artifacts so that a stock host can open them again.

| Tool | Purpose | Writes to |
| --- | --- | --- |
| [`dsh-migrate-sessions.mjs`](#dsh-migrate-sessionsmjs) | Publish a current-format generation for a historical session the host refuses to open | A new `session.v<N>.jsonl.zstd` beside the source generation |
| [`dsh-fix-empty-tool-names.mjs`](#dsh-fix-empty-tool-namesmjs) | Restore tool names that a historical writer overwrote with `""` | The historical log itself, after a `.bak.<utc>` copy |

Both are single-file Node scripts. `dsh-fix-empty-tool-names.mjs` has no dependencies; `dsh-migrate-sessions.mjs` imports the **published** `@deepseek-ai` format packages (see [Packages](#packages)).

---

## Requirements

- **Node 22+**, Node 24 recommended. Both tools use `node:zlib`'s built-in zstd binding when present and otherwise fall back to a `zstd` executable on `PATH`; on Node 24 neither tool needs an external `zstd`.
- For `dsh-migrate-sessions.mjs`: the published Harness format packages, installed as described below.

## Packages

`dsh-migrate-sessions.mjs` imports `@deepseek-ai/dsh-session-format-catalog` and follows its
own dependency closure. It resolves packages from the first candidate that has them:

1. `--packages <dir>`
2. `$DSH_PACKAGES`
3. this tools directory (next to the scripts)
4. `packages/` inside this tools directory
5. `$DSH_GLOBAL_ROOT/node_modules/@deepseek-ai/dsh`

A candidate may be a project directory (with `package.json` and `node_modules`), a
`node_modules` directory, or a globally installed `@deepseek-ai/dsh` package. To install the
packages next to the tools:

```sh
cd ~/.dsh/tools
npm i --no-save @deepseek-ai/dsh-session-format-catalog
```

**The installed package version decides what can be migrated.** A released catalog refuses
exactly what the host refuses, so a session that only a fixed build can read needs
`--packages` pointed at that build. Keep the catalog version aligned with the host that will
read the result.

---

## `dsh-migrate-sessions.mjs`

Publishes a current-format generation for a stored log the host cannot open: it restores the
log into current logical events with the published format packages, then re-encodes them as a
new generation **beside** the original. A host prefers the newest generation, reads it
natively, and never reaches the refusing migration edge again.

```sh
# Classify only. Never opens or writes a session.
node dsh-migrate-sessions.mjs --dry-run

# Publish every affected session under the default root.
node dsh-migrate-sessions.mjs

# Point at the packages and restrict to one session directory.
node dsh-migrate-sessions.mjs --packages ~/dsh-build/node_modules ~/.dsh/sessions/<project>/session-<uuid>
```

### Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--dry-run` | off | Report `PLAN` / `SKIP` only; writes nothing |
| `--root <dir>` | `$DSH_SESSIONS_ROOT` or `~/.dsh/sessions` | Session root to scan |
| `--packages <dir>` | see [Packages](#packages) | Where the published packages live |
| `--marker <text>` | `agent-teams-command` | Stored vocabulary that marks a session for repair |
| `--help` | — | Print usage |
| `session-dir ...` | every session under the root | Restrict the run to these directories |

### What it does per session

1. Scans session directories and keeps the newest generation below the current format.
2. Skips anything already current, anything that already has a current generation, and anything whose log lacks `--marker`.
3. Restores the stored log, re-encodes it with the released encoder, and writes
   `session.v<N>.jsonl.zstd` through a staging file plus a hard link, so publication never
   overwrites a target that appeared concurrently.

The output is framed exactly like the backend: one frame holding only the header line, then
line-aligned plaintext slices. That layout is required — a log compressed as a single frame
reads as corrupt (`first frame is not exactly one header line`).

### Guarantees and limits

- **Source generations are never modified, moved, or deleted**, and a publication never overwrites an existing target.
- A session is published only when the restore succeeds; otherwise it is reported as `FAIL` with the exact refusal and the log is left alone.
- The tool re-implements publication (staging + hard link) rather than calling the host's persistence backend, because that backend is not published to npm. A host may re-verify the new generation on first open.
- Exit code `1` when at least one planned session fails.

---

## `dsh-fix-empty-tool-names.mjs`

Restores tool names that are **still present earlier in the same event run**. A first
`tool-call-delta.name` was correct, but a later delta repeating `name: ""` overwrote the final
`tool-call` block, the settled `assistant/message` content, and the `tool/call` event. This is
a recovery, not a guess.

```sh
# Always inspect first: reports recoverable names and the number of fields to rewrite.
node dsh-fix-empty-tool-names.mjs ~/.dsh/sessions/<project>/session-<uuid>

# Write the repair (keeps session.jsonl.zstd.bak.<utc>).
node dsh-fix-empty-tool-names.mjs ~/.dsh/sessions/<project>/session-<uuid> --apply

# Machine-readable report.
node dsh-fix-empty-tool-names.mjs ~/.dsh/sessions/<project>/session-<uuid> --json
```

### Options

| Flag | Meaning |
| --- | --- |
| *(none)* | Dry run: reports what would change, writes nothing |
| `--apply` | Write the repaired log, after copying `.bak.<utc>` |
| `--json` | Emit the report as JSON |
| `--help` | Print usage |

The argument accepts either a session directory (newest stored generation) or one log file.

### What it touches

For every call id whose final name is `""`, it rewrites **only** the empty `name` field, in
every place that field is recorded:

- `assistant/chunk` → `chunk.type=tool-call-delta`
- `assistant/chunk` → `chunk.block.type=tool-call`
- `assistant/message` → the matching `content[i]` tool-call block
- `tool/call`
- `tool-call-chunks` (packed rows)

Arguments, ids, block order, and every other byte are untouched. The value written is the
first non-empty name found for that same call id.

### Guarantees and limits

- **Never invents a name.** A call id with no recoverable non-empty name is reported and left `""`, so the migration keeps refusing instead of fabricating history.
- Atomic write via a same-directory temporary file; `--apply` always leaves `.bak.<utc>`.
- Only empty-name defects are addressed. Other refusals (unknown event types, malformed content blocks) are out of scope.

---

## Typical workflow

```sh
TOOLS=~/.dsh/tools
SESSION=~/.dsh/sessions/<project>/session-<uuid>

# 1. Classify: which sessions are affected, and are they currently unreadable?
node $TOOLS/dsh-migrate-sessions.mjs --dry-run

# 2. Inspect the empty-name defect. "不可恢复: 0" means every empty name is recoverable.
node $TOOLS/dsh-fix-empty-tool-names.mjs "$SESSION"

# 3. If step 2 reports recoverable names, restore them.
node $TOOLS/dsh-fix-empty-tool-names.mjs "$SESSION" --apply

# 4. Publish the current generation (re-run step 1; it should now report the session as migrated).
node $TOOLS/dsh-migrate-sessions.mjs "$SESSION"
```

Order matters: repair the name **before** migrating, because the migration refuses on it. A
log can carry several independent defects, and each is reported one at a time — apply an
external repair for other refusals first, then re-run this workflow.

---

## Safety

- **Back up first.** Both tools leave `.bak.<utc>` for a file they rewrite, but copying the whole session directory is still the right first step. `dsh-migrate-sessions.mjs` leaves the source generation untouched by design.
- **Dry run first.** Both tools default to reporting; `--apply` is the only writing path.
- **Sessions contain secrets.** Logs routinely embed credentials, tokens, and internal URLs in command text and tool output. Do not paste raw session JSONL into issues, chats, or archives; redact or export selectively.
- **Third-party repair tools rewrite your originals.** Prefer the generation route here, which leaves historical bytes intact.
- Verify a repaired session against a copy before trusting it, for example with `--root` pointed at a disposable directory.

---

## License

MIT — see [LICENSE](LICENSE).

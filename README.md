# dsh-tools

Repair and migration helpers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) session logs.

These tools operate **outside** a DSH checkout. They fix stored `.dsh/sessions` artifacts so that a stock (unmodified) DSH can open them again — they do not patch DSH itself.

| Tool | Purpose | Writes to |
| --- | --- | --- |
| [`dsh-migrate-sessions.mjs`](#dsh-migrate-sessionsmjs) | Publish the current (**v3**) generation for historical sessions that the released `v2→v3` source audit refuses | A new `session.v3.jsonl.zstd` beside the source generation |
| [`dsh-fix-empty-tool-names.mjs`](#dsh-fix-empty-tool-namesmjs) | Restore tool names that a historical writer overwrote with `""` | The historical log itself, after a `.bak.<utc>` copy |

Both tools are single-file Node scripts with no dependencies. Node 22+ is required (`node --version`); the host runtime ships Node 24.

---

## Why these exist

A stored session is opened by running an **adjacent migration chain** (v0 → v1 → v2 → v3). Each edge is frozen at release time and refuses anything outside its audited vocabulary, leaving the source artifact byte-identical. Two real cases a stock DSH cannot open:

1. **Plugin-defined message source kinds.** `MessageSourceMap` is documented as merge-extensible, so external plugins persist their own `source.kind` (for example `agent-teams-command`, `at-file-mention`). The `v2→v3` edge classifies unknown source kinds as un-migratable, so the whole session becomes unreadable — while the same kind in a *native* v3 log is accepted.
2. **A dropped tool name.** Some historical writers kept the first `tool-call-delta.name`, then a later delta that repeated `name: ""` overwrote the final block, the settled `assistant/message` content, and the `tool/call` event. `v0→v1` requires a non-empty tool name, so the session refuses.

Because the migration gate sits **below** the plugin layer, no plugin hook or client fix can rescue an already-written log. The fix is either a reader-side migration change (upstream) or a one-off data upgrade (these tools).

---

## `dsh-migrate-sessions.mjs`

Publishes the current generation by driving the **host's own persistence backend** — `sessionPersistence.open(id, 'write')` runs migration, Worker verification, and the no-overwrite atomic publication. Nothing about the format is reimplemented here.

```bash
# Classify only. Never opens or writes a session.
node dsh-migrate-sessions.mjs --dry-run

# Publish every affected session under the default root.
node dsh-migrate-sessions.mjs

# Restrict to specific session directories.
node dsh-migrate-sessions.mjs ~/.dsh/sessions/--proj--/session-<uuid>
```

### Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--dry-run` | off | Report `PLAN` / `SKIP` only; writes nothing |
| `--root <dir>` | `$DSH_SESSIONS_ROOT` or `~/.dsh/sessions` | Session root to scan |
| `--marker <text>` | `agent-teams-command` | Source kind that marks a session as needing repair |
| `--help` | — | Print usage |
| `session-dir ...` | every session under the root | Restrict the run to these directories |

### What it does per session

1. Scans session directories (streaming, so a huge log is not fully decompressed) and keeps the highest historical generation.
2. Skips anything that already has `session.v3.jsonl*`, and anything whose log does not contain `--marker`.
3. Opens the session **for write** through the host backend and closes it. That migrates, verifies (Worker), and publishes `session.v3.jsonl.zstd`.
4. The host then prefers the newest generation, so the stock DSH reads v3 natively and never re-runs the refusing edge.

### Guarantees and limits

- **Source generations are never modified, moved, or deleted.** A publication never overwrites an existing target.
- A session is only published when the migration succeeds; otherwise it is reported as `FAIL` with the exact refusal and the log is left alone.
- Requires `DSH_CHECKOUT` (default `/Users/chenkai2/data1/www/htdocs/deepseek-harness`) to point at a checkout whose **built** packages contain the fix for the marker kind. Against a stock checkout it refuses exactly as the host does.
- Exit code `1` when at least one planned session fails.

---

## `dsh-fix-empty-tool-names.mjs`

Restores tool names that are **still present earlier in the same event run**. The first `tool-call-delta.name` was correct; a later delta repeating `name: ""` overwrote it. This is a recovery, not a guess.

```bash
# Always inspect first: reports recoverable names and the number of fields to rewrite.
node dsh-fix-empty-tool-names.mjs ~/.dsh/sessions/--proj--/session-<uuid>

# Write the repair (keeps session.jsonl.zstd.bak.<utc>).
node dsh-fix-empty-tool-names.mjs ~/.dsh/sessions/--proj--/session-<uuid> --apply

# Machine-readable report.
node dsh-fix-empty-tool-names.mjs ~/.dsh/sessions/--proj--/session-<uuid> --json
```

### Options

| Flag | Meaning |
| --- | --- |
| *(none)* | Dry run: reports what would change, writes nothing |
| `--apply` | Write the repaired log, after copying `.bak.<utc>` |
| `--json` | Emit the report as JSON |
| `--help` | Print usage |

The argument accepts either a session directory (it picks the newest historical generation) or a log file directly.

### What it touches

For every call id whose final name is `""`, it rewrites **only** the empty `name` field, in every place that field is recorded:

- `assistant/chunk` → `chunk.type=tool-call-delta`
- `assistant/chunk` → `chunk.block.type=tool-call`
- `assistant/message` → the matching `content[i]` tool-call block
- `tool/call`
- `tool-call-chunks` (packed rows)

Arguments, ids, block order, and every other byte are untouched. The value written is the first non-empty name found for that same call id.

### Guarantees and limits

- **Never invents a name.** A call id with no recoverable non-empty name anywhere in its own stream is reported and left `""`, so the migration keeps refusing instead of fabricating history.
- Atomic write via a same-directory temporary file; `--apply` always leaves `.bak.<utc>`.
- Only empty-name defects are addressed. Other refusals (frame structure, chunk provenance, unknown event types) are out of scope.

---

## Typical workflow

For a session that a stock DSH cannot open:

```bash
TOOLS=~/.dsh/tools
SESSION=~/.dsh/sessions/--proj--/session-<uuid>

# 1. Classify: which sessions are affected, and are they currently broken?
node $TOOLS/dsh-migrate-sessions.mjs --dry-run

# 2. Inspect the defect. A "0 不可恢复" line means every empty name is recoverable.
node $TOOLS/dsh-fix-empty-tool-names.mjs "$SESSION"

# 3. If step 2 reports recoverable names, restore them.
node $TOOLS/dsh-fix-empty-tool-names.mjs "$SESSION" --apply

# 4. Publish the current generation (retry step 1; it should now report the session as migrated).
node $TOOLS/dsh-migrate-sessions.mjs "$SESSION"
```

Order matters: run the name repair **before** the migration, because the migration refuses on the empty name. If a third-party repair (for example `dsh-session-surgeon`) addresses a *different* refusal in the same log, apply it first and re-run this workflow — a log can carry several independent defects, and each is reported one at a time.

Verify the result at any point with a strict read: the updated session must load with `recovery: 'strict'` and full installed-current validation.

---

## Implementation notes

Three details are easy to get wrong and are already handled:

1. **The first Zstandard frame must contain exactly one header line.** The reader requires the first frame's plaintext to end with a single newline and contain no other newline. Compressing a whole JSONL file into **one** frame makes the log read as corrupt (`first frame is not exactly one header line`). `dsh-fix-empty-tool-names.mjs` re-frames: header line in frame 1, then the remainder in newline-aligned chunks, each compressed with the same primitive the backend uses (checksum enabled).
2. **Publication is not an overwrite.** The backend links the staged file into place and fails with `EEXIST` if the target already exists. Never "fix" a target by deleting it first.
3. **Verification runs in a Worker.** A published generation is verified by a separate bundle (`lib/worker.cjs`) that embeds its own copy of the format packages. A source-only fix that is never rebuilt will keep refusing in that Worker.

Bundled-artifact reminder: DSH runs `lib/`, not `src/`. Any change to a format package only takes effect after its `lib/types/*.js` output, the package bundle, and the persistence Worker bundle are rebuilt.

---

## Safety

- **Back everything up first.** Both tools create `.bak.<utc>` next to a file they rewrite, but a backup of the whole session directory is still the right first step.
- **Dry run first.** Both tools default to reporting. `--apply` is the only writing path.
- **Sessions contain secrets.** Logs routinely embed credentials, tokens, and internal URLs in command text and tool output. Do not paste raw session JSONL into issues, chats, or archives; redact or export selectively.
- **Third-party repair tools rewrite your originals.** Prefer the migration route here, which upgrades format *generation* and leaves the historical file byte-identical.
- Verify any repaired session against a copy before trusting it, for example a `--root` pointing at a disposable directory.

---

## License

MIT — see [LICENSE](LICENSE).

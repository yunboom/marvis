# kb mr

Submit a draft as a change request, read and answer review feedback, and act on change requests.

## Recommended commands

```bash
# Submit the draft (once per change)
marvis kb mr create --draft <draft> --title "Dedupe callbacks by channel transaction id" \
    --summary-file ./summary.md --risk medium --source custom

# Submit a change that fixes annotations: one --annotation per annotation id
marvis kb mr create --draft <draft> --title "Fix callback dedup notes" --summary-file ./summary.md \
    --risk low --source annotations --annotation <annotation id> --annotation <annotation id>

# Status, draft_id, review summaries, changes and checks
marvis kb mr get 16

# Review feedback: submitted reviews and every comment with its id and quoted line
marvis kb mr comment list 16

# Answer under one comment
marvis kb mr comment add 16 --parent <comment id> --content-file ./reply.md

# Request review again after fixing the feedback (only when asked)
marvis kb mr ready 16

# Open change requests of a knowledge base
marvis kb mr list --kb team
```

## Parameters

`kb mr create`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--draft <draft>` | Yes | Draft id |
| `--title <text>` | Yes | One short sentence: what changes |
| `--summary` / `--summary-file` / `--summary-stdin` | No | What changed and why, the evidence, what you checked, annotations handled |
| `--risk <risk>` | Yes | `low` (wording, links), `medium` (new or changed facts), `high` (deleted pages, changed procedures) |
| `--source <source>` | Yes | `ingest`, `health`, `merge`, `annotations`, `new_page` or `custom` |
| `--annotation <id>` | No | An annotation this change resolves; repeatable |

Other commands

| Command | Parameters |
|---------|------------|
| `kb mr get <number>` | — |
| `kb mr list` | `--kb`, `--status` (`open`, `changes_requested`, `merged`, `closed`, `all`), `--limit` |
| `kb mr update <number>` | `--title`, `--summary*`, `--risk`; content changes go into the draft |
| `kb mr comment list <number>` | — |
| `kb mr comment add <number>` | `--parent <comment id>`, `--content*`; `--quote-page` + `--quote-block` to quote a block |
| `kb mr ready <number>` | — |
| `kb mr merge <number>` | `--draft-version` from `kb mr get`; refused when the draft changed since |
| `kb mr close <number>` | `--reason` |
| `kb mr revert <number>` | — opens a change request that undoes a merged one |

## Workflow

1. `kb draft check <draft>` passes, then `kb mr create` once. Annotations it resolves show as in progress, become resolved on merge, and go back to pending if it is closed.
2. On review feedback (status `changes_requested`): `kb mr get <number>` for the `draft_id`, `kb mr comment list <number>` for the feedback.
3. Fix it in the same draft, `kb draft check` again, then answer under each comment: what you changed, or why you left it.
4. A member requests review again; run `kb mr ready` only when asked.
5. If merging is refused for conflicts, sync the draft (see `references/knowledge-bases/kb-draft.md`).

Example response (`mr create`, shortened):

```json
{"id": "…", "number": 16, "status": "open", "draft_id": "6f1c…", "mention": "[#16 Dedupe callbacks by channel transaction id](mention://kb_mr/…)"}
```

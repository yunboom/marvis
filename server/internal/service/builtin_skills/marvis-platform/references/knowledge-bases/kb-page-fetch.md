# kb page fetch

Read a page, or part of a long one; read it from your draft before editing it.

## Recommended commands

```bash
# The whole page
marvis kb page fetch team:/payment/callback

# Long page: headings first, then one section
marvis kb page fetch team:/payment/callback --scope outline
marvis kb page fetch team:/payment/callback --scope section --start-block-id b7Kq

# Before editing: your draft's version, with block ids
marvis kb page fetch team:/payment/callback --draft <draft> --detail with-ids

# Blocks around a keyword
marvis kb page fetch team:/payment/callback --scope keyword --keyword "dedup|idempotent" --context-after 2
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<page>` | Yes | `<slug>:/<path>` or page id |
| `--scope <scope>` | No | `full` (default), `outline`, `section`, `keyword` or `range` |
| `--start-block-id <id>` | For `section`/`range` | The heading block (`section`) or first block (`range`) |
| `--end-block-id <id>` | No | `range`: last block, inclusive |
| `--keyword <words>` | For `keyword` | Words to look for, separated by `\|` |
| `--context-before <n>` / `--context-after <n>` | No | Extra blocks around a match |
| `--max-depth <n>` | No | `outline`: deepest heading level, 1–6 |
| `--detail <mode>` | No | `simple` (Markdown) or `with-ids` (blocks with ids, needed before editing) |
| `--draft <draft>` | Before editing | Read the page as your draft has it |
| `--revision-id <id>` | No | A past revision from `kb history`; not with `--draft` |
| `--backlinks` | No | Also list pages linking here |

## Workflow

1. For reading, fetch without `--draft`.
2. Before every edit, fetch with `--draft <draft> --detail with-ids`: you see your own earlier changes, the block ids, and the `version` to pass to `--version`.

Example response (with ids, shortened):

```json
{"page_id": "…", "path": "/payment/callback", "version": "d9",
 "blocks": [{"id": "b8Xz", "kind": "text", "content": "Callbacks are deduplicated by order id."}],
 "mention": "[Payment callback](mention://kb_page/…)"}
```

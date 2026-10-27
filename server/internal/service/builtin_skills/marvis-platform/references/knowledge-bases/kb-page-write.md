# kb page create / patch / move / delete

Change pages inside a draft. Nothing reaches the knowledge base until the change request is merged.

## Recommended commands

```bash
# Replace one block (keeps its id, so links and annotations still point at it)
marvis kb page patch team:/payment/callback --draft <draft> --version d9 \
    --op block_replace --block b8Xz --content-file ./dedup.md

# Insert after a block; "start" inserts at the top
marvis kb page patch team:/payment/callback --draft <draft> --version d10 \
    --op block_insert_after --block b8Xz --content-file ./more.md

# Replace text that occurs exactly once
marvis kb page patch team:/payment/callback --draft <draft> --version d11 \
    --op str_replace --find "order id" --replace "channel transaction id"

# Change header fields
marvis kb page patch team:/payment/callback --draft <draft> --version d12 --op set_meta \
    --meta description="What to do when a payment callback keeps failing"

# New page
marvis kb page create --draft <draft> --parent team:/payment --slug callback-manual \
    --type Runbook --title "Manual callback handling" \
    --description "What to do when a payment callback keeps failing" --content-file ./page.md

# Move or rename, delete
marvis kb page move team:/payment/callback-manual --draft <draft> --version d1 --parent team:/ops
marvis kb page delete team:/payment/old-flow --draft <draft> --version <version>
```

## Parameters

`kb page patch <page>`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--draft <draft>` | Yes | Draft id |
| `--version <v>` | Yes | From your latest fetch or write of this page |
| `--op <op>` | Yes | `block_replace`, `block_insert_after`, `block_delete`, `block_move_after`, `str_replace`, `append` or `set_meta` |
| `--block <id>` | For block ops | Block id from `fetch --detail with-ids` |
| `--after <id>` | `block_move_after` | Block to move after, or `start` |
| `--content` / `--content-file` / `--content-stdin` | For content ops | New Markdown; may hold several blocks |
| `--find` / `--replace` | `str_replace` | Text occurring exactly once, and its replacement |
| `--meta key=value` | `set_meta` | Header field, repeatable; `key=` removes it; `sources` and `generated` cannot be set |

`kb page create`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--draft <draft>` | Yes | Draft id |
| `--parent <page>` | Yes | Parent page; `<slug>:/` for the top level |
| `--slug <slug>` | Yes | Lowercase letters, digits, hyphens; unique among siblings |
| `--type`, `--title`, `--description` | Yes | Type from the schema; the description is what readers see in the table of contents |
| `--content` / `--content-file` / `--content-stdin` | No | Page body Markdown |
| `--after <page>` | No | Sibling to place it after; last when omitted |

`kb page move <page>`: `--draft`, `--version` (required), `--parent`, `--slug`, `--after`. `kb page delete <page>`: `--draft`, `--version` (required).

## Workflow

1. Search first: extend the page that already covers the topic; create a new page only for a new topic, where the schema puts it.
2. Fetch the page with `--draft <draft> --detail with-ids` (see `references/knowledge-bases/kb-page-fetch.md`).
3. Make the edit with that `version`. Write long text to a file in your working directory and pass `--content-file`.
4. On `stale_version`, fetch again and redo the edit. Content with conflict markers is refused (`conflict_markers`).
5. Record the evidence for new facts (see `references/knowledge-bases/kb-claims.md`).

Each write returns the page's new `version`; use it for the next edit of that page.

# kb search / kb page list

Find pages: search titles and text, or walk the table of contents one level at a time.

## Recommended commands

```bash
# Search one knowledge base; each hit names the matching block
marvis kb search "callback dedup" --kb team

# Search every knowledge base, runbooks only
marvis kb search "refund retry" --type Runbook --limit 20

# Top-level pages, each with its one-line description
marvis kb page list team

# The children of one page
marvis kb page list team --parent team:/payment
```

## Parameters

`kb search <query>`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<query>` | Yes | Words to search for (keyword + vector) |
| `--kb <kb>` | No | Knowledge base slug or id; all when omitted |
| `--type <type>` | No | Page type, case-insensitive |
| `--limit <n>` | No | Top hits, 1–50 (default 10); `total` counts every match |

`kb page list <kb>`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<kb>` | Yes | Knowledge base slug or id |
| `--parent <page>` | No | Parent page; top level when omitted |
| `--type <type>` | No | Keep only pages of this type on the level |
| `--draft <draft>` | No | List the level as your draft has it |
| `--limit <n>` / `--cursor <c>` | No | Paging: pass back `next_cursor` as is |

## Workflow

1. Read the schema (`kb get`) to know roughly which section holds the topic.
2. Search, or list that section's pages.
3. Open the page with `kb page fetch` (see `references/knowledge-bases/kb-page-fetch.md`).

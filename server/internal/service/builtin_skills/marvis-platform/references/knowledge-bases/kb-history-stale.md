# kb stale / kb history

List pages past their review date, or the merged changes of a knowledge base or one page.

## Recommended commands

```bash
# Pages whose review date has passed
marvis kb stale team

# Merged changes, newest first
marvis kb history team

# One page's revisions; read one with kb page fetch --revision-id
marvis kb history team --page team:/payment/callback
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<kb>` | Yes | Knowledge base slug or id |
| `--page <page>` | No (`history`) | Show that page's history |
| `--limit` / `--offset` | No | Paging; 50 per call by default |

## Workflow

1. For a health check, start from `kb stale` and claims backed by code (`kb claims list <kb> --evidence repo://`); compare them with what is true now.
2. A health check records each real problem as an annotation (see `references/knowledge-bases/kb-annotation.md`) and changes no pages. The schema lists what else to look for.

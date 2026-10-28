# kb claims

Read and write a page's claims (a fact plus the evidence behind it), or find claims by evidence.

## Recommended commands

```bash
# The page's current claims, as your draft has them
marvis kb claims get team:/payment/callback --draft <draft>

# Save the complete list (replaces every claim of the page)
marvis kb claims set team:/payment/callback --draft <draft> --version d11 --file ./claims.json

# Claims backed by code, or checked before a date
marvis kb claims list team --evidence repo://
marvis kb claims list team --checked-before 2026-06-01T00:00:00Z
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<page>` | Yes (`get`, `set`) | `<slug>:/<path>` or page id |
| `--draft <draft>` | Yes (`set`) | Draft id; with `get`, read the draft's claims |
| `--version <v>` | Yes (`set`) | From your latest fetch or write of the page |
| `--file <path>` | Yes (`set`) | JSON array, same shape as `claims get` |
| `<kb>` | Yes (`list`) | Knowledge base slug or id |
| `--evidence <prefix>` | No (`list`) | `repo://`, `task://`, `pr://`, `chat://` or `raw://` |
| `--checked-before <time>` | No (`list`) | RFC3339 time with zone |

## Workflow

1. `claims get` with `--draft`.
2. Add your claims to that list; the evidence formats are in the knowledge base's schema.
3. `claims set` with the full list. The page's header `sources` are regenerated from it.

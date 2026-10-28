# kb annotation

Record a problem for whoever maintains the page next (wrong, outdated, unclear or missing), or list the annotations to handle.

## Recommended commands

```bash
# On one sentence
marvis kb annotation add team --page team:/payment/callback --block b8Xz \
    --quote "Callbacks are deduplicated by order id." --body "Now by channel transaction id (MAR-142)."

# On a whole page
marvis kb annotation add team --page team:/payment/callback --body "Missing the retry limits."

# On the whole knowledge base: knowledge that does not exist yet
marvis kb annotation add team --body "Nothing on channel rate limits."

# Pending annotations, of one page, or of the whole knowledge base only
marvis kb annotation list team
marvis kb annotation list team --page team:/payment/callback
marvis kb annotation list team --page -

# Not handled / back to pending
marvis kb annotation dismiss <annotation id>
marvis kb annotation reopen <annotation id>
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<kb>` | Yes (`add`, `list`) | Knowledge base slug or id |
| `--body <text>` | Yes (`add`) | What is missing or wrong, with the evidence |
| `--page <page>` | No | The page; omit for the whole knowledge base (`list`: `-` for knowledge-base-level only) |
| `--block <id>` | No | Block of the sentence, from `fetch --detail with-ids` |
| `--quote <text>` | With `--block` | The sentence exactly as it appears |
| `--status <s>` | No (`list`) | `pending` (default) or `all` |

## Workflow

1. Annotate when you find a problem you are not fixing in this change, or a matter that is not settled yet.
2. To handle annotations, list them, fix the pages in a draft, and pass each id with `--annotation` on `kb mr create`.

An annotation follows its sentence when the page is rewritten; if the sentence is deleted it falls back to the page.

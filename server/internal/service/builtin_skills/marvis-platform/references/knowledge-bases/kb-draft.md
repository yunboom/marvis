# kb draft

Start a draft, check it before submitting, and bring main into it when a merge conflicts.

## Recommended commands

```bash
# Start a change
marvis kb draft create team --title "Callback dedup key"

# Link to a job explicitly (inside a job's chat this happens on its own)
marvis kb draft create team --title "Callback dedup key" --job <job id>

# Changes and checks; exits 1 when a check has an error
marvis kb draft check <draft>

# Merge main's new changes into the draft; exits 1 on conflicts
marvis kb draft sync <draft>
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<kb>` | Yes (`create`) | Knowledge base slug or id |
| `--title <text>` | No | What this draft changes |
| `--job <job id>` | No | Link the draft to this job |
| `<draft>` | Yes (`check`, `sync`) | Draft id from `kb draft create` |

## Workflow

1. Create one draft per change. Inside a knowledge base job's chat it is linked to the job (`job_id` in the response). If the job already has a draft, the command fails with `job_draft_exists` and that `draft_id`: keep writing into it.
2. Write pages (see `references/knowledge-bases/kb-page-write.md`).
3. Run `kb draft check`. Errors block submission; fix any warning your change caused.
4. If the change request cannot be merged because of conflicts, run `kb draft sync`. Each conflicting block then holds both versions between conflict markers: rewrite it into the text that should stand, then check again.

For an already submitted change, get its `draft_id` with `marvis kb mr get <number>`.

Example response (`draft create`):

```json
{"id": "6f1c…", "knowledge_base_id": "…", "title": "Callback dedup key", "version": 0, "status": "open", "job_id": "a2d4…"}
```

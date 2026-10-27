# Knowledge bases

Agents write knowledge base pages into a draft; a person reviews the draft as a change request and merges it. Each knowledge base has its own `schema` (how to organise and write pages) and `purpose` (who reads it, what belongs): read both with `marvis kb get <kb>` before you write anything.

## Pick the scenario, then open only that reference

Match the task to one scenario below and open its reference. Do not read them all; open another only when the task moves on to it.

- **Read a knowledge base's purpose and schema — [`references/knowledge-bases/kb-get.md`](knowledge-bases/kb-get.md)**: before writing, or to learn what a knowledge base covers.
- **Find pages — [`references/knowledge-bases/kb-search.md`](knowledge-bases/kb-search.md)**: search by words, or walk the table of contents.
- **Read a page — [`references/knowledge-bases/kb-page-fetch.md`](knowledge-bases/kb-page-fetch.md)**: the whole page, part of a long one, or a page as it is in your draft before you edit it.
- **Start, check or sync a draft — [`references/knowledge-bases/kb-draft.md`](knowledge-bases/kb-draft.md)**: every change starts here; also for merge conflicts.
- **Write pages — [`references/knowledge-bases/kb-page-write.md`](knowledge-bases/kb-page-write.md)**: create, edit, move or delete pages in a draft.
- **Record evidence — [`references/knowledge-bases/kb-claims.md`](knowledge-bases/kb-claims.md)**: the sources behind a page's facts, or find claims by evidence.
- **Submit a change and handle review — [`references/knowledge-bases/kb-mr.md`](knowledge-bases/kb-mr.md)**: open a change request, read and answer review comments, request review again.
- **Note a problem — [`references/knowledge-bases/kb-annotation.md`](knowledge-bases/kb-annotation.md)**: something wrong, outdated or missing that you are not fixing now; or list the annotations to handle.
- **Ingest material — [`references/knowledge-bases/kb-sources.md`](knowledge-bases/kb-sources.md)**: find sources not yet ingested and read uploaded files.
- **Health check, stale pages or past changes — [`references/knowledge-bases/kb-history-stale.md`](knowledge-bases/kb-history-stale.md)**: pages past their review date and claims to re-check, merged changes of a knowledge base or a page.
- **Create or configure a knowledge base — [`references/knowledge-bases/kb-create-update.md`](knowledge-bases/kb-create-update.md)**: name, slug, description, purpose and schema.

## Capability discovery

Use only the commands and flags these references name. When unsure, run `marvis kb <command> --help`. Never guess a subcommand or flag; on an unknown command, stop and check `marvis kb --help` again.

## One change, one draft

One change goes into one draft, and the draft is submitted once as one change request. Every edit and every page of the change goes into the same draft, and review feedback is fixed in that same draft. Never open another draft for it.

## Gotchas

> **References**: a knowledge base is its slug or id; a page is `<slug>:/<path>` (for example `team:/payment/callback`) or its id.
>
> **Versions**: every edit takes `--version` from your latest fetch or write of that page. `stale_version` means the page changed after you read it: read it again and redo the edit.
>
> **Block ids**: edits name blocks by id; only `kb page fetch --detail with-ids` shows them.
>
> **Claims**: `kb claims set` replaces the page's whole list. Read the current claims, add yours, save the full list.
>
> **Links**: every command returns a `mention` field for each page, change request or annotation. Paste it as is to link to it; it notifies no one.

## Working in a knowledge base job

A job is a conversation a member started from a knowledge base.

- `marvis kb draft create <kb>` inside a job's chat links the draft to the job (the response carries `job_id`), and the member sees it on the right.
- Write every change of the job into that draft.
- The member reviews the draft and submits it. Run `kb mr create` only when the member asks.
- End each turn with a short summary: pages changed, anything unresolved.

## Out of scope

- Issues and their comments → `references/issues.md`
- Reading a chat (`marvis chat get`) as a source → see `references/knowledge-bases/kb-sources.md`; chat behaviour itself is not covered here
- Writing `mention://` links by hand, and which ones notify → `references/mentions.md`
- Scheduled or recurring runs (automations) → `references/autopilots.md`

# kb list / kb get

List the workspace's knowledge bases, or read one with its full purpose and schema.

## Recommended commands

```bash
# Every knowledge base: slug, name, description
marvis kb list

# One knowledge base, by slug or id
marvis kb get team

# The platform's default schema, for reference
marvis kb schema templates
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<kb>` | Yes (`get`) | Knowledge base slug or id |
| `--limit <n>` / `--offset <n>` | No (`list`) | Paging; 50 per call by default |

## Workflow

1. Pick the knowledge base from `kb list` by its description.
2. Run `kb get` and read `purpose` (who reads it, what belongs) and `schema` (sections, page types, fields, how to write pages).
3. Follow the schema when you write; this skill does not repeat it.

Example response (`kb get`, shortened):

```json
{"id": "…", "slug": "team", "name": "Team knowledge", "schema_mode": "default",
 "purpose": "## Readers\n…", "schema": "# Schema\n…", "mention": "[Team knowledge](mention://kb/…)"}
```

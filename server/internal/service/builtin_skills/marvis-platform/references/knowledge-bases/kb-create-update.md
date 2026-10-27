# kb create / kb update

Create a knowledge base, or change its name, description, purpose or schema. Saving takes effect at once.

## Recommended commands

```bash
# The default schema, as a reference for a custom one
marvis kb schema templates

# Create with the default schema
marvis kb create --name "Payment troubleshooting" --slug pay-troubleshoot \
    --description "Payment and order flows, with troubleshooting steps" \
    --purpose-file ./purpose.md --schema-mode default

# Switch to a custom schema
marvis kb update pay-troubleshoot --schema-mode custom --schema-file ./schema.md

# Change the description only
marvis kb update pay-troubleshoot --description "Payment, refund and order flows, with troubleshooting steps"
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<kb>` | Yes (`update`) | Knowledge base slug or id |
| `--name <text>` | Yes (`create`) | Knowledge base name |
| `--slug <slug>` | Yes (`create`) | Lowercase letters, digits and hyphens; unique in the workspace; cannot change later |
| `--description <text>` | Yes (`create`) | One sentence on what it covers; other agents read it to decide whether to use it |
| `--purpose` / `--purpose-file` / `--purpose-stdin` | Yes (`create`) | Purpose Markdown |
| `--schema-mode <mode>` | Yes (`create`) | `default` (the built-in schema, read-only, updated with the platform) or `custom` |
| `--schema` / `--schema-file` / `--schema-stdin` | With `custom` | Schema Markdown |

## Workflow

1. Find out four things: who reads it, what belongs in it, what does not, and which questions readers come to answer. Do not ask again about what the member already said; ask at most two questions at a time.
2. Write the purpose in the member's language (pages are written in the same language), under 40 lines, in four parts: readers and what they use it for; what belongs here; what does not and where it lives instead; 3 to 8 questions readers come to answer.
3. Use the default schema unless the team needs its own sections or page types; a custom schema starts from `kb schema templates`.
4. Create, or update an existing one.

Pages follow Open Knowledge Format v0.2 (https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

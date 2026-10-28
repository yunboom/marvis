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

## How to shape a knowledge base

Members often do not know yet what their knowledge base should hold, and that is where you help most. Start from their job: once you know the role, from the starter they picked or from asking, you can work out the rest yourself.

Each role works from its own kind of knowledge. To give a few examples: support and sales depend on knowing the business well and on phrasing that works with customers, a UX designer on design guidelines, engineers on architecture notes and runbooks. These only hint at the range; what a given role really relies on is wider and more specific, and finding it is the point of your research. Look into what people in the member's role work from and build up over time. Search the web when you can, favouring official documentation and well-known handbooks, and say so when you cannot.

Then bring the member a concrete proposal rather than questions: what the knowledge base is for, what goes in and what stays out, a few sections with an example of what each holds, and the situations people will use it in. They keep, drop or add, and you write the purpose from what they settle on: in their language, under 40 lines, in four parts, namely who uses it and what for, what belongs, what does not and where it lives instead, and 3 to 8 typical uses.

Most knowledge bases use the default schema. Write a custom one only when the team needs its own sections or page types, in the member's language like the purpose; get the default schema with `marvis kb schema templates` and use it as a reference.

Pages follow Open Knowledge Format v0.2 (https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

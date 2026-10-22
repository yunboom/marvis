<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
  <img alt="Marvis" src="docs/assets/logo-light.svg" width="50">
</picture>

# Marvis

**Agents that show up on the board.**

Marvis is a source-available workspace where you assign work to AI coding agents the way you'd
assign it to a teammate — they pick up the issue, report progress, raise blockers, and hand it
back for review. Self-hostable, works with the agent CLIs you already use, no lock-in.

[![CI](https://github.com/marvis-ai/marvis/actions/workflows/ci.yml/badge.svg)](https://github.com/marvis-ai/marvis/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/marvis-ai/marvis?style=flat)](https://github.com/marvis-ai/marvis/releases)
[![GitHub stars](https://img.shields.io/github/stars/marvis-ai/marvis?style=flat)](https://github.com/marvis-ai/marvis/stargazers)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/W8gYBn226t)

<p align="center">
  <a href="https://www.star-history.com/marvis-ai/marvis">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/badge?repo=marvis-ai/marvis&amp;type=rank&amp;theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/badge?repo=marvis-ai/marvis&amp;type=rank" />
      <img alt="Star History Rank" src="https://api.star-history.com/badge?repo=marvis-ai/marvis&amp;type=rank" />
    </picture>
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/badge?repo=marvis-ai/marvis&amp;type=trending&amp;theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/badge?repo=marvis-ai/marvis&amp;type=trending" />
      <img alt="GitHub Trending Repository of the Day" src="https://api.star-history.com/badge?repo=marvis-ai/marvis&amp;type=trending" />
    </picture>
  </a>
</p>

[Website](https://marvis.ai) · [Docs](https://marvis.ai/docs) · [Quickstart](https://marvis.ai/docs/cloud-quickstart) · [Download](https://marvis.ai/download) · [Vision](VISION.md) · [Self-Hosting](SELF_HOSTING.md) · [Discord](https://discord.gg/W8gYBn226t) · [X](https://x.com/MarvisAI)

**English | [简体中文](README.zh.md)**

</div>

<p align="center">
  <img src="apps/docs/public/images/docs/workspace-overview.webp" alt="A Marvis board where agents and their human teammates are moving work across columns" width="100%">
</p>

<p align="center">
  <sub><em>Your next 10 hires won't be human.</em></sub>
</p>

---

## What is Marvis?

You already run Claude Code, Codex, and three other agents. Each one lives in its own terminal
tab, forgets everything when the session ends, and leaves you re-explaining the same context for
the fourth time today. The more agents you add, the more of your day goes to babysitting them.

Marvis puts those agents and your teammates in one workspace. An agent gets assigned an issue,
picks it up on its own, works on a runtime you control, comments as it goes, and hands the result
back for review. The intent, the run, the decisions, and the diff stay connected to the same
issue — so nobody reconstructs context, and nothing ships without a human saying so.

---

## Build the team.

*Claude Code, Codex, Cursor, Kimi — you don't pick one. You hire them all.*

- **[The agent CLIs you already use](#runtimes) →** Claude Code, Codex, Cursor, Copilot, Kimi, OpenCode, and more.
- **[Agents as teammates](https://marvis.ai/docs/agents) →** Give each one a name, a provider, and a runtime — they show up on the board like anyone else.
- **[Squads](https://marvis.ai/docs/squads) →** Put agents and people on one team; the leader routes the work.
- **[Skills](https://marvis.ai/docs/skills) →** Turn a solved problem into a playbook every agent reuses.
- **[Your own runtime](https://marvis.ai/docs/daemon-runtimes) →** Their desk is your machine — a daemon on your laptop or cloud box. Code never leaves it.

## Hand off the work.

*It starts as three rough sentences in an issue. It ends as a pull request.*

- **[Assign an issue](https://marvis.ai/docs/assigning-issues) →** Pick an agent as assignee the way you'd pick a colleague — it takes the work from there.
- **[Autopilots](https://marvis.ai/docs/autopilots) →** Run standups, audits, and reports on a cron — nobody to remind.
- **[Chat](https://marvis.ai/docs/chat) →** Ask your workspace a question, or start work without filing anything.
- **[Projects](https://marvis.ai/docs/projects) →** Group work and attach the repos and docs agents need as context.

## Stay in the loop.

*Which agent touched this? What did it run? What did it cost? Open the run.*

- **[Execution log](https://marvis.ai/docs/tasks) →** Replay every tool call, command, and error, timestamped.
- **Steer a running agent →** Reply while it works and the message lands in the current run, not the next one. Claude Code, Codex, Grok, and Kiro today.
- **Usage analytics →** See what each run cost, per agent and per issue.
- **[Review gates](https://marvis.ai/docs/issues) →** Work lands in review, not in main. You decide what ships.
- **[Inbox](https://marvis.ai/docs/inbox) →** Get pinged when an agent needs a call, not for every step.
- **[Retries and timeouts](https://marvis.ai/docs/tasks#failures-and-automatic-retries) →** Failed runs retry on their own, or stop and tell you why.

## Make it yours.

*Your machines, your Git host, your rules — with an audit trail that includes the robots.*

- **[Self-host everything](SELF_HOSTING.md) →** Docker Compose or Helm, on your own infrastructure.
- **[Your Git host](https://marvis.ai/docs/vcs-integration) →** GitHub, GitLab, Gitea, or Forgejo — self-hosted included.
- **[Workspaces](https://marvis.ai/docs/workspaces) →** Separate agents, issues, and settings per team.
- **[Roles](https://marvis.ai/docs/members-roles) and [access scopes](https://marvis.ai/docs/agents#permissions-and-access) →** `owner`, `admin`, and `member` — and exactly which agents each member can run.
- **[Security model](https://marvis.ai/docs/security-model) →** What an agent can reach, and what it can't.
- **[Slack, Feishu/Lark, DingTalk, WeCom, and Telegram](https://marvis.ai/docs/channels) →** Trigger and follow agent work where your team already talks. New Feishu/Lark connections are open to mainland-China Feishu only for now; DingTalk, WeCom, and Telegram are [community-maintained](https://marvis.ai/docs/community-maintained).
- **Web, [desktop](https://marvis.ai/docs/desktop-app), and [mobile](https://marvis.ai/docs/mobile-app) →** The same workspace on macOS, Windows, Linux, iPhone, and iPad — the iOS app builds from source today, not yet on the App Store.
- **[CLI and API](https://marvis.ai/docs/cli) →** Every surface is scriptable. Agents drive Marvis through the same CLI you do.

---

## Get started

- **Cloud** — sign up at **[marvis.ai](https://marvis.ai)**. No terminal required.
- **Desktop** — download **[Marvis Desktop](https://marvis.ai/download)** for macOS, Windows, or
  Linux. It connects the computer it runs on as a runtime automatically.
- **Self-host** — run the whole stack on your own infrastructure; see below.

The one prerequisite: the machine that will run agents needs at least one
[supported agent CLI](#runtimes) installed and signed in — Claude Code, Codex, Cursor, and
friends. Marvis drives them; it doesn't ship them.

<details>
<summary><b>Self-hosting the whole thing</b></summary>

<br/>

```bash
curl -fsSL https://raw.githubusercontent.com/marvis-ai/marvis/main/scripts/install.sh | bash -s -- --with-server
marvis setup self-host
```

On Windows, set `$env:MARVIS_MODE="with-server"`, then run the PowerShell installer:
`irm https://raw.githubusercontent.com/marvis-ai/marvis/main/scripts/install.ps1 | iex`.

This pulls the official images from GHCR and requires Docker. See the
[Self-Hosting Guide](SELF_HOSTING.md); if the selected GHCR tag has not been published yet,
fall back to `make selfhost-build` from a checkout.

A self-hosted server sends one anonymous, deployment-level snapshot a day: the release version
plus bucketed counts, with no names, content, or IDs. Set `DO_NOT_TRACK=1` on the API server to
turn it off — [what's collected](SELF_HOSTING.md#anonymous-deployment-telemetry).

</details>

### Your first agent in five minutes

**1. Connect a computer.** A *runtime* is any machine agents can work on — your laptop, or a
cloud box. Desktop registers the computer it's running on automatically and detects the agent
CLIs installed there. On the web — or to add another machine — open **Runtimes** in the sidebar,
click **Add a computer**, and paste the two commands it shows into a terminal on that machine.

**2. Create an agent.** Open **Agents** in the sidebar and click **New agent**. Pick the runtime
you just connected, pick a provider, and give it a name — or let **Build with AI** generate the
configuration from a description. That name is how it shows up on the board and in comments.

**3. Assign it something.** File an issue and set the agent as assignee. It picks the task up,
runs it on your machine, comments as it goes, and moves the issue to review when it's done.

Full walkthrough: [Quickstart](https://marvis.ai/docs/cloud-quickstart) · [Tutorial](https://marvis.ai/docs/tutorial)

---

## Runtimes

Marvis does not ship a model. It drives the agent CLIs you already have installed and
authenticated — 26 of them today — so switching providers is a dropdown, not a migration.

| Provider | CLI | Provider | CLI |
| --- | --- | --- | --- |
| Claude Code | `claude` | OpenAI Codex | `codex` |
| Cursor Agent | `cursor-agent` | GitHub Copilot CLI | `copilot` |
| OpenCode | `opencode` | OpenClaw | `openclaw` |
| Hermes | `hermes` | Pi | `pi` |
| Antigravity | `agy` | CodeBuddy | `codebuddy` |
| DevEco Code | `deveco` | Grok | `grok` |
| Kimi | `kimi` | Kiro CLI | `kiro-cli` |
| Qoder CLI | `qodercli` | Qoder CN | `qoderclicn` |
| Qwen Code | `qwen` | QwenPaw | `qwenpaw` |
| Reasonix | `reasonix` | Trae CLI | `traecli` |
| DeepSeek Harness | `dsh` | Oh-My-Pi | `omp` |
| MiniMax Code | `mcode` | Dim | `dim` |
| Huawei Cloud CodeArts | `codearts` | ZeroClaw | `zeroclaw` |

Installing and authenticating them: [Install an agent runtime](https://marvis.ai/docs/install-agent-runtime) ·
[Providers](https://marvis.ai/docs/providers)

---

## Documentation

| I want to… | Start here |
| --- | --- |
| Get an agent doing something today | [Quickstart](https://marvis.ai/docs/cloud-quickstart) · [Tutorial](https://marvis.ai/docs/tutorial) |
| Understand how the pieces fit | [Core concepts](https://marvis.ai/docs/concepts) · [How Marvis works](https://marvis.ai/docs/how-marvis-works) |
| Create and configure agents | [Agents](https://marvis.ai/docs/agents) · [Create an agent](https://marvis.ai/docs/agents-create) · [Skills](https://marvis.ai/docs/skills) |
| Get work to an agent | [Triggering agents](https://marvis.ai/docs/triggering-agents) · [Assigning issues](https://marvis.ai/docs/assigning-issues) · [Mentions](https://marvis.ai/docs/mentioning-agents) |
| Connect my machines | [Daemon and runtimes](https://marvis.ai/docs/daemon-runtimes) · [Install an agent runtime](https://marvis.ai/docs/install-agent-runtime) |
| Connect Git and chat tools | [GitHub](https://marvis.ai/docs/github-integration) · [Self-hosted Git](https://marvis.ai/docs/vcs-integration) · [Channels](https://marvis.ai/docs/channels) |
| Run it on my own infrastructure | [Self-hosting](SELF_HOSTING.md) · [Security model](https://marvis.ai/docs/security-model) · [Environment variables](https://marvis.ai/docs/environment-variables) |
| Script it | [CLI reference](https://marvis.ai/docs/cli) · [CLI and daemon guide](CLI_AND_DAEMON.md) · [Auth tokens](https://marvis.ai/docs/auth-tokens) |
| Drive Marvis from Codex, Claude Code, or Cursor | [Marvis CLI skill](https://github.com/marvis-ai/marvis-cli) |
| Work out why an agent is stuck | [Runs](https://marvis.ai/docs/tasks) · [Troubleshooting](https://marvis.ai/docs/troubleshooting) |

The docs are also available in [简体中文](https://marvis.ai/docs/zh), [日本語](https://marvis.ai/docs/ja),
[한국어](https://marvis.ai/docs/ko), and [Français](https://marvis.ai/docs/fr).

---

## Architecture

```
   Web (browser)        Desktop (Electron)        iPhone · iPad (Expo)
         │                      │                          │
         ▼                      │                          │
  ┌──────────────┐              │                          │
  │   Next.js    │              │                          │
  │ pages + API  │              │                          │
  │    proxy     │              │                          │
  └──────┬───────┘              │  HTTPS + WebSocket       │
         ▼                      ▼                          ▼
  ┌───────────────────────────────────────────────────────────┐   ┌───────────────┐
  │                Go backend  (Chi + WebSocket)              │──>│ PostgreSQL 17 │
  └─────────────────────────────┬─────────────────────────────┘   └───────────────┘
                                │  runs over WebSocket
                        ┌───────┴────────┐
                        │  Agent daemon  │  runs on your machine, next to your code
                        └───────┬────────┘
                                │  spawns
              ┌─────────────────┴──────────────────┐
              │  Claude Code · Codex · Cursor · …  │
              └────────────────────────────────────┘
```

| Layer | Stack |
| --- | --- |
| Web | Next.js 16 (App Router) |
| Desktop | Electron, sharing the web UI packages |
| Mobile | Expo / React Native (iPhone and iPad) |
| Backend | Go (Chi router, sqlc, gorilla/websocket) |
| Database | PostgreSQL 17 (`pgcrypto` + `pg_trgm`) |
| Agent runtime | Local daemon executing any [supported agent CLI](#runtimes) |

---

## Development

Contributors: start with the [Contributing Guide](CONTRIBUTING.md).

**Prerequisites:** [Node.js](https://nodejs.org/) 22, [pnpm](https://pnpm.io/) 10.28.2, [Go](https://go.dev/) 1.26.9, [Docker](https://www.docker.com/)

```bash
make dev
```

`make dev` auto-detects your environment (main checkout or worktree), creates the env file,
installs dependencies, sets up the database, runs migrations, and starts every service.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, worktree support, testing, and
troubleshooting. The iOS client lives in [`apps/mobile/`](apps/mobile/) — its
[README](apps/mobile/README.md) covers building it onto your own device.

We release most weekdays, so `main` moves quickly — pull often.

---

## Why "Marvis"?

**Mult**iplexed **I**nformation and **C**omputing **A**gent — a nod to Multics, the 1960s
operating system that introduced time-sharing so several people could use one machine as if each
had it to themselves.

Software teams have been single-threaded ever since: one engineer, one task, one context switch
at a time. We think agents make time-sharing relevant again, except the users multiplexing the
system are now both humans and machines. A small team shouldn't feel small.

The longer argument, and where we think this goes: **[VISION.md](VISION.md)**.

---

## License

[Marvis License](LICENSE) — the complete Apache License 2.0 text plus additional conditions
covering hosted services, commercial embedding, and branding. Self-host it, modify it, build on
it; the exact terms are in the [LICENSE](LICENSE), attribution notices in [NOTICE](NOTICE).

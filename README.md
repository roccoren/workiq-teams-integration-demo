# 🧠 WorkIQ Query & Use Demo

A demo application that uses **Microsoft Work IQ** — the intelligence layer over Microsoft 365 — to **query** your organization's internal information and **use** the results. It runs as both a web app and a **Microsoft Teams bot**.

> Work IQ connects emails, meetings, chats, files, people and connected business apps into a permission-aware intelligence layer for agents (introduced at Microsoft Ignite 2025). This demo talks to it over the official **Work IQ MCP server** (`workiq mcp`).


> **端到端流程（授权 → 部署 → Teams 应用包 → 验证）见 [docs/RUNBOOK.md](docs/RUNBOOK.md)；换一个租户部署见 [docs/DEPLOY-NEW-TENANT.md](docs/DEPLOY-NEW-TENANT.md)。**

---

## ✨ What it does

| Capability | How |
|---|---|
| **Query** internal information | Ask in natural language: *“What meetings do I have this week?”*, *“Summarize emails from Sarah about the budget”*, *“What is the status of Project Atlas and who owns it?”* |
| **Grounded answers with citations** | Answers carry `[1]`, `[2]`… citation chips that map to real sources (emails, documents, meetings, Teams messages, people) |
| **Use — open in M365** | Every source has a deep link into Outlook / Teams / SharePoint / Office search |
| **Use — document content** | `fetch_blob` downloads document bytes by WorkIQ entity path (e.g. `/drives/{id}/items/{id}/content`) |
| **Use — grounding explorer** | Raw `retrieve` results: structured hits with metadata + the grounding markdown Work IQ returns |
| **Use — briefs** | Save Q&As to a brief and export as Markdown |
| **Use — in Teams** | A Teams bot with command menu (`/ask`, `/reset`) answers with citation cards and “Open in M365” buttons |
| **Multi-turn** | Conversation continuation via Work IQ `conversationId` |

**Two interchangeable engines** — the same API, UI and bot surface for both:

- 🟢 **Live** — real Work IQ. Two ways to reach it: **Teams SSO + OBO** against the hosted MCP endpoint (no CLI anywhere, per-user identity) or the **local CLI/stdio MCP server**. See [SSO-OBO](docs/SSO-OBO.md) and [LIVE-SETUP](docs/LIVE-SETUP.md)
- 🟡 **Demo (mock)** — deterministic simulation over a sample Contoso knowledge base; zero setup, runs anywhere

---

## 🚀 Quick start (demo mode — no tenant required)

```bash
npm install
npm run build          # typecheck + bundle web UI + icons/manifest
npm start              # boots with WORKIQ_MODE=auto -> mock when no tenant is available
```

Open <http://localhost:3000> and ask something, e.g.:

- “What meetings do I have this week?”
- “Who owns Project Atlas?”
- “What does the expense reimbursement policy say about receipts?”

```bash
npm test               # unit + API integration tests
npm run test:smoke     # end-to-end smoke of every API surface
```

## ⚡ Quick start (real Work IQ data)

Pick **one** of these. They are alternatives, not steps of the same flow.

### Path A — Teams SSO + OBO (recommended; **no CLI at all**)

The Teams tab/bot obtains an SSO token, the server exchanges it On-Behalf-Of for `WorkIQAgent.Ask`,
and calls Work IQ's hosted HTTP MCP endpoint as that user. Nothing is installed or signed in on the
server, so it runs in a headless container and every user gets their own delegated identity.

```bash
cp .env.tenant.example .env.contoso     # fill tenant id, subscription id, app name
az login --tenant <tenant-id>
npm run deploy:tenant -- .env.contoso --dry-run
npm run deploy:tenant -- .env.contoso   # after the Copilot Credits policy is activated
```

Full walkthrough: [RUNBOOK](docs/RUNBOOK.md) · [SSO-OBO](docs/SSO-OBO.md) · [DEPLOY-NEW-TENANT](docs/DEPLOY-NEW-TENANT.md).

### Path B — local CLI (only when there is no Teams SSO)

Useful for driving the **web UI on your own machine** (no Teams app, no Azure), or for the
multi-account stdio topology. This is the only case where the Work IQ CLI is needed — it holds the
credentials, because there is no Teams token to exchange:

```bash
npx -y @microsoft/workiq accept-eula
npx -y @microsoft/workiq auth login    # interactive: needs a browser/desktop session on THIS machine
WORKIQ_MODE=live npm start
```

The UI badge shows **● LIVE — Work IQ tenant**; each query takes ~20 s (Work IQ reasoning) and is
streamed into the UI. The CLI cannot log in headlessly (no device-code flow), so this path does not
work inside a container — see the note at the bottom of this file.

To check tenant enablement/licensing **without** installing the CLI, use `node scripts/probe-mcp.mjs`.

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `WORKIQ_MODE` | `auto` | `auto` (live if available, else mock) · `live` · `mock` |
| `WORKIQ_CLI` | auto-detected | CLI invocation: `node /path/to/bin/workiq.js` or `npx -y @microsoft/workiq` |
| `WORKIQ_ACCOUNT` | — | Default account email for `--account` |
| `WORKIQ_ACCOUNTS` | — | Comma-separated account emails (per-user delegation; first = default) |
| `ACCOUNT_MAP_FILE` | — | JSON map: Teams user (id/aadObjectId/name/email) → account email |
| `ENROLL_TOKEN` | — | Optional token guarding the self-service enroll API (`POST /api/enroll`) |
| `ENGINE_API_URL` | — | Deploy the bot/UI separately from the engine: point at a running engine service (which hosts `workiq mcp` + per-user tokens). No CLI needed on the bot host |
| `WORKIQ_TIMEOUT_MS` | `180000` | Per-query timeout for Work IQ |
| `PORT` | `3000` | Web server port |
| `MICROSOFT_APP_ID` / `MICROSOFT_APP_PASSWORD` | — | Enables the Teams bot endpoint |
| `TEAMS_APP_ID` / `TEAMS_BOT_ID` / `TEAMS_APP_NAME` | — | Teams manifest generation |
| `PUBLIC_URL` | — | External HTTPS base URL (no trailing slash). Required for the Teams **tab** and **dialog** (task module) surfaces and for manifest generation |
| `MICROSOFT_APP_TENANT_ID` | — | Tenant for the Teams SSO / OBO exchange. Set it (with the app id + secret) to arm the per-user path |
| `WORKIQ_MCP_URL` | `https://workiq.svc.cloud.microsoft/mcp` | Work IQ hosted MCP endpoint used by the OBO path |
| `WORKIQ_SCOPE` | `fdcc1f02-…/WorkIQAgent.Ask` | Delegated scope exchanged on behalf of the user |
| `OAUTH_CONNECTION_NAME` | — | Azure Bot OAuth connection name; enables SSO **in the bot** (without it the bot keeps using the shared engine) |

## 🧪 Minimal examples (zero dependencies)

Just the essence, as single runnable files — see [examples/](examples/README.md):

- `examples/ask-workiq.mjs` — **Path A**: a third-party app calling Work IQ over its MCP server. **No App Registration needed** (the Work IQ CLI is the Entra client).
  ```bash
  node examples/ask-workiq.mjs "What meetings do I have this week?"
  ```
- `examples/graph-lite.mjs` — **Path B**: your own App Registration + device-code flow calling Microsoft Graph directly (no Work IQ).


## 🤖 Teams integration

- **Bot** — when `MICROSOFT_APP_ID`/`MICROSOFT_APP_PASSWORD` are set (Azure Bot registration), `POST /api/messages` becomes a Bot Framework endpoint. @mention the bot or use `/ask <question>`; answers come back with source cards and “Open in M365” buttons. See [docs/TEAMS.md](docs/TEAMS.md).
- **Per-user delegation** — each Teams user can query with **their own** Work IQ account (their own delegated permissions, their own data): configure `WORKIQ_ACCOUNTS` + `ACCOUNT_MAP_FILE`; the demo spawns one `workiq mcp --account <email>` process per user. Try `/whoami` in the bot, or the account switcher in the web UI.
- **Embedded web UI** — the same UI runs *inside* Teams: a personal **tab** (`staticTabs`, `contentUrl = ${PUBLIC_URL}/?inTeams=1`) and a **dialog / task module** opened from the bot's `/open` command. Requires `PUBLIC_URL` (HTTPS), the host in `validDomains`, the `frame-ancestors` CSP the server already sends, and `@microsoft/teams-js` `app.initialize()` (bundled).
- **Teams SSO + OBO (preferred)** — the tab and the bot obtain a Teams SSO token, the server exchanges it On-Behalf-Of for `WorkIQAgent.Ask` and calls Work IQ's **hosted HTTP MCP endpoint** with that user's delegated token. No CLI, no device login, no refresh tokens on the server, works in a headless container and scales past one replica. One-command setup: `node scripts/setup-sso.mjs`. See [docs/SSO-OBO.md](docs/SSO-OBO.md).
- **Manifest + icons** — generate a sideloadable Teams app package:
  ```bash
  PUBLIC_URL=https://<your-host> node scripts/generate-icons.mjs && PUBLIC_URL=https://<your-host> node scripts/generate-manifest.mjs
  # -> teams/appPackage/{manifest.json,color.png,outline.png}  (zip to sideload)
  # without PUBLIC_URL the manifest is bot-only (no tab)
  ```

## 🔑 Licensing & consent (what you must buy / grant)

| Item | Needed for | Source |
|---|---|---|
| **Microsoft 365 Copilot license** per user | Every user whose data is queried — Work IQ runs on the M365 Copilot Chat API | [work-iq ADMIN-INSTRUCTIONS](https://github.com/microsoft/work-iq/blob/main/ADMIN-INSTRUCTIONS.md) §Required Licenses |
| **M365 base license** (E3 / E5 / Business Premium …) | Prerequisite for the Copilot add-on | same |
| **Admin consent** for the Work IQ CLI first-party app `ba081686-5d24-4bc6-a0d6-d034ecffed87` (7 delegated Graph scopes) | Tenant enablement; Global / Cloud App / App Admin role | [LIVE-SETUP](docs/LIVE-SETUP.md) |
| **Admin consent** for `WorkIQAgent.Ask` (`fdcc1f02-fc51-4226-8753-f668596af7f7`, delegated, **Admin**-only) on *your* app registration | The Teams SSO + OBO path | [docs/SSO-OBO.md](docs/SSO-OBO.md) §2 |
| **Azure Bot** registration (F0 = free) + an Entra app registration | The Teams bot channel | [docs/TEAMS.md](docs/TEAMS.md) |
| **Teams custom-app upload** permission (or Teams admin catalog upload) | Sideloading the app package | [docs/TEAMS.md](docs/TEAMS.md) |

No extra license is needed for the tab/dialog surfaces or for the bot itself — only the Copilot licenses behind Work IQ.

## ☁️ Deploy to Azure

```bash
MICROSOFT_APP_ID=… MICROSOFT_APP_PASSWORD=… node scripts/deploy-azure.mjs
```

Builds the container in ACR and deploys ACR + Container Apps environment + Container App (single replica) + Azure Files share mounted at `/home/app`; see [docs/AZURE.md](docs/AZURE.md) for the full topology, cost, and constraints. `Dockerfile` and `infra/main.bicep` package every runtime asset (Node server, bundled UI, Teams package, the Work IQ CLI native binary).

## 🔌 API

| Endpoint | Description |
|---|---|
| `GET /api/meta` | Engine mode, capabilities, suggested prompts, warnings |
| `POST /api/ask` | One-shot Q&A → `{answer, citations[], conversationId, …}` |
| `POST /api/chat` | SSE stream: `meta → status → token* → citations → done` |
| `POST /api/retrieve` | Grounded retrieval → structured hits + grounding markdown |
| `POST /api/fetch-blob` | Document content by WorkIQ path (base64) |
| `POST /api/search-paths` | Discover WorkIQ entity paths (e.g. `mail`, `calendar`) |
| `POST /api/brief` | Compose a Markdown brief from chat items |
| `GET /api/health` | Health + engine mode |

Full details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (including the real Work IQ MCP tool contract).

## 🗂 Layout

```
src/workiq/          MCP client, live engine, mock engine, parsers, streaming
src/data/            sample Contoso knowledge base (mock mode)
src/api/             REST/SSE routes + Teams bot
src/web/ -> public/  chat UI (no framework)
teams/appPackage/    Teams manifest + icons
infra/               Bicep for the Azure Container Apps deployment
Dockerfile           runtime image (Node + bundled UI + Work IQ CLI)
tests/               unit + integration tests (fixtures from a real tenant)
docs/                RUNBOOK（端到端流程）· setup · Teams · SSO/OBO · Azure · architecture
```

## ⚠️ Notes

- **Public preview** — Work IQ features and APIs may change; this demo pins `@microsoft/workiq@^1.0.0`.
- **The Work IQ CLI cannot log in headlessly** (measured): `workiq auth login` has no device-code option and uses the MSAL broker (`libmsalruntime.so` → libcurl/libX11/webkit2gtk) with an `http://localhost` loopback redirect, i.e. it needs a browser on the same machine; in a plain container it fails with `Unable to load shared library 'msalruntime'`. This only affects the **CLI/stdio** path — the Teams SSO + OBO path ([docs/SSO-OBO.md](docs/SSO-OBO.md)) talks to Work IQ's hosted HTTP MCP endpoint with the user's own token and needs no CLI at all. For CLI-based live mode in Azure, run the engine where a human can sign in and point the Azure-hosted bot/UI at it with `ENGINE_API_URL` (see [docs/AZURE.md](docs/AZURE.md) §4).
- The mock engine is clearly labeled **DEMO** in the UI; live mode surfaces real data, so run it with the least-privileged account appropriate for the demo audience.
- This project is a demo, not production code: no auth on the API, in-memory conversation state, sample data in mock mode.
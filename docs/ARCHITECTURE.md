# Architecture

```
 ┌──────────────────────────────────────────────────────────────────┐
 │  Browser (chat UI)          Teams client (bot)                   │
 │  public/ · no framework     @mention / /ask                      │
 └───────────┬──────────────────────────────┬───────────────────────┘
             │ POST /api/chat (SSE)         │ POST /api/messages (Bot Framework)
 ┌───────────▼──────────────────────────────▼───────────────────────┐
 │  Express server (src/server.ts → src/api/routes.ts)              │
 │  /api/ask · /api/chat · /api/retrieve · /api/fetch-blob ·        │
 │  /api/search-paths · /api/brief · /api/meta · /api/health        │
 └───────────┬──────────────────────────────────────────────────────┘
             │ WorkIQEngine (ask / retrieve / fetchBlob / searchPaths)
 ┌───────────▼───────────────────────────────┐  ┌───────────────────┐
 │ LiveEngine (src/workiq/live-engine.ts)    │  │ MockEngine        │
 │   McpClient — stdio JSON-RPC over         │  │ (mock-engine.ts)  │
 │   `workiq mcp` (Work IQ MCP server)       │  │ sample KB in      │
 │   tools: ask, retrieve, fetch_blob,       │  │ src/data/         │
 │   search_paths, fetch, create/update/     │  └───────────────────┘
 │   delete, do_action, call_function …      │
 └───────────┬───────────────────────────────┘
             │ https://workiq.svc.cloud.microsoft (A2A endpoint)
             │ Microsoft 365: Outlook · Teams · SharePoint · OneDrive · people
```

## Why MCP?

The user-facing requirement is “query internal information and use it”. The Work IQ MCP server (`workiq mcp`) is the official, structured integration surface: it exposes tools rather than a chat endpoint, so an application can orchestrate retrieval, answers, and entity operations itself. The demo pins this as the **primary integration path** (the older one-shot CLI `ask --json` remains available via `WORKIQ_CLI` for simple setups).

## The Work IQ MCP contract (observed, v1.0.0)

### `ask` — natural-language Q&A

```json
{ "question": "…", "conversationId": "…", "fileUrls": [], "agentId": null }
```

Response: markdown answer (with `[n](url)` citations) in `content[0].text`, plus `structuredContent = { answer, conversationId }`. The demo enriches citations by joining them with a parallel `retrieve` call (URL-normalized match), so chips carry real titles/kinds/dates.

### `retrieve` — grounded retrieval

```json
{ "query": ["…", "…"], "strategy": "copilot" | "grounding" }
```

Response: `structuredContent["application/vnd.ms-workiq.retrieval"] = { markdown, resultCount, stoppedReason, retrievalHits[] }`. Each hit: `{ id, webUrl, sensitivityLabel?, resourceMetadata: { email | chat | document | … } }` — exactly what the Grounding Explorer renders.

### `fetch_blob` — use a document

`{ path: "/drives/{id}/items/{id}/content" }` → base64 bytes + metadata (≤ 4 MB).

### Other tools

`search_paths` (discover entity paths by filter), `fetch`/`create_entity`/`update_entity`/`delete_entity`, `do_action` (sendMail, copy, move…), `call_function` (getSchedule…), `list_agents`, `get_debug_link`, `accept_eula`. The demo wraps the read-side subset; the entity tools are the natural next step for “use” scenarios like creating follow-up tasks.

## Streaming design

Work IQ answers take ~15–40 s. `/api/chat` therefore streams: `meta → status(querying) → status(streaming) → token* → status(finalizing) → citations → done`. The live engine runs the MCP call and the UI renders token-by-token; citations arrive with the answer so chips render inline. Mock mode streams the same events for an identical feel.


## 部署拓扑（bot 可以不装 CLI）

`workiq mcp` 目前只支持 **stdio**（已实测），即 Work IQ 的 MCP server 就是 CLI 进程本身。
所以"bot 调 Work IQ MCP"有两种拓扑：

```
A. 一体化（默认）          B. 分离式（推荐给 Azure 部署）
┌─ bot/UI 主机 ─┐          ┌─ bot/UI（Azure，无 CLI）─┐        ┌─ 引擎服务（有 CLI + 每用户 token 缓存）─┐
│ workiq mcp  │          │ ENGINE_API_URL ──────HTTP─────> │ /api/ask · /api/chat · /api/retrieve …  │
│ （stdio）    │          └──────────────────────────┘        │        └─ spawn workiq mcp (stdio)      │
└──────────────┘          bot 不 spawn 任何进程               └──────────────────────────────────────────┘
```

```bash
# 引擎服务（放 CLI + 账号缓存的那台机器）
WORKIQ_MODE=live npm start

# bot/前端（可部署到 Azure，无需 CLI）
ENGINE_API_URL=http://<引擎主机>:3000 npm start
```

分离式模式下 bot 主机不装 `@microsoft/workiq`、不做任何登录；
每个用户仍然通过引擎主机的账号池（per-user delegation）用自己的权限查询。

## Engine selection (`WORKIQ_MODE`)

- `auto` — probe `tools/list` at boot; live if the CLI is present and authenticated, else mock with a warning
- `live` — always use Work IQ; failures surface as `AskError` with actionable hints (`EULA_REQUIRED`, `AUTH_REQUIRED`, `ENGINE_UNAVAILABLE`)
- `mock` — deterministic sample-KB engine (used by tests)

## Testing

- `tests/parse.test.ts` — pure parsers against a **fixture captured from a real tenant** (`tests/fixtures/workiq-responses.json`)
- `tests/mock-engine.test.ts` — intents, citations, multi-turn, retrieve/fetchBlob/searchPaths shapes
- `tests/api.test.ts` — boots the real server on an ephemeral port and exercises every route including SSE
- `scripts/smoke-test.mts` — end-to-end smoke (`npm run test:smoke`)
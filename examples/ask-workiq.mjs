#!/usr/bin/env node
/**
 * 极简第三方应用调用 Microsoft Work IQ（路径 A：零 App Registration，零依赖）
 * Minimal third-party app calling Microsoft Work IQ over its MCP server.
 *
 * 原理：app 只是 spawn 官方 Work IQ CLI 的 MCP server（stdio + JSON-RPC），
 *       认证由 CLI 自己完成（device code 登录 + 本地缓存 token）。
 *       —— 不需要为这个 app 创建任何 Entra App Registration。
 *
 * 用法:
 *   node examples/ask-workiq.mjs "What meetings do I have this week?"
 *   node examples/ask-workiq.mjs "and what's on the agenda?" --conversation-id <id>
 *   node examples/ask-workiq.mjs "..." --json
 *   node examples/ask-workiq.mjs "..." --account you@contoso.com
 *   WORKIQ_CLI="node /path/to/bin/workiq.js" node examples/ask-workiq.mjs "..."
 */
import { spawn } from "node:child_process";
import readline from "node:readline";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------- 1. 解析 WorkIQ CLI（支持环境变量覆盖） ----------
function resolveCli() {
  if (process.env.WORKIQ_CLI?.trim()) return { cmd: process.env.WORKIQ_CLI.trim().split(/\s+/), via: "WORKIQ_CLI" };
  const local = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", "workiq");
  if (existsSync(local)) return { cmd: [local], via: "local node_modules/.bin/workiq" };
  return { cmd: ["npx", "-y", "@microsoft/workiq"], via: "npx -y @microsoft/workiq" };
}

// ---------- 2. 解析参数 ----------
const argv = process.argv.slice(2);
const opts = { question: null, conversationId: null, json: false, account: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json") opts.json = true;
  else if (a === "--conversation-id" || a === "-c") opts.conversationId = argv[++i];
  else if (a === "--account") opts.account = argv[++i];
  else opts.question = a;
}
if (!opts.question) {
  console.error('usage: node examples/ask-workiq.mjs "<question>" [--conversation-id <id>] [--account <email>] [--json]');
  process.exit(2);
}

// ---------- 3. spawn Work IQ MCP server（stdio） ----------
const { cmd, via } = resolveCli();
console.error(`[workiq] using ${via}`);
const child = spawn(cmd[0], [...cmd.slice(1), "mcp", "-l", "None", ...(opts.account ? ["--account", opts.account] : [])], {
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write("[workiq] " + d.toString()));
child.on("error", (e) => { console.error("Failed to start WorkIQ CLI:", e.message); process.exit(1); });

// ---------- 4. 极简 JSON-RPC 客户端（MCP 协议 = 换行分隔的 JSON-RPC 2.0） ----------
let nextId = 0;
const pending = new Map();
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p.timer);
    msg.error ? p.reject(new Error("MCP error: " + JSON.stringify(msg.error).slice(0, 400))) : p.resolve(msg.result);
  }
});
function call(method, params = {}, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// ---------- 5. 主流程：握手 → ask → 输出 ----------
try {
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "workiq-example", version: "1.0.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  console.error("[workiq] asking Work IQ… (typically 15–40s)");
  const res = await call("tools/call", {
    name: "ask",
    arguments: { question: opts.question, ...(opts.conversationId ? { conversationId: opts.conversationId } : {}) },
  });

  if (res?.isError) {
    console.error("Work IQ returned an error:", res.content?.[0]?.text ?? "(no detail)");
    process.exit(1);
  }
  const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
  const sc = (res.structuredContent ?? {});
  const answer = sc.answer ?? text;

  if (opts.json) {
    console.log(JSON.stringify({ answer, conversationId: sc.conversationId ?? null, raw: res }, null, 2));
  } else {
    console.log("\n" + answer + "\n");
    const cites = [...answer.matchAll(/\[(\d+)\]\((https?:\/\/[^)\s]+)\)/g)];
    if (cites.length) {
      console.log("Sources:");
      for (const [, n, url] of cites) console.log(`  [${n}] ${url}`);
    }
    if (sc.conversationId) console.log(`\nConversation id: ${sc.conversationId}  (用 --conversation-id 继续对话)`);
  }
} catch (e) {
  console.error("Failed:", e.message);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch { /* ignore */ }
}

// Microsoft Teams bot for the WorkIQ demo.
// Handles @mention messages, /ask commands, Adaptive Cards with citations, and the
// /open command that surfaces the web UI as a Teams tab or task-module dialog.
// When an Azure Bot OAuth connection is configured (OAUTH_CONNECTION_NAME) the bot
// queries Work IQ's hosted MCP endpoint with the asking user's own delegated token
// (Teams SSO + token exchange); otherwise it falls back to the shared engine and the
// Teams-user -> Work IQ account map.
import type express from "express";
import {
  ActivityHandler,
  BotFrameworkAdapter,
  type TurnContext,
  type Attachment,
  type InvokeResponse,
  type TokenResponse,
  CardFactory,
  MessageFactory,
} from "botbuilder";
import type { AppConfig } from "../config.js";
import type { WorkIQEngine } from "../workiq/engine.js";
import { OboEngine } from "../workiq/obo-engine.js";
import { AskError } from "../workiq/types.js";
import type { AccountRegistry } from "../workiq/accounts.js";

// In-memory conversation store: Teams conversation id -> { identity, Work IQ conversationId }
interface ConversationState { identity?: string; workiqConversationId?: string; warnedFallback?: boolean }
const conversations = new Map<string, ConversationState>();

/** Per-user engine bound to one delegated token: Teams user id -> engine + the token it carries. */
interface UserEngineEntry { token: string; expiration?: string; engine: WorkIQEngine }
const userEngines = new Map<string, UserEngineEntry>();

/** Question asked before the SSO handshake completed: Teams conversation id -> question. */
const pendingQuestions = new Map<string, string>();

/** Must match the staticTabs entityId emitted by scripts/generate-manifest.mjs. */
const TAB_ENTITY_ID = "workiq-workspace";

const WELCOME = `Hi! I'm the **WorkIQ Query Assistant**. Ask me anything about your internal information — meetings, emails, documents, people, and Teams conversations.

Try: *"What meetings do I have this week?"* or *"Summarize emails from Sarah about the budget."*

Type **/open** to open the full WorkIQ workspace inside Teams (tab or dialog).`;

/** Content URL of the embedded web UI; undefined until PUBLIC_URL is configured. */
function dialogUrl(config: AppConfig): string | undefined {
  return config.publicUrl ? `${config.publicUrl}/?inTeams=1&dialog=1` : undefined;
}

/** Payload claims of a delegated access token (read-only display; the token is validated by Work IQ). */
function tokenClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Card offering the two embedding surfaces: the personal tab and the task-module dialog. */
function openCard(config: AppConfig): Attachment {
  const actions: Record<string, unknown>[] = [];
  if (config.teamsApp.id) {
    actions.push({
      type: "Action.OpenUrl",
      title: "📌 Open the Workspace tab",
      url: `https://teams.microsoft.com/l/entity/${config.teamsApp.id}/${TAB_ENTITY_ID}`,
    });
  }
  actions.push({
    type: "Action.Submit",
    title: "🪟 Open in a dialog",
    data: { msteams: { type: "task/fetch" } },
  });
  return CardFactory.adaptiveCard({
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", text: "WorkIQ Workspace", weight: "Bolder", size: "Medium" },
      {
        type: "TextBlock",
        wrap: true,
        text: "The full web UI — streamed chat, the grounding explorer and brief export — running inside Teams.",
      },
    ],
    actions,
  });
}

/** SSO invoke callbacks; wired only when an OAuth connection is configured. */
interface SsoInvokes {
  /** Silent Teams SSO exchange; false makes Teams fall back to the interactive sign-in card. */
  tokenExchange(context: TurnContext, exchangeToken: string): Promise<boolean>;
  /** Interactive sign-in completed in the popup. */
  verifyState(context: TurnContext): Promise<void>;
}

/**
 * ActivityHandler that additionally answers the task-module invokes raised by the
 * `/open` card (`task/fetch` opens the dialog, `task/submit` closes it) and the
 * `signin/*` invokes of the Bot Framework SSO handshake.
 */
class WorkIQActivityHandler extends ActivityHandler {
  constructor(
    private readonly config: AppConfig,
    private readonly sso?: SsoInvokes,
  ) {
    super();
  }

  protected async onInvokeActivity(context: TurnContext): Promise<InvokeResponse> {
    const name = context.activity.name;

    if (this.sso && name === "signin/tokenExchange") {
      const exchangeToken = (context.activity.value as { token?: string } | undefined)?.token;
      const ok = exchangeToken ? await this.sso.tokenExchange(context, exchangeToken) : false;
      // 412 (precondition failed) tells Teams the silent exchange is impossible → sign-in card.
      return { status: ok ? 200 : 412 };
    }

    if (this.sso && name === "signin/verifyState") {
      await this.sso.verifyState(context);
      return { status: 200 };
    }

    if (name === "task/fetch") {
      const url = dialogUrl(this.config);
      if (!url) {
        return {
          status: 200,
          body: { task: { type: "message", value: "The workspace is unavailable until PUBLIC_URL is configured on the server." } },
        };
      }
      return {
        status: 200,
        body: {
          task: {
            type: "continue",
            value: { title: "WorkIQ Workspace", height: "large", width: "large", url, fallbackUrl: url },
          },
        },
      };
    }
    if (name === "task/submit") return { status: 200 };
    return super.onInvokeActivity(context);
  }
}

export interface TeamsBotHandle {
  adapter: BotFrameworkAdapter;
  handler: ActivityHandler;
}

export function createTeamsBot(engine: () => WorkIQEngine, config: AppConfig, accounts?: AccountRegistry): TeamsBotHandle | null {
  if (!config.bot.appId || !config.bot.appPassword) return null;

  const connectionName = config.botOauthConnectionName;

  const resolveAccount = (context: TurnContext): string | undefined => {
    if (!accounts) return undefined;
    const from = context.activity.from;
    const resolved = accounts.resolve({
      aadObjectId: from?.aadObjectId,
      id: from?.id,
      name: from?.name,
      email: from?.aadObjectId ? undefined : (from as { email?: string }).email, // email rarely present; aadObjectId is the reliable key
    });
    return resolved.account;
  };

  // SingleTenant bots must fetch channel tokens from their own directory. Without
  // channelAuthTenant the SDK asks login.microsoftonline.com/botframework.com, where a
  // single-tenant app registration does not exist -> AADSTS700016 and every turn drops.
  const adapter = new BotFrameworkAdapter({
    appId: config.bot.appId,
    appPassword: config.bot.appPassword,
    ...(config.bot.tenantId ? { channelAuthTenant: config.bot.tenantId } : {}),
  });
  adapter.onTurnError = async (context, error) => {
    console.error("[teams-bot] turn error:", error);
    await context.sendActivity("Sorry, something went wrong while querying Work IQ. Please try again.");
  };

  /** Token cached by the Azure Bot token service for this user, or undefined when there is none yet. */
  const cachedToken = async (context: TurnContext, magicCode?: string): Promise<TokenResponse | undefined> => {
    try {
      const token = await adapter.getUserToken(context, connectionName as string, magicCode);
      return token?.token ? token : undefined;
    } catch (e) {
      console.error("[teams-bot] getUserToken failed:", e instanceof Error ? e.message : e);
      return undefined;
    }
  };

  /** Engine bound to the user's current delegated token; the previous one is closed when the token rotates. */
  const userEngine = async (userId: string, token: TokenResponse): Promise<WorkIQEngine> => {
    const cached = userEngines.get(userId);
    if (cached && cached.token === token.token && cached.expiration === token.expiration) return cached.engine;
    if (cached) {
      userEngines.delete(userId);
      await cached.engine.close().catch(() => {});
    }
    const created = new OboEngine({
      url: config.workiqMcpUrl,
      accessToken: token.token,
      timeoutMs: config.timeoutMs,
      onLog: (line) => console.log(`[teams-bot][obo] ${line}`),
    });
    userEngines.set(userId, { token: token.token, expiration: token.expiration, engine: created });
    return created;
  };

  /** Ask Work IQ and render the answer, citation card and follow-up suggestions. */
  const respond = async (
    context: TurnContext,
    question: string,
    target: WorkIQEngine,
    identity: { who: string; account?: string },
  ): Promise<void> => {
    const convKey = context.activity.conversation?.id ?? "";
    const state = conversations.get(convKey) ?? {};
    if (state.identity !== identity.who) {
      state.identity = identity.who;
      state.workiqConversationId = undefined; // conversation ids are per-user
    }

    await context.sendActivity(`🔎 正在以 **${identity.who}** 的身份查询 Work IQ…`);
    try {
      const result = await target.ask(question, { conversationId: state.workiqConversationId, account: identity.account });
      if (result.conversationId) state.workiqConversationId = result.conversationId;
      conversations.set(convKey, state);

      // Answer (plain-text-ish) + citation card
      const plain = result.answer
        .replace(/\[(\d+)\]\((https?:\/\/[^)\s]+)\)/g, "[$1]")
        .replace(/\*\*/g, "")
        .slice(0, 2800);
      await context.sendActivity(plain);

      if (result.citations.length) {
        const card = CardFactory.heroCard(
          `Sources (${result.citations.length})`,
          result.citations.map((c) => `${c.title}${c.snippet ? ` — ${c.snippet.slice(0, 120)}` : ""}`).join("\n\n").slice(0, 1500),
          undefined,
          result.citations.slice(0, 6).map((c) => ({ type: "openUrl", title: `Open: ${c.title.slice(0, 40)}`, value: c.url })),
        );
        await context.sendActivity(MessageFactory.attachment(card));
      }

      const suggestions = [
        "What meetings do I have this week?",
        "Who owns Project Atlas?",
        "What does the expense policy say?",
      ];
      const sa = MessageFactory.suggestedActions(suggestions, "Want to keep digging?");
      await context.sendActivity(sa);
    } catch (e) {
      // Entitlement / consent failures carry an actionable hint — show it, never a stack trace.
      const actionable = ["WORKIQ_UNAUTHORIZED", "WORKIQ_FORBIDDEN", "EULA_REQUIRED", "OBO_CONSENT_REQUIRED"];
      if (e instanceof AskError && actionable.includes(e.code)) {
        await context.sendActivity(`⚠️ ${e.message}${e.hint ? `\n\n${e.hint}` : ""}`);
        return;
      }
      await context.sendActivity(`⚠️ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Answer with the user's own delegated token; used by the message turn and after a sign-in handshake. */
  const respondAsUser = async (context: TurnContext, question: string, token: TokenResponse): Promise<void> => {
    const userId = context.activity.from?.id ?? "";
    const claims = tokenClaims(token.token);
    const who = (claims.upn ?? claims.preferred_username ?? claims.unique_name ?? context.activity.from?.name ?? userId) as string;
    await respond(context, question, await userEngine(userId, token), { who });
  };

  /** Replay the question the user asked before signing in, if any. */
  const continuePending = async (context: TurnContext, token: TokenResponse): Promise<void> => {
    const convKey = context.activity.conversation?.id ?? "";
    const question = pendingQuestions.get(convKey);
    if (!question) {
      await context.sendActivity("✅ 已登录 Work IQ，现在可以直接提问了。");
      return;
    }
    pendingQuestions.delete(convKey);
    await respondAsUser(context, question, token);
  };

  const sso: SsoInvokes | undefined = connectionName
    ? {
        tokenExchange: async (context, exchangeToken) => {
          const userId = context.activity.from?.id ?? "";
          let token: TokenResponse | undefined;
          try {
            token = await adapter.exchangeToken(context, connectionName, userId, { token: exchangeToken });
          } catch (e) {
            console.error("[teams-bot] token exchange failed:", e instanceof Error ? e.message : e);
            return false;
          }
          if (!token?.token) return false;
          await continuePending(context, token);
          return true;
        },
        verifyState: async (context) => {
          const magicCode = (context.activity.value as { state?: string } | undefined)?.state;
          const token = await cachedToken(context, magicCode);
          if (!token) {
            await context.sendActivity("⚠️ 登录未完成，请重新提问并在卡片中登录。");
            return;
          }
          await continuePending(context, token);
        },
      }
    : undefined;

  const handler = new WorkIQActivityHandler(config, sso);

  handler.onMessage(async (context: TurnContext, next: () => Promise<void>): Promise<void> => {
    const text = (context.activity.text ?? "").trim();
    const lower = text.toLowerCase();
    const convKey = context.activity.conversation?.id ?? "";
    const userId = context.activity.from?.id ?? "";
    const account = resolveAccount(context);

    if (lower.startsWith("/reset") || lower === "reset") {
      conversations.delete(convKey);
      pendingQuestions.delete(convKey);
      await context.sendActivity("Conversation reset. Ask me anything about your internal information.");
      return;
    }

    if (lower.startsWith("/open") || lower === "open" || lower.startsWith("/app") || lower === "app") {
      if (!config.publicUrl) {
        await context.sendActivity(
          "⚠️ WorkIQ Workspace 暂不可用：服务器未配置 `PUBLIC_URL`（对外可访问的 HTTPS 地址）。配置并重启后，`/open` 才能打开标签页或对话框。",
        );
        return;
      }
      await context.sendActivity(MessageFactory.attachment(openCard(config)));
      return;
    }

    if (lower.startsWith("/signout") || lower === "signout") {
      if (!connectionName) {
        await context.sendActivity("Teams SSO 未启用（服务器未配置 `OAUTH_CONNECTION_NAME`），无需登出。");
        return;
      }
      await adapter.signOutUser(context, connectionName, userId);
      const cached = userEngines.get(userId);
      if (cached) {
        userEngines.delete(userId);
        await cached.engine.close().catch(() => {});
      }
      pendingQuestions.delete(convKey);
      conversations.delete(convKey);
      await context.sendActivity("已登出 Work IQ。下次提问时会重新请求登录。");
      return;
    }

    if (lower.startsWith("/eula") || lower === "eula") {
      const token = connectionName ? await cachedToken(context) : undefined;
      if (!token) {
        await context.sendActivity("需要先用 Teams SSO 登录才能接受 Work IQ EULA —— 直接提个问题，我会引导你登录。");
        return;
      }
      const target = await userEngine(userId, token);
      if (!(target instanceof OboEngine)) {
        await context.sendActivity("当前不是 hosted MCP 模式，EULA 由 Work IQ CLI 侧的 `accept-eula` 处理。");
        return;
      }
      try {
        const result = await target.acceptEula();
        await context.sendActivity(`✅ 已为你接受 Work IQ EULA：${result.slice(0, 300)}`);
      } catch (e) {
        await context.sendActivity(`⚠️ 接受 EULA 失败：${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    if (lower.startsWith("/whoami") || lower === "whoami") {
      const token = connectionName ? await cachedToken(context) : undefined;
      if (token) {
        const claims = tokenClaims(token.token);
        await context.sendActivity(
          `Your Work IQ identity (Teams SSO): **${(claims.upn ?? claims.preferred_username ?? claims.unique_name ?? "unknown") as string}**` +
          `\n\n- Name: ${(claims.name as string | undefined) ?? context.activity.from?.name ?? "?"}` +
          `\n- Tenant: ${(claims.tid as string | undefined) ?? "?"}` +
          `\n- Engine: Work IQ (hosted MCP, delegated token)` +
          `\n- Connection: ${connectionName}`,
        );
        return;
      }
      await context.sendActivity(
        `Your Work IQ identity: **${account ?? "no account configured"}**` +
        `\n\n- Teams user: ${context.activity.from?.name ?? context.activity.from?.aadObjectId ?? context.activity.from?.id ?? "?"}` +
        `\n- Engine: ${engine().mode === "live" ? "Work IQ (live)" : "Work IQ (demo mode)"}` +
        (connectionName ? "\n- Teams SSO: 已启用但尚未登录，直接提问即可登录。" : "") +
        (accounts ? `\n- Mapped accounts: ${accounts.list.length ? accounts.list.join(", ") : "none"}` : ""),
      );
      return;
    }

    const question = lower.startsWith("/ask") ? text.replace(/^\/ask\s*/i, "") : text.replace(/@[^ ]+\s*/g, "").trim();
    if (!question) {
      await context.sendActivity("Ask me something like: *What meetings do I have this week?*");
      return;
    }

    // Preferred path: query with the asking user's own delegated token (Teams SSO + OBO).
    if (connectionName) {
      const token = await cachedToken(context);
      if (token) {
        await respondAsUser(context, question, token);
        await next();
        return;
      }
      pendingQuestions.set(convKey, question);
      const resource = await adapter.getSignInResource(context, connectionName, userId);
      await context.sendActivity(
        MessageFactory.attachment(
          CardFactory.oauthCard(
            connectionName,
            "登录 Work IQ",
            "使用你的 Microsoft 365 账号登录，Work IQ 将以你本人的身份回答。",
            resource.signInLink,
            resource.tokenExchangeResource,
            resource.tokenPostResource,
          ),
        ),
      );
      return;
    }

    // Legacy path: shared engine + Teams user -> Work IQ account map.
    if (!account) {
      await context.sendActivity(
        "⚠️ 无法确定你的 Work IQ 账号。请在服务器上配置 ACCOUNT_MAP_FILE（Teams 用户 → 邮箱）并让该账号完成一次 `workiq auth login --account <email>`。",
      );
      return;
    }
    await respond(context, question, engine(), { who: account, account });
    await next();
  });

  handler.onMembersAdded(async (context: TurnContext, next: () => Promise<void>): Promise<void> => {
    for (const member of context.activity.membersAdded ?? []) {
      if (member.id !== context.activity.recipient?.id) {
        await context.sendActivity(MessageFactory.text(WELCOME));
      }
    }
    await next();
  });

  return { adapter, handler };
}

export function registerTeamsBot(
  app: express.Express,
  engine: () => WorkIQEngine,
  config: AppConfig,
  accounts?: AccountRegistry,
): TeamsBotHandle | null {
  const bot = createTeamsBot(engine, config, accounts);
  if (!bot) return null;
  // Override the placeholder route from routes.ts
  // Remove the placeholder POST /api/messages route added by routes.ts
  const stack = (app._router?.stack ?? []) as { route?: { path?: string; methods?: Record<string, boolean> } }[];
  for (const layer of stack) {
    if (layer.route?.path === "/api/messages" && layer.route.methods?.post) {
      (layer.route as { stack?: unknown[] }).stack = [];
    }
  }
  app.post("/api/messages", (req, res) => {
    // processActivity can REJECT for malformed/bad requests (e.g. a missing
    // activity type). That rejection must never crash the process, so we
    // attach an explicit rejection guard. Real Teams traffic is unaffected;
    // this only protects the endpoint from hostile/malformed payloads.
    try {
      bot.adapter
        .processActivity(req, res, async (turnContext) => {
          await bot.handler.run(turnContext);
        })
        .catch((e) => {
          console.error("[teams-bot] processActivity rejected (request dropped):", e instanceof Error ? e.message : e);
        });
    } catch (e) {
      console.error("[teams-bot] processActivity threw synchronously:", e instanceof Error ? e.message : e);
      if (!res.headersSent) res.status(500).send("bot error");
    }
  });
  return bot;
}

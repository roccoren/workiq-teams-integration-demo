// Generate teams/appPackage/manifest.json (Teams Toolkit-style app package).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.env.TEAMS_APP_PACKAGE_DIR
  ? path.resolve(process.env.TEAMS_APP_PACKAGE_DIR)
  : path.resolve(here, "..", "teams", "appPackage");
fs.mkdirSync(outDir, { recursive: true });

const appId = process.env.TEAMS_APP_ID || "00000000-0000-0000-0000-000000000001";
const botId = process.env.TEAMS_BOT_ID || process.env.MICROSOFT_APP_ID || "00000000-0000-0000-0000-000000000002";
const name = process.env.TEAMS_APP_NAME || "WorkIQ Query Assistant";
// Teams keys an installed app by `id`; re-uploading the same id with an unchanged
// version is rejected ("The app's external ID is already being used") — bump this to
// publish an update, or pass a fresh TEAMS_APP_ID to publish a separate app.
const version = process.env.TEAMS_APP_VERSION || "1.0.0";

// PUBLIC_URL is the external HTTPS base URL of the deployment. Without it Teams has
// nothing to frame, so the personal tab is omitted and the package stays bot-only.
const publicUrl = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
let publicHost = "";
if (publicUrl) {
  try {
    publicHost = new URL(publicUrl).hostname;
  } catch {
    throw new Error(`PUBLIC_URL is not a valid URL: ${publicUrl}`);
  }
}

const validDomains = [...new Set([
  "localhost",
  "*.ngrok-free.app",
  "*.ngrok.io",
  "*.azurewebsites.net",
  "*.azurecontainerapps.io",
  ...(publicHost ? [publicHost] : []),
])];

const staticTabs = publicUrl
  ? [{
      entityId: "workiq-workspace",
      name: "Workspace",
      contentUrl: `${publicUrl}/?inTeams=1`,
      websiteUrl: publicUrl,
      scopes: ["personal"],
    }]
  : [];

// Teams SSO: the tab asks the host for a token scoped to this Entra app, and the server
// exchanges it (OBO) for a Work IQ token. `resource` must match the app registration's
// Application ID URI byte for byte, so it is only emitted once the host is known.
const ssoAppId = process.env.TEAMS_BOT_ID || process.env.MICROSOFT_APP_ID || "";
const webApplicationInfo = publicHost && ssoAppId
  ? { id: ssoAppId, resource: `api://${publicHost}/botid-${ssoAppId}` }
  : null;

const manifest = {
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
  "manifestVersion": "1.16",
  "version": version,
  "id": appId,
  "packageName": "com.contoso.workiqdemo",
  // Teams validates these as real URLs; fall back to a placeholder only when the
  // deployment URL is unknown.
  "developer": {
    "name": "Contoso Demo",
    "websiteUrl": publicUrl || "https://localhost:3000",
    "privacyUrl": `${publicUrl || "https://localhost:3000"}/privacy`,
    "termsOfUseUrl": `${publicUrl || "https://localhost:3000"}/terms`,
  },
  "icons": { "color": "color.png", "outline": "outline.png" },
  "name": { "short": name, "full": name + " (demo)" },
  "description": {
    "short": "Query your internal information with Microsoft Work IQ.",
    "full": "Ask questions about meetings, emails, documents, people and Teams conversations. Answers are grounded in Work IQ with citations and deep links. Demo app — not for production use.",
  },
  "accentColor": "#7C8CFF",
  "bots": [
    {
      "botId": botId,
      "needsChannelSelector": false,
      "isNotificationOnly": false,
      "scopes": ["personal", "team", "groupChat"],
      // NOTE: keep this object schema-clean — Teams rejects the whole package with
      // "Manifest parsing error message unavailable" on any unknown property
      // (that is what `isTeamScoped` did here).
      "supportsFiles": false,
      "commandLists": [
        {
          "scopes": ["personal", "team", "groupChat"],
          "commands": [
            { "title": "ask", "description": "Ask Work IQ a question, e.g. /ask What meetings do I have this week?" },
            { "title": "open", "description": "Open the WorkIQ workspace as a Teams tab or dialog" },
            { "title": "reset", "description": "Start a fresh Work IQ conversation" },
            { "title": "help", "description": "Show how to use the assistant" },
          ],
        },
      ],
    },
  ],
  ...(staticTabs.length ? { "staticTabs": staticTabs } : {}),
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": validDomains,
  ...(webApplicationInfo ? { "webApplicationInfo": webApplicationInfo } : {}),
};

fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("manifest written -> teams/appPackage/manifest.json");
if (publicUrl) {
  console.log(`  static tab -> ${publicUrl}/?inTeams=1 (validDomains += ${publicHost})`);
} else {
  console.warn("  warning: PUBLIC_URL is not set — bot-only package, no personal tab. Set PUBLIC_URL to the external HTTPS base URL and re-run.");
}
if (webApplicationInfo) {
  console.log(`  Teams SSO -> set the Entra app's Application ID URI to ${webApplicationInfo.resource}`);
} else if (publicUrl) {
  console.warn("  warning: TEAMS_BOT_ID/MICROSOFT_APP_ID is not set — no webApplicationInfo, the tab cannot use Teams SSO.");
}

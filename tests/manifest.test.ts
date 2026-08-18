// The Teams app package is rejected with the opaque "Manifest parsing error message
// unavailable" whenever the manifest violates the app schema (an unknown property is
// enough). Validate the generator output against the vendored v1.16 schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import addFormats from "ajv-formats";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/teams-manifest-v1.16.schema.json"), "utf8"));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function generate(env: Record<string, string>): Record<string, unknown> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workiq-manifest-"));
  try {
    execFileSync(process.execPath, [path.join(root, "scripts/generate-manifest.mjs")], {
      cwd: root,
      env: { ...process.env, TEAMS_APP_PACKAGE_DIR: dir, ...env },
      stdio: "ignore",
    });
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertValid(manifest: Record<string, unknown>): void {
  if (!validate(manifest)) {
    assert.fail(`manifest violates the Teams v1.16 schema:\n${JSON.stringify(validate.errors, null, 2)}`);
  }
}

// Synthetic ids — the generator never validates them, so no real tenant values here.
const TEAMS_APP_ID = "11111111-1111-4111-8111-111111111111";
const BOT_APP_ID = "22222222-2222-4222-8222-222222222222";

test("generated manifest with a tab passes the Teams v1.16 schema", () => {
  const manifest = generate({
    PUBLIC_URL: "https://workiq-demo.example.azurecontainerapps.io",
    TEAMS_APP_ID,
    TEAMS_BOT_ID: BOT_APP_ID,
  });
  assertValid(manifest);
  const tabs = manifest.staticTabs as Array<{ contentUrl: string; scopes: string[] }>;
  assert.equal(tabs[0].contentUrl, "https://workiq-demo.example.azurecontainerapps.io/?inTeams=1");
  assert.deepEqual(tabs[0].scopes, ["personal"]);
  assert.ok((manifest.validDomains as string[]).includes("workiq-demo.example.azurecontainerapps.io"));
  assert.deepEqual(manifest.webApplicationInfo, {
    id: BOT_APP_ID,
    resource: `api://workiq-demo.example.azurecontainerapps.io/botid-${BOT_APP_ID}`,
  });
});

test("bot-only manifest (no PUBLIC_URL) passes the schema and omits the tab", () => {
  const manifest = generate({
    PUBLIC_URL: "",
    TEAMS_APP_ID,
    TEAMS_BOT_ID: BOT_APP_ID,
  });
  assertValid(manifest);
  assert.equal(manifest.staticTabs, undefined);
  // Without a host there is no Application ID URI to point SSO at.
  assert.equal(manifest.webApplicationInfo, undefined);
});

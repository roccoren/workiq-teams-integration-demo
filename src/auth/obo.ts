// On-Behalf-Of: exchange a Teams SSO token for a delegated Work IQ access token.
// The Teams client sends us a token for *our* app; Entra swaps it for a token
// scoped to the hosted Work IQ MCP endpoint, carrying the signed-in user's identity.
import crypto from "node:crypto";
import { ConfidentialClientApplication } from "@azure/msal-node";
import { AskError } from "../workiq/types.js";

export interface OboIdentity {
  token: string;
  /** Epoch milliseconds at which the delegated token stops being valid. */
  expiresOn: number;
  oid?: string;
  upn?: string;
  name?: string;
  tid?: string;
}

export interface OboOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Resource scope requested for the user, e.g. "<app-id>/WorkIQAgent.Ask". */
  scope: string;
}

/** Drop a cached identity this long before it expires so in-flight calls never race the expiry. */
const CACHE_SKEW_MS = 60_000;
/** Used only when Entra omits expires_on; MSAL access tokens are ~1h. */
const DEFAULT_LIFETIME_MS = 3_600_000;

/**
 * Maps an MSAL / Entra failure onto an AskError the API and UI can act on.
 * Exported so the mapping can be exercised without touching the network.
 */
export function mapOboError(err: unknown, opts: OboOptions): AskError {
  // MSAL throws AuthError subclasses; read their fields structurally so a plain Error works too.
  const e = err as { errorCode?: string; errorMessage?: string; subError?: string; message?: string } | null;
  const raw = [e?.errorCode, e?.subError, e?.errorMessage, e?.message].filter(Boolean).join(" ");
  const full = raw || String(err);
  const lower = full.toLowerCase();
  // Entra repeats the same sentence with trace/correlation ids several times; keep the
  // AADSTS code plus its description so the API/Teams surface stays readable. Callers that
  // need the whole blob find it in the server log.
  const described = /AADSTS\d+:[^.]*\./.exec(full);
  const text = (described?.[0] ?? full.split(" Trace ID")[0]).slice(0, 240);
  const consentUrl = `https://login.microsoftonline.com/${opts.tenantId}/adminconsent?client_id=${opts.clientId}`;

  const consent =
    full.includes("AADSTS65001") ||
    lower.includes("consent_required") ||
    lower.includes("interaction_required") ||
    (lower.includes("invalid_grant") && lower.includes("consent"));
  if (consent) {
    return new AskError(
      "OBO_CONSENT_REQUIRED",
      `Work IQ access has not been consented for this user: ${text}`,
      `Grant admin consent for "${opts.scope}" at ${consentUrl}, or have the user accept the Teams SSO consent prompt.`,
    );
  }

  const unauthorized =
    full.includes("AADSTS500131") ||
    full.includes("AADSTS50013") ||
    full.includes("AADSTS700016") ||
    full.includes("AADSTS50027") ||
    lower.includes("invalid_grant") ||
    lower.includes("assertion");
  if (unauthorized) {
    return new AskError(
      "OBO_UNAUTHORIZED",
      `Entra rejected the Teams SSO assertion: ${text}`,
      `Check the token audience (api://<host>/botid-${opts.clientId} for bot apps, api://<host>/${opts.clientId} otherwise), that the Teams client ids are pre-authorized on the app registration, and that the token is not expired.`,
    );
  }

  return new AskError(
    "OBO_FAILED",
    `On-Behalf-Of exchange failed: ${text}`,
    `Verify AAD_TENANT_ID / AAD_CLIENT_ID / AAD_CLIENT_SECRET and that "${opts.scope}" is an API permission on client ${opts.clientId}.`,
  );
}

/** Keeps only the non-empty string members of an `unknown`-valued claim bag. */
function stringClaims(source: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!source || typeof source !== "object") return out;
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

/** Decodes a JWT payload without verifying it. */
function jwtClaims(token: string): Record<string, string> {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    return stringClaims(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return {};
  }
}

export class OboTokenService {
  private readonly msal: ConfidentialClientApplication;
  /** Delegated identities keyed by SHA-256 of the incoming assertion. */
  private readonly cache = new Map<string, OboIdentity>();

  constructor(private readonly opts: OboOptions) {
    this.msal = new ConfidentialClientApplication({
      auth: {
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        authority: `https://login.microsoftonline.com/${opts.tenantId}`,
      },
    });
  }

  async exchange(userAssertion: string): Promise<OboIdentity> {
    const key = crypto.createHash("sha256").update(userAssertion).digest("hex");
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.expiresOn - CACHE_SKEW_MS > now) return cached;
      this.cache.delete(key);
    }

    let result;
    try {
      result = await this.msal.acquireTokenOnBehalfOf({ oboAssertion: userAssertion, scopes: [this.opts.scope] });
    } catch (e) {
      throw mapOboError(e, this.opts);
    }
    if (!result?.accessToken) {
      throw new AskError(
        "OBO_FAILED",
        "On-Behalf-Of exchange returned no access token",
        `Confirm "${this.opts.scope}" is granted to client ${this.opts.clientId}.`,
      );
    }

    // Claims: prefer what MSAL parsed; otherwise read the assertion payload directly.
    // Decoding without verification is safe here — Entra validated the assertion's
    // signature, audience and lifetime during the exchange we just completed.
    const account = result.account ?? undefined;
    const claims = { ...jwtClaims(userAssertion), ...stringClaims(result.idTokenClaims) };

    const identity: OboIdentity = {
      token: result.accessToken,
      expiresOn: result.expiresOn?.getTime() ?? now + DEFAULT_LIFETIME_MS,
      oid: account?.localAccountId || claims.oid || claims.sub,
      upn: account?.username || claims.preferred_username || claims.upn || claims.email,
      name: account?.name || claims.name,
      tid: account?.tenantId || claims.tid || this.opts.tenantId,
    };
    this.cache.set(key, identity);
    return identity;
  }
}

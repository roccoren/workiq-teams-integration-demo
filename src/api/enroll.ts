// Self-service account enrollment: drive `workiq auth login --account <email>`
// from the web UI, so each user can authorize their own Work IQ account on the
// engine host without any admin involvement. The CLI performs an interactive
// login (MSAL broker + http://localhost loopback redirect) — it has no
// device-code option, so the host must have a browser/desktop session.
import { Router, type Request, type Response } from "express";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveCliCommand } from "../workiq/live-engine.js";
import type { AccountRegistry } from "../workiq/accounts.js";
import type { AppConfig } from "../config.js";

interface Enrollment {
  id: string;
  email: string;
  status: "pending" | "complete" | "failed" | "timedout";
  lines: string[];
  startedAt: number;
  child?: ChildProcessWithoutNullStreams;
  error?: string;
}

const enrollments = new Map<string, Enrollment>();
const ENROLL_TIMEOUT_MS = 10 * 60_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function enrollRoutes(ctx: { accounts: AccountRegistry; config: AppConfig }): Router {
  const router = Router();
  const enrollToken = process.env.ENROLL_TOKEN;

  const checkToken = (req: Request, res: Response): boolean => {
    if (!enrollToken) return true;
    const token = req.headers["x-enroll-token"] ?? req.body?.token;
    if (token === enrollToken) return true;
    res.status(401).json({ error: "invalid enroll token (set ENROLL_TOKEN on the server)" });
    return false;
  };

  // Start an interactive login for an account (CLI output is relayed to the page)
  router.post("/enroll", (req, res) => {
    if (!checkToken(req, res)) return;
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "valid email is required" });
    if (ctx.accounts.has(email)) return res.status(409).json({ error: `account ${email} is already enrolled` });

    const { command } = resolveCliCommand(ctx.config.cliCommand);
    const [cmd, ...rest] = command;
    const args = [...rest, "auth", "login", "--account", email, "-l", "None"];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return res.status(500).json({ error: `cannot start WorkIQ CLI: ${e instanceof Error ? e.message : e}` });
    }

    const enr: Enrollment = { id: newId(), email, status: "pending", lines: [], startedAt: Date.now() };
    enrollments.set(enr.id, enr);
    enr.child = child;
    const push = (d: Buffer) => {
      const s = d.toString();
      for (const line of s.split(/\r?\n/)) if (line.trim()) enr.lines.push(line.trim());
      if (enr.lines.length > 60) enr.lines.splice(0, enr.lines.length - 60);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", (e) => { enr.status = "failed"; enr.error = e.message; });
    child.on("exit", (code) => {
      if (enr.status === "timedout") return;
      if (code === 0) {
        enr.status = "complete";
        ctx.accounts.addAccount(enr.email);
      } else {
        enr.status = "failed";
        enr.error = `workiq auth login exited with code ${code}`;
      }
    });
    setTimeout(() => {
      if (enr.status === "pending") {
        enr.status = "timedout";
        try { enr.child?.kill("SIGTERM"); } catch { /* ignore */ }
      }
    }, ENROLL_TIMEOUT_MS).unref();

    res.json({ id: enr.id, email: enr.email, status: enr.status });
  });

  // Poll enrollment progress (device URL + code appear in the log lines)
  router.get("/enroll/:id", (req, res) => {
    const enr = enrollments.get(req.params.id);
    if (!enr) return res.status(404).json({ error: "enrollment not found" });
    const joined = enr.lines.join("\n");
    const url = joined.match(/(https?:\/\/\S+)/)?.[1];
    const code = joined.match(/enter code\s+([A-Za-z0-9]+)/i)?.[1];
    res.json({
      id: enr.id,
      email: enr.email,
      status: enr.status,
      deviceUrl: url,
      deviceCode: code,
      error: enr.error,
      lastLines: enr.lines.slice(-6),
      elapsedSec: Math.round((Date.now() - enr.startedAt) / 1000),
    });
  });

  return router;
}

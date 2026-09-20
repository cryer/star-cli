import fs from "node:fs/promises";
import path from "node:path";
import { starHome } from "../../config/paths";
import type { StarConfig } from "../../config/schema";
import { resolveShell } from "../../tools/bash";

const MIN_NODE_MAJOR = 20;
const REGISTRY_URL = "https://registry.npmjs.org/";
const REGISTRY_TIMEOUT_MS = 5000;

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  optional?: boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  passed: number;
  failed: number;
}

export type DoctorFetcher = (url: string, timeoutMs: number) => Promise<boolean>;

async function defaultFetcher(url: string, timeoutMs: number): Promise<boolean> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return res.ok;
}

export interface DoctorOptions {
  cwd: string;
  config: StarConfig;
  env?: NodeJS.ProcessEnv;
  home?: string;
  nodeVersion?: string;
  shellLabel?: string;
  shellPath?: string;
  fetcher?: DoctorFetcher;
}

function nodeMajor(version: string): number | null {
  const match = /^v?(\d+)/.exec(version);
  return match ? Number.parseInt(match[1] ?? "", 10) : null;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function resolveApiKeyConfigured(
  config: StarConfig,
  providerName: string,
  env: NodeJS.ProcessEnv,
): boolean | null {
  const provider = config.providers.find((p) => p.name === providerName);
  if (!provider) return null;
  const fromEnv = provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined;
  return Boolean(fromEnv ?? provider.apiKey);
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? starHome();
  const checks: DoctorCheck[] = [];

  const version = opts.nodeVersion ?? process.version;
  const major = nodeMajor(version);
  const nodeOk = major !== null && major >= MIN_NODE_MAJOR;
  checks.push({
    name: "Node.js version",
    ok: nodeOk,
    detail: nodeOk
      ? `${version} (>= ${MIN_NODE_MAJOR} required)`
      : `${version} — Node.js >= ${MIN_NODE_MAJOR} is required`,
  });

  if (opts.shellLabel !== undefined || opts.shellPath !== undefined) {
    checks.push({
      name: "Shell for bash tool",
      ok: true,
      detail: `${opts.shellLabel ?? "unknown"}${opts.shellPath ? ` (${opts.shellPath})` : ""}`,
    });
  } else {
    const spec = resolveShell();
    checks.push({
      name: "Shell for bash tool",
      ok: true,
      detail: `${spec.label} (${spec.shell})`,
    });
  }

  const configPath = path.join(home, "config.toml");
  const configExists = await pathExists(configPath);
  checks.push({
    name: "STAR_HOME / config",
    ok: configExists,
    detail: configExists
      ? `STAR_HOME=${home}, config.toml found at ${configPath}`
      : `STAR_HOME=${home}, config.toml missing at ${configPath}`,
  });

  const defaultModel = opts.config.defaultModel;
  if (!defaultModel) {
    checks.push({
      name: "Default model",
      ok: false,
      detail: "no defaultModel configured",
    });
  } else {
    const modelConfig = opts.config.models.find((m) => m.name === defaultModel);
    if (!modelConfig) {
      checks.push({
        name: "Default model",
        ok: false,
        detail: `model "${defaultModel}" not found in configured models`,
      });
    } else {
      const provider = opts.config.providers.find((p) => p.name === modelConfig.provider);
      checks.push({
        name: "Default model",
        ok: provider !== undefined,
        detail: provider
          ? `${modelConfig.name} (${provider.name}/${modelConfig.model}, ${provider.baseURL})`
          : `provider "${modelConfig.provider}" for model "${modelConfig.name}" not found`,
      });
      const keyConfigured = resolveApiKeyConfigured(opts.config, modelConfig.provider, env);
      checks.push({
        name: "Provider API key",
        ok: keyConfigured === true,
        detail:
          keyConfigured === null
            ? `provider "${modelConfig.provider}" not found`
            : keyConfigured
              ? `apiKey resolved for provider "${modelConfig.provider}"`
              : `apiKey missing for provider "${modelConfig.provider}"${
                  provider?.apiKeyEnv ? ` (set ${provider.apiKeyEnv} or configure apiKey)` : ""
                }`,
      });
    }
  }

  const sessions = path.join(home, "sessions");
  let writable = false;
  let writeError = "";
  try {
    await fs.mkdir(sessions, { recursive: true });
    const probe = path.join(sessions, `.doctor-probe-${process.pid}`);
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    writable = true;
  } catch (error) {
    writeError = error instanceof Error ? error.message : String(error);
  }
  checks.push({
    name: "Sessions directory writable",
    ok: writable,
    detail: writable ? `${sessions} is writable` : `${sessions} not writable: ${writeError}`,
  });

  const fetcher = opts.fetcher ?? defaultFetcher;
  let registryOk = false;
  try {
    registryOk = await fetcher(REGISTRY_URL, REGISTRY_TIMEOUT_MS);
  } catch {
    registryOk = false;
  }
  checks.push({
    name: "npm registry connectivity",
    ok: registryOk,
    detail: registryOk
      ? `${REGISTRY_URL} reachable`
      : `${REGISTRY_URL} unreachable (optional — only affects update checks)`,
    optional: true,
  });

  const passed = checks.filter((c) => c.ok).length;
  return { checks, passed, failed: checks.length - passed };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map(
    (check) => `${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`,
  );
  lines.push("", `${report.passed} passed, ${report.failed} failed`);
  return lines.join("\n");
}

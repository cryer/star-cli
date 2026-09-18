#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const skipSmoke = process.argv.includes("--skip-smoke");

let failed = false;

function run(title, command, args, opts = {}) {
  console.log(`\n=== ${title} ===`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (result.status !== 0) {
    console.error(`FAILED: ${title}`);
    failed = true;
  }
  return result.status === 0;
}

function smokeConfig() {
  if (process.env.SMOKE_MODEL) {
    return { model: process.env.SMOKE_MODEL };
  }
  if (process.env.FASTAI_API_KEY) {
    return { model: "gpt6" };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return { model: "nemotron" };
  }
  return null;
}

// Layer 1: static checks
run("Layer 1/4: lint", "pnpm", ["lint"]);
run("Layer 1/4: typecheck", "pnpm", ["typecheck"]);

// Layer 2: unit & integration tests (mocked LLM, no network)
run("Layer 2/4: unit tests", "pnpm", ["test"]);

// Layer 3: build
run("Layer 3/4: build", "pnpm", ["build"]);

// Layer 4: smoke against the real CLI
run("Layer 4/4: cli smoke (--version)", "node", ["dist/main.js", "--version"]);

const smoke = skipSmoke ? null : smokeConfig();
if (!smoke) {
  console.log(
    "\n=== Layer 4/4: llm smoke ===\nSkipped (no FASTAI_API_KEY / OPENROUTER_API_KEY / SMOKE_MODEL, or --skip-smoke)",
  );
} else {
  const prompt = "Reply with exactly: STAR_OK";
  // no shell: cmd would split the prompt on spaces ("too many arguments")
  const result = spawnSync(
    "node",
    ["dist/main.js", "-m", smoke.model, "--permission-mode", "auto", "-p", prompt],
    { encoding: "utf8", timeout: 90_000 },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  console.log(`\n=== Layer 4/4: llm smoke (model: ${smoke.model}) ===`);
  console.log(output.trim());
  if (result.status !== 0 || !output.includes("STAR_OK")) {
    console.error("FAILED: llm smoke");
    failed = true;
  } else {
    console.log("LLM smoke OK");
  }
}

console.log(failed ? "\nPIPELINE FAILED" : "\nPIPELINE PASSED");
process.exit(failed ? 1 : 0);

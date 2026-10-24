import { defaultAgentTasks } from "../agent/agent-tasks";
import type { AgentLoop } from "../agent/loop";
import type { StreamEvent } from "../core/events";
import type { ImageInput } from "../core/messages";
import type { SessionStore } from "../session/store";
import { defaultTaskManager } from "../tasks/manager";
import { formatTokens } from "./cost";
import { formatStreamError } from "./format";
import { MAX_IMAGE_BYTES, imageMimeType, readImageInput, resolveMentions } from "./mentions";
import { printEventLine } from "./print-human";
import { UsageTracker, eventToJsonLine } from "./print-json";

export async function printMode(
  loop: AgentLoop,
  prompt: string,
  cwd: string,
  json: boolean,
  imagePaths: string[],
  sessionStore: SessionStore | null,
): Promise<number> {
  const flagImages: ImageInput[] = [];
  for (const imagePath of imagePaths) {
    if (!imageMimeType(imagePath)) {
      process.stderr.write(
        `[error] unsupported image type: ${imagePath} (supported: png, jpg, jpeg, gif, webp)\n`,
      );
      return 1;
    }
    const image = await readImageInput(imagePath, cwd);
    if (!image) {
      process.stderr.write(
        `[error] cannot read image: ${imagePath} (missing, unreadable, or larger than ${MAX_IMAGE_BYTES / (1024 * 1024)}MB)\n`,
      );
      return 1;
    }
    flagImages.push(image);
  }
  const controller = new AbortController();
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  loop.onHookWarning = (message) => {
    process.stderr.write(`[hook] ${message}\n`);
  };
  const usage = new UsageTracker();
  loop.onUsage = (delta) => usage.add(delta);
  let exitCode = 0;
  let pending: StreamEvent[] = [];
  const emit = (event: StreamEvent) => {
    if (json) {
      const line = eventToJsonLine(event);
      if (line) process.stdout.write(`${line}\n`);
      return;
    }
    const line = printEventLine(event);
    if (line) (line.stream === "stdout" ? process.stdout : process.stderr).write(line.text);
  };
  const flushPending = () => {
    for (const event of pending) emit(event);
    pending = [];
  };
  try {
    const resolved = await resolveMentions(prompt, cwd);
    if (resolved.attached.length > 0) {
      process.stderr.write(`[attached] ${resolved.attached.join(", ")}\n`);
    }
    for (const skip of resolved.skipped) {
      process.stderr.write(`[skipped] @${skip.path}: ${skip.reason}\n`);
    }
    const images = [...flagImages, ...resolved.images];
    const input: string | { text: string; images: ImageInput[] } =
      images.length > 0 ? { text: resolved.input, images } : resolved.input;
    for await (const event of loop.stream(input, controller.signal, { persistAs: prompt })) {
      if (event.type === "retry") {
        pending = [];
        emit(event);
      } else if (event.type === "finish" || event.type === "error") {
        flushPending();
        if (event.type === "error") {
          emit(event);
          exitCode = 1;
        }
      } else if (event.type === "notice") {
        emit(event);
      } else {
        pending.push(event);
      }
      if (exitCode !== 0) break;
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      const message = error instanceof Error ? formatStreamError(error) : String(error);
      process.stderr.write(`\n[error] ${message}\n`);
      exitCode = 1;
    }
  } finally {
    flushPending();
    if (interrupted) exitCode = 130;
    const usageLine = usage.toJsonLine();
    if (usageLine) {
      if (json) {
        process.stdout.write(`${usageLine}\n`);
      } else {
        const t = usage.totals;
        process.stderr.write(
          `[usage] ${t.requests} requests, ${formatTokens(t.promptTokens)} prompt + ${formatTokens(t.completionTokens)} completion = ${formatTokens(t.totalTokens)} tokens\n`,
        );
      }
    }
    if (!json) process.stdout.write("\n");
    process.off("SIGINT", onSigint);
    const stopped = defaultTaskManager.cleanup().length + defaultAgentTasks.cleanup().length;
    if (stopped > 0) {
      process.stderr.write(
        `[info] ${stopped} background task(s) were still running and have been stopped.\n`,
      );
    }
    await sessionStore?.close();
  }
  return exitCode;
}

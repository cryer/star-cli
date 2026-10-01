import { z } from "zod";
import { probeImageDimensions } from "../core/image";
import { type ScreenshotResult, captureScreenshot } from "../core/screenshot";
import type { Tool } from "./types";

const schema = z.object({});

// Lets the model look at the actual screen mid-session — the visual debugging
// counterpart of read_image: start a dev server or GUI program, screenshot,
// then judge the real rendered output instead of guessing from code. The
// capture function is injectable so tests never touch a real display.
export function createScreenshotTool(
  capture: () => Promise<ScreenshotResult> = captureScreenshot,
): Tool<typeof schema> {
  return {
    name: "screenshot",
    description:
      "Capture a screenshot of the primary display and see it. Use this to check the actual visual result of a running program (web page, GUI) — e.g. after starting a dev server — instead of inferring from code. The capture shows exactly what is visible on screen, including overlapping windows: content hidden behind other windows cannot be seen, so if a specific window matters ask the user to bring it to the front first. Note the capture may include anything else currently on screen.",
    permission: "read",
    parameters: schema,
    async execute() {
      const result = await capture();
      if (!result.ok) {
        return { content: `Screenshot failed: ${result.error}`, isError: true };
      }
      const image = result.image;
      const dims = probeImageDimensions(Buffer.from(image.data, "base64"));
      const sizeKB = Math.round(image.data.length / 1024);
      const desc = dims ? `${dims.width}x${dims.height}` : "unknown dimensions";
      return {
        content: `Screenshot captured (${desc}, ~${sizeKB}KB). The image is attached below — look at it now.`,
        images: [image],
      };
    },
  };
}

export const screenshotTool = createScreenshotTool();

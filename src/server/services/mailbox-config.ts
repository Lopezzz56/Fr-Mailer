import fs from "fs/promises";
import path from "path";
import { env } from "../config.js";

/**
 * Updates ALLOW_LIVE_SENDING in memory and on disk (.env).
 */
export async function setLiveSending(enabled: boolean): Promise<{ success: boolean; allowLiveSending: boolean }> {
  env.ALLOW_LIVE_SENDING = enabled;

  const envPath = path.resolve(process.cwd(), ".env");
  try {
    let content = await fs.readFile(envPath, "utf-8");
    const regex = new RegExp(`^ALLOW_LIVE_SENDING=.*$`, "m");
    const formattedVal = enabled ? "true" : "false";
    if (regex.test(content)) {
      content = content.replace(regex, `ALLOW_LIVE_SENDING=${formattedVal}`);
    } else {
      content += `\nALLOW_LIVE_SENDING=${formattedVal}`;
    }
    await fs.writeFile(envPath, content, "utf-8");
  } catch (err) {
    console.warn("[mailbox-config] Could not write ALLOW_LIVE_SENDING to .env:", (err as Error).message);
  }

  return { success: true, allowLiveSending: env.ALLOW_LIVE_SENDING };
}

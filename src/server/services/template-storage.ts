import { env, templateStorageConfigured } from "../config.js";
import { AppError } from "../middleware/error-handler.js";

export interface StoredTemplateAttachment {
  [key: string]: string | number;
  id: string;
  name: string;
  contentType: string;
  size: number;
  storageKey: string;
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

function objectUrl(path: string): string {
  return `${bucketUrl()}/${encodePath(path)}`;
}

function bucketUrl(): string {
  if (!templateStorageConfigured || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new AppError("TEMPLATE_STORAGE_UNAVAILABLE", "Template attachments are unavailable until Supabase Storage is configured.", 503);
  }
  return `${env.SUPABASE_URL.replace(/\/+$/, "")}/storage/v1/object/${encodeURIComponent(env.SUPABASE_STORAGE_BUCKET)}`;
}

async function storageRequest(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(objectUrl(path), {
      ...init,
      signal: AbortSignal.timeout(20_000),
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY!}`,
        ...init.headers,
      },
    });
  } catch {
    throw new AppError("TEMPLATE_STORAGE_UNAVAILABLE", "Supabase Storage could not be reached. Try again shortly.", 503);
  }
}

export async function uploadTemplateAttachment(path: string, contentType: string, data: Buffer): Promise<void> {
  const response = await storageRequest(path, {
    method: "POST",
    headers: { "Content-Type": contentType, "x-upsert": "false" },
    body: new Uint8Array(data),
  });
  if (!response.ok) {
    console.error(`[template-storage] upload failed with status ${response.status}`);
    throw new AppError("TEMPLATE_STORAGE_UPLOAD_FAILED", "The attachment couldn't be stored. Check the private Supabase Storage bucket configuration and try again.", 503);
  }
}

export async function downloadTemplateAttachment(path: string): Promise<Buffer> {
  const response = await storageRequest(path, { method: "GET" });
  if (!response.ok) {
    console.error(`[template-storage] download failed with status ${response.status}`);
    throw new AppError("TEMPLATE_STORAGE_DOWNLOAD_FAILED", "A campaign attachment is unavailable in storage.", 503);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function deleteTemplateAttachmentObject(path: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(bucketUrl(), {
      method: "DELETE",
      signal: AbortSignal.timeout(20_000),
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY!}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefixes: [path] }),
    });
  } catch {
    throw new AppError("TEMPLATE_STORAGE_UNAVAILABLE", "Supabase Storage could not be reached. Try again shortly.", 503);
  }
  if (!response.ok && response.status !== 404) {
    console.error(`[template-storage] delete failed with status ${response.status}`);
    throw new AppError("TEMPLATE_STORAGE_DELETE_FAILED", "The attachment couldn't be removed from storage.", 503);
  }
}

export function storedAttachments(value: unknown): StoredTemplateAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is StoredTemplateAttachment =>
      typeof item === "object" &&
      item !== null &&
      typeof item.id === "string" &&
      typeof item.name === "string" &&
      typeof item.contentType === "string" &&
      typeof item.size === "number" &&
      typeof item.storageKey === "string"
  );
}

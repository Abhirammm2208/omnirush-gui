/**
 * Office attachments (docx, xlsx, pptx) on the 2.x engine. The engine reads a text or image attachment itself but
 * drops these silently, so a prompt's office files become the same text the 1.x engine's office plugin produced
 * (opencode-plugins/omnirush-office-attachments.ts, loaded from where the app ships it): user content added to the
 * prompt, the file's exact bytes kept in the project's inbox as before.
 */
import { pathToFileURL } from "node:url";

import { omnirushPluginPath } from "./omnirush-extensions-plugin-path.js";

type PromptFile = { uri?: unknown; name?: unknown; description?: unknown };
type OfficePlugin = (input: { directory: string }) => Promise<{
  "experimental.chat.messages.transform": (input: unknown, output: { messages: unknown[] }) => Promise<void>;
}>;

const OFFICE = /\.(docx|xlsx|pptx)$/i;
const OFFICE_MIME = /officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)/i;

let plugin: Promise<OfficePlugin> | undefined;
const officePlugin = () => (plugin ??= import(pathToFileURL(omnirushPluginPath("omnirush-office-attachments")).href)
  .then((module: { OmniRushOfficeAttachments: OfficePlugin }) => module.OmniRushOfficeAttachments));

function isOffice(file: PromptFile): boolean {
  const name = typeof file.name === "string" ? file.name : "";
  const uri = typeof file.uri === "string" ? file.uri : "";
  return OFFICE.test(name) || OFFICE.test(uri.split("?")[0] ?? "") || OFFICE_MIME.test(uri.slice(0, 120));
}

/** The prompt body with its office files turned into text; the body as it was when it has none. */
export async function convertOfficeAttachments(body: Record<string, unknown>, root: string): Promise<Record<string, unknown>> {
  const files = Array.isArray(body.files) ? (body.files as PromptFile[]) : [];
  const office = files.filter(isOffice);
  if (office.length === 0) return body;
  const parts = office.map((file) => ({
    type: "file", url: file.uri, filename: typeof file.name === "string" ? file.name : "attachment",
  }));
  const output = { messages: [{ info: { role: "user" }, parts }] };
  await (await (await officePlugin())({ directory: root }))["experimental.chat.messages.transform"]({}, output);
  const converted = (output.messages[0] as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [];
  const texts = converted.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string);
  const rest = files.filter((file) => !isOffice(file));
  const text = [typeof body.text === "string" ? body.text : "", ...texts].filter(Boolean).join("\n\n");
  const next: Record<string, unknown> = { ...body, text };
  if (rest.length) next.files = rest;
  else delete next.files;
  return next;
}

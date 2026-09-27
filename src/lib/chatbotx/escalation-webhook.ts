/**
 * Track B B3 — ChatbotX escalation webhook.
 *
 * Default mode is dry-run: build and sign the JSON body, do not POST.
 * Stub mode posts only to loopback and only for ZZ test fixtures.
 * This module does not import the WhatsApp client.
 */

import crypto from "crypto";
import {
  assertZzFixture,
  buildEscalationPayload,
  serializeEscalation,
  type ChatbotxEscalationPayload,
  type EscalationDraft,
} from "@/lib/chatbotx/ticket-adapter";

export const SIGNATURE_HEADER = "X-Owly-ChatbotX-Signature";
export const KEY_ID_HEADER = "X-Owly-ChatbotX-Key-Id";
export const TIMESTAMP_HEADER = "X-Owly-ChatbotX-Timestamp";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const STUB_TIMEOUT_MS = 5000;

export type BridgeMode = "dry-run" | "stub";

export class ChatbotxBridgeError extends Error {
  readonly code: "CE_SAFE" | "STUB_URL" | "UNSIGNED" | "UPSTREAM";

  constructor(code: ChatbotxBridgeError["code"], message: string) {
    super(message);
    this.name = "ChatbotxBridgeError";
    this.code = code;
  }
}

export interface DeliverOptions {
  mode?: BridgeMode;
  url?: string;
  secret?: string;
  keyId?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}

export interface DeliveryResult {
  ok: true;
  mode: BridgeMode;
  posted: boolean;
  isolatedFromLive10x: true;
  liveWhatsAppSession: false;
  status: number | null;
  signature: string | null;
  keyId: string | null;
  payload: ChatbotxEscalationPayload;
  body: string;
}

export function signEscalationBody(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * The HTTP handler may request stub mode, but it only takes effect when the
 * server env is also set to stub. Otherwise the call stays a dry-run.
 */
export function resolveBridgeMode(requested: string | undefined): BridgeMode {
  const envMode = process.env.CHATBOTX_BRIDGE_MODE === "stub" ? "stub" : "dry-run";
  if (requested === "stub" && envMode === "stub") return "stub";
  return "dry-run";
}

export function assertLoopbackStubUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ChatbotxBridgeError("STUB_URL", "ChatbotX stub URL is not a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ChatbotxBridgeError("STUB_URL", "ChatbotX stub URL must be http or https");
  }

  if (url.username || url.password) {
    throw new ChatbotxBridgeError("STUB_URL", "ChatbotX stub URL must not include credentials");
  }

  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ChatbotxBridgeError(
      "STUB_URL",
      "ChatbotX stub URL must be loopback (localhost, 127.0.0.1, or ::1). Live 10X hosts are refused."
    );
  }

  return url;
}

export async function deliverEscalation(
  draft: EscalationDraft,
  options: DeliverOptions = {}
): Promise<DeliveryResult> {
  const mode = options.mode ?? "dry-run";
  const now = options.now ?? new Date();
  const payload = buildEscalationPayload(draft, now);
  const body = serializeEscalation(payload);
  const secret = options.secret ?? "";
  const signature = secret ? signEscalationBody(body, secret) : null;
  const keyId = options.keyId ?? null;

  if (mode !== "stub") {
    return {
      ok: true,
      mode: "dry-run",
      posted: false,
      isolatedFromLive10x: true,
      liveWhatsAppSession: false,
      status: null,
      signature,
      keyId,
      payload,
      body,
    };
  }

  try {
    assertZzFixture(draft);
  } catch (error) {
    const message = error instanceof Error ? error.message : "CE-safe check failed";
    throw new ChatbotxBridgeError("CE_SAFE", message);
  }

  if (!secret) {
    throw new ChatbotxBridgeError(
      "UNSIGNED",
      "Stub post requires CHATBOTX_BRIDGE_SECRET. Refusing to POST an unsigned payload."
    );
  }

  const url = assertLoopbackStubUrl(options.url ?? "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STUB_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Owly-ChatbotX-Bridge/0.1 (stub; no-whatsapp)",
        [SIGNATURE_HEADER]: signature as string,
        [KEY_ID_HEADER]: keyId || "example-chatbotx-bridge",
        [TIMESTAMP_HEADER]: payload.timestamp,
      },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "ChatbotX stub POST timed out"
        : `ChatbotX stub POST failed: ${error instanceof Error ? error.message : "unknown error"}`;
    throw new ChatbotxBridgeError("UPSTREAM", message);
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new ChatbotxBridgeError(
      "UPSTREAM",
      `ChatbotX stub responded HTTP ${response.status}`
    );
  }

  return {
    ok: true,
    mode: "stub",
    posted: true,
    isolatedFromLive10x: true,
    liveWhatsAppSession: false,
    status: response.status,
    signature,
    keyId,
    payload,
    body,
  };
}

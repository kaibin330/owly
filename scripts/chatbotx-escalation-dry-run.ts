/**
 * Track B B3 dry-run.
 *
 * Prints the ChatbotX escalation JSON for a ZZ fixture and does not POST.
 * Run: npm run chatbotx:dry-run
 *
 * Uses ZZ test names only. No database, no WhatsApp session, no live 10X host.
 */

import {
  buildEscalationPayload,
  serializeEscalation,
  type EscalationDraft,
} from "../src/lib/chatbotx/ticket-adapter";
import { signEscalationBody } from "../src/lib/chatbotx/escalation-webhook";

const EXAMPLE_SECRET = "example-only-not-a-real-secret";
const FIXTURE_CLOCK = new Date("2026-09-27T00:00:00.000Z");

const draft: EscalationDraft = {
  ticketId: "zz-ticket-b3",
  title: "ZZ escalation fixture",
  description: "Spike-only ticket used to show the ChatbotX payload. No client send.",
  status: "open",
  priority: "high",
  resolution: "",
  departmentName: "ZZ Test Desk",
  assignedToName: "ZZ Spike Agent",
  conversationId: "zz-conversation-b3",
  channel: "whatsapp",
  conversationStatus: "escalated",
  customerName: "ZZ Test Customer",
  customerContact: "zz-test-contact",
  reason: "manual",
};

const payload = buildEscalationPayload(draft, FIXTURE_CLOCK);
const body = serializeEscalation(payload);
const signature = signEscalationBody(body, EXAMPLE_SECRET);

const proof = {
  track: "B",
  phase: "B3",
  mode: "dry-run",
  posted: false,
  liveWhatsAppSession: false,
  isolatedFromLive10x: true,
  customerName: draft.customerName,
  note: "Signature uses the example secret from this script. It is not a production key.",
  signature,
  payload,
};

console.log(JSON.stringify(proof, null, 2));

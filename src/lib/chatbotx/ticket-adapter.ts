/**
 * Track B B3 — Owly ticket → ChatbotX escalation adapter.
 *
 * Pure mapping. Does not read the database, open a WhatsApp session,
 * or send a customer message. See TRACK-B-B3.md.
 */

export const CHATBOTX_ESCALATION_SCHEMA = "owly.chatbotx.escalation.v1";

export const ESCALATION_REASONS = [
  "manual",
  "sla_breach",
  "low_confidence",
  "human_approval",
  "ticket_created",
] as const;

export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** Display names allowed on a stub post. Proof runs use these only. */
export const ZZ_TEST_NAME = /^ZZ\s+\S/;

/** Synthetic contacts allowed on a stub post. Not a phone number. */
export const ZZ_TEST_CONTACT = /^zz-test-[a-z0-9-]{1,64}$/i;

export interface TicketConversationRecord {
  id: string;
  channel: string;
  status: string;
  customerName: string;
  customerContact: string;
}

/** Structural view of an Owly Ticket row. The Prisma model is unchanged. */
export interface OwlyTicketRecord {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  resolution: string;
  department: { name: string } | null;
  assignedTo: { name: string } | null;
  conversation: TicketConversationRecord | null;
}

export interface EscalationDraft {
  ticketId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  resolution: string;
  departmentName: string | null;
  assignedToName: string | null;
  conversationId: string | null;
  channel: string | null;
  conversationStatus: string | null;
  customerName: string | null;
  customerContact: string;
  reason: EscalationReason;
}

export interface ChatbotxEscalationPayload {
  schema: typeof CHATBOTX_ESCALATION_SCHEMA;
  event: "ticket.escalated";
  timestamp: string;
  source: {
    system: "owly";
    spike: "track-b-b3";
    isolatedFromLive10x: true;
  };
  ticket: {
    id: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    resolution: string;
    departmentName: string | null;
    assignedToName: string | null;
  };
  conversation: {
    id: string;
    channel: string;
    status: string;
    customerName: string;
    customerContact: string | null;
    customerContactRedacted: boolean;
  } | null;
  escalation: {
    reason: EscalationReason;
    unofficialWhatsApp: boolean;
    channelRisk: "unofficial-whatsapp-web" | "not-whatsapp";
    liveSessionInvoked: false;
  };
}

export function isZzTestName(name: string | null | undefined): boolean {
  return typeof name === "string" && ZZ_TEST_NAME.test(name);
}

export function isZzTestContact(contact: string | null | undefined): boolean {
  return typeof contact === "string" && ZZ_TEST_CONTACT.test(contact);
}

/**
 * Stub posts accept only ZZ fixtures.
 * A real phone number or client name fails closed instead of being forwarded.
 */
export function assertZzFixture(draft: EscalationDraft): void {
  if (!isZzTestName(draft.customerName)) {
    throw new Error(
      "CE-safe stub refuses this escalation: customerName must be a ZZ test name"
    );
  }
  if (draft.customerContact && !isZzTestContact(draft.customerContact)) {
    throw new Error(
      "CE-safe stub refuses this escalation: customerContact must be empty or zz-test-*"
    );
  }
}

export function adaptTicket(
  record: OwlyTicketRecord,
  reason: EscalationReason
): EscalationDraft {
  return {
    ticketId: record.id,
    title: record.title,
    description: record.description,
    status: record.status,
    priority: record.priority,
    resolution: record.resolution ?? "",
    departmentName: record.department?.name ?? null,
    assignedToName: record.assignedTo?.name ?? null,
    conversationId: record.conversation?.id ?? null,
    channel: record.conversation?.channel ?? null,
    conversationStatus: record.conversation?.status ?? null,
    customerName: record.conversation?.customerName ?? null,
    customerContact: record.conversation?.customerContact ?? "",
    reason,
  };
}

function projectContact(
  customerName: string | null,
  customerContact: string
): { customerContact: string | null; customerContactRedacted: boolean } {
  if (isZzTestName(customerName) && isZzTestContact(customerContact)) {
    return { customerContact, customerContactRedacted: false };
  }
  if (!customerContact) {
    return { customerContact: null, customerContactRedacted: false };
  }
  return { customerContact: null, customerContactRedacted: true };
}

export function buildEscalationPayload(
  draft: EscalationDraft,
  now: Date
): ChatbotxEscalationPayload {
  const unofficialWhatsApp = draft.channel === "whatsapp";
  const contact = projectContact(draft.customerName, draft.customerContact);

  return {
    schema: CHATBOTX_ESCALATION_SCHEMA,
    event: "ticket.escalated",
    timestamp: now.toISOString(),
    source: {
      system: "owly",
      spike: "track-b-b3",
      isolatedFromLive10x: true,
    },
    ticket: {
      id: draft.ticketId,
      title: draft.title,
      description: draft.description,
      status: draft.status,
      priority: draft.priority,
      resolution: draft.resolution,
      departmentName: draft.departmentName,
      assignedToName: draft.assignedToName,
    },
    conversation: draft.conversationId
      ? {
          id: draft.conversationId,
          channel: draft.channel ?? "unknown",
          status: draft.conversationStatus ?? "unknown",
          customerName: draft.customerName ?? "Unknown",
          customerContact: contact.customerContact,
          customerContactRedacted: contact.customerContactRedacted,
        }
      : null,
    escalation: {
      reason: draft.reason,
      unofficialWhatsApp,
      channelRisk: unofficialWhatsApp ? "unofficial-whatsapp-web" : "not-whatsapp",
      liveSessionInvoked: false,
    },
  };
}

export function serializeEscalation(payload: ChatbotxEscalationPayload): string {
  return JSON.stringify(payload);
}

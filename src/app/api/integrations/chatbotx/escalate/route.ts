/**
 * Track B B3 — inbound hook ChatbotX (or a local stub) can call.
 *
 * Auth: existing Owly cookie or X-API-Key via requireAuth (tickets:read).
 * Default response is the signed JSON payload with posted=false.
 * Does not create tickets, change conversation status, or touch WhatsApp.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import {
  CHATBOTX_ESCALATION_SCHEMA,
  ESCALATION_REASONS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  adaptTicket,
  type EscalationDraft,
  type EscalationReason,
  type OwlyTicketRecord,
} from "@/lib/chatbotx/ticket-adapter";
import {
  ChatbotxBridgeError,
  KEY_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  deliverEscalation,
  resolveBridgeMode,
} from "@/lib/chatbotx/escalation-webhook";

const conversationSchema = z.object({
  id: z.string().min(1).max(100),
  channel: z.enum(["whatsapp", "email", "phone", "sms", "telegram", "api", "widget", "web"]),
  status: z.string().min(1).max(40),
  customerName: z.string().min(1).max(200),
  customerContact: z.string().max(500).optional().default(""),
});

const ticketSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  description: z.string().max(5000).optional().default(""),
  status: z.enum(TICKET_STATUSES).optional().default("open"),
  priority: z.enum(TICKET_PRIORITIES).optional().default("medium"),
  resolution: z.string().max(5000).optional().default(""),
  departmentName: z.string().max(200).nullable().optional(),
  assignedToName: z.string().max(200).nullable().optional(),
  conversation: conversationSchema.nullable().optional(),
});

const bodySchema = z
  .object({
    mode: z.enum(["dry-run", "stub"]).optional(),
    reason: z.enum(ESCALATION_REASONS).optional().default("manual"),
    ticketId: z.string().min(1).max(100).optional(),
    ticket: ticketSchema.optional(),
  })
  .refine((data) => Boolean(data.ticket || data.ticketId), {
    message: "ticket or ticketId is required",
  });

function draftFromInline(
  ticket: z.infer<typeof ticketSchema>,
  reason: EscalationReason
): EscalationDraft {
  const conversation = ticket.conversation ?? null;
  return {
    ticketId: ticket.id,
    title: ticket.title,
    description: ticket.description,
    status: ticket.status,
    priority: ticket.priority,
    resolution: ticket.resolution,
    departmentName: ticket.departmentName ?? null,
    assignedToName: ticket.assignedToName ?? null,
    conversationId: conversation?.id ?? null,
    channel: conversation?.channel ?? null,
    conversationStatus: conversation?.status ?? null,
    customerName: conversation?.customerName ?? null,
    customerContact: conversation?.customerContact ?? "",
    reason,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "tickets:read");
  if (!isAuthenticated(auth)) return auth;

  return NextResponse.json({
    schema: CHATBOTX_ESCALATION_SCHEMA,
    event: "ticket.escalated",
    methods: ["POST"],
    defaultMode: "dry-run",
    isolatedFromLive10x: true,
    liveWhatsAppSession: false,
    unofficialWhatsAppRisk:
      "Owly's WhatsApp client is whatsapp-web.js (unofficial Web protocol). This route never starts that client.",
    auth: {
      inbound: ["cookie:owly-token", "header:X-API-Key"],
      permission: "tickets:read",
      outbound: {
        algorithm: "HMAC-SHA256",
        signatureHeader: SIGNATURE_HEADER,
        keyIdHeader: KEY_ID_HEADER,
        timestampHeader: TIMESTAMP_HEADER,
        secretEnv: "CHATBOTX_BRIDGE_SECRET",
      },
    },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "tickets:read");
  if (!isAuthenticated(auth)) return auth;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid escalation request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { reason, ticketId } = parsed.data;
  const requestedMode = parsed.data.mode;
  const mode = resolveBridgeMode(requestedMode);

  try {
    const draft = parsed.data.ticket
      ? draftFromInline(parsed.data.ticket, reason)
      : await draftFromTicketId(ticketId as string, reason);

    if (!draft) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    const result = await deliverEscalation(draft, {
      mode,
      url: process.env.CHATBOTX_BRIDGE_URL,
      secret: process.env.CHATBOTX_BRIDGE_SECRET,
      keyId: process.env.CHATBOTX_BRIDGE_KEY_ID || "example-chatbotx-bridge",
    });

    logger.info("ChatbotX escalation bridge evaluated", {
      ticketId: draft.ticketId,
      mode: result.mode,
      posted: result.posted,
    });

    return NextResponse.json({
      ...result,
      stubIgnored: requestedMode === "stub" && result.mode === "dry-run",
    });
  } catch (error) {
    if (error instanceof ChatbotxBridgeError) {
      const status = error.code === "UPSTREAM" ? 502 : 422;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    logger.error("ChatbotX escalation bridge failed", error);
    return NextResponse.json({ error: "Failed to build escalation payload" }, { status: 500 });
  }
}

async function draftFromTicketId(
  ticketId: string,
  reason: EscalationReason
): Promise<EscalationDraft | null> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      conversation: {
        select: {
          id: true,
          channel: true,
          status: true,
          customerName: true,
          customerContact: true,
        },
      },
      department: { select: { name: true } },
      assignedTo: { select: { name: true } },
    },
  });

  if (!ticket) return null;

  const record: OwlyTicketRecord = {
    id: ticket.id,
    title: ticket.title,
    description: ticket.description,
    status: ticket.status,
    priority: ticket.priority,
    resolution: ticket.resolution,
    department: ticket.department,
    assignedTo: ticket.assignedTo,
    conversation: ticket.conversation,
  };

  return adaptTicket(record, reason);
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("ChatbotX escalate route", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.CHATBOTX_BRIDGE_MODE = "dry-run";
    delete process.env.CHATBOTX_BRIDGE_URL;
    process.env.CHATBOTX_BRIDGE_SECRET = "example-only-not-a-real-secret";
    process.env.CHATBOTX_BRIDGE_KEY_ID = "example-chatbotx-bridge";
  });

  afterEach(() => {
    delete process.env.CHATBOTX_BRIDGE_MODE;
    delete process.env.CHATBOTX_BRIDGE_URL;
    delete process.env.CHATBOTX_BRIDGE_SECRET;
    delete process.env.CHATBOTX_BRIDGE_KEY_ID;
  });

  it("GET describes the contract and does not post", async () => {
    const { GET } = await import("@/app/api/integrations/chatbotx/escalate/route");
    const response = await GET(createRequest("/api/integrations/chatbotx/escalate"));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.schema).toBe("owly.chatbotx.escalation.v1");
    expect(data.defaultMode).toBe("dry-run");
    expect(data.liveWhatsAppSession).toBe(false);
    expect(data.auth.permission).toBe("tickets:read");
  });

  it("POST dry-run returns the ZZ payload and does not post", async () => {
    const { POST } = await import("@/app/api/integrations/chatbotx/escalate/route");
    const response = await POST(
      createRequest("/api/integrations/chatbotx/escalate", {
        method: "POST",
        body: {
          mode: "dry-run",
          reason: "manual",
          ticket: {
            id: "zz-ticket-b3",
            title: "ZZ escalation fixture",
            description: "Spike fixture",
            priority: "high",
            conversation: {
              id: "zz-conversation-b3",
              channel: "whatsapp",
              status: "escalated",
              customerName: "ZZ Test Customer",
              customerContact: "zz-test-contact",
            },
          },
        },
      })
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.posted).toBe(false);
    expect(data.mode).toBe("dry-run");
    expect(data.payload.conversation.customerName).toBe("ZZ Test Customer");
    expect(data.payload.escalation.liveSessionInvoked).toBe(false);
    expect(data.payload.escalation.unofficialWhatsApp).toBe(true);
  });

  it("ignores a requested stub post unless the server mode is stub", async () => {
    const { POST } = await import("@/app/api/integrations/chatbotx/escalate/route");
    const response = await POST(
      createRequest("/api/integrations/chatbotx/escalate", {
        method: "POST",
        body: {
          mode: "stub",
          ticket: {
            id: "zz-ticket-b3",
            title: "ZZ escalation fixture",
            conversation: {
              id: "zz-conversation-b3",
              channel: "email",
              status: "escalated",
              customerName: "ZZ Test Customer",
              customerContact: "zz-test-contact",
            },
          },
        },
      })
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.mode).toBe("dry-run");
    expect(data.posted).toBe(false);
    expect(data.stubIgnored).toBe(true);
  });

  it("loads a ticket by id without writing it back", async () => {
    mockPrisma.ticket.findUnique.mockResolvedValue({
      id: "zz-ticket-b3",
      title: "ZZ escalation fixture",
      description: "from db",
      status: "open",
      priority: "medium",
      resolution: "",
      department: { name: "ZZ Test Desk" },
      assignedTo: null,
      conversation: {
        id: "zz-conversation-b3",
        channel: "email",
        status: "escalated",
        customerName: "ZZ Test Customer",
        customerContact: "zz-test-contact",
      },
    });

    const { POST } = await import("@/app/api/integrations/chatbotx/escalate/route");
    const response = await POST(
      createRequest("/api/integrations/chatbotx/escalate", {
        method: "POST",
        body: { ticketId: "zz-ticket-b3", reason: "ticket_created" },
      })
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.payload.ticket.description).toBe("from db");
    expect(data.payload.escalation.reason).toBe("ticket_created");
    expect(data.payload.escalation.unofficialWhatsApp).toBe(false);
    expect(mockPrisma.ticket.update).not.toHaveBeenCalled();
    expect(mockPrisma.conversation.update).not.toHaveBeenCalled();
  });

  it("returns 404 when the ticket id is missing", async () => {
    mockPrisma.ticket.findUnique.mockResolvedValue(null);
    const { POST } = await import("@/app/api/integrations/chatbotx/escalate/route");
    const response = await POST(
      createRequest("/api/integrations/chatbotx/escalate", {
        method: "POST",
        body: { ticketId: "missing" },
      })
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 when neither ticket nor ticketId is present", async () => {
    const { POST } = await import("@/app/api/integrations/chatbotx/escalate/route");
    const response = await POST(
      createRequest("/api/integrations/chatbotx/escalate", {
        method: "POST",
        body: { reason: "manual" },
      })
    );
    expect(response.status).toBe(400);
  });
});

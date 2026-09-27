import { describe, it, expect, vi } from "vitest";
import crypto from "crypto";
import {
  adaptTicket,
  buildEscalationPayload,
  isZzTestContact,
  isZzTestName,
  type EscalationDraft,
  type OwlyTicketRecord,
} from "@/lib/chatbotx/ticket-adapter";
import {
  ChatbotxBridgeError,
  assertLoopbackStubUrl,
  deliverEscalation,
  signEscalationBody,
} from "@/lib/chatbotx/escalation-webhook";

const NOW = new Date("2026-09-27T00:00:00.000Z");
const EXAMPLE_SECRET = "example-only-not-a-real-secret";

function zzDraft(overrides: Partial<EscalationDraft> = {}): EscalationDraft {
  return {
    ticketId: "zz-ticket-b3",
    title: "ZZ escalation fixture",
    description: "Spike fixture",
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
    ...overrides,
  };
}

describe("ChatbotX ticket adapter", () => {
  it("maps an Owly ticket record into an escalation draft", () => {
    const record: OwlyTicketRecord = {
      id: "zz-ticket-b3",
      title: "ZZ escalation fixture",
      description: "Spike fixture",
      status: "open",
      priority: "high",
      resolution: "",
      department: { name: "ZZ Test Desk" },
      assignedTo: { name: "ZZ Spike Agent" },
      conversation: {
        id: "zz-conversation-b3",
        channel: "whatsapp",
        status: "escalated",
        customerName: "ZZ Test Customer",
        customerContact: "zz-test-contact",
      },
    };

    const draft = adaptTicket(record, "sla_breach");
    expect(draft.ticketId).toBe("zz-ticket-b3");
    expect(draft.departmentName).toBe("ZZ Test Desk");
    expect(draft.reason).toBe("sla_breach");
    expect(draft.channel).toBe("whatsapp");
  });

  it("builds a payload that flags unofficial WhatsApp without invoking a session", () => {
    const payload = buildEscalationPayload(zzDraft(), NOW);

    expect(payload.schema).toBe("owly.chatbotx.escalation.v1");
    expect(payload.event).toBe("ticket.escalated");
    expect(payload.source.isolatedFromLive10x).toBe(true);
    expect(payload.escalation.unofficialWhatsApp).toBe(true);
    expect(payload.escalation.channelRisk).toBe("unofficial-whatsapp-web");
    expect(payload.escalation.liveSessionInvoked).toBe(false);
    expect(payload.conversation?.customerName).toBe("ZZ Test Customer");
    expect(payload.conversation?.customerContact).toBe("zz-test-contact");
    expect(payload.conversation?.customerContactRedacted).toBe(false);
  });

  it("redacts contacts that are not zz-test fixtures", () => {
    const payload = buildEscalationPayload(
      zzDraft({
        customerName: "ZZ Test Customer",
        customerContact: "+15551212",
      }),
      NOW
    );

    expect(payload.conversation?.customerContact).toBeNull();
    expect(payload.conversation?.customerContactRedacted).toBe(true);
  });

  it("recognizes only ZZ test names and zz-test contacts", () => {
    expect(isZzTestName("ZZ Test Customer")).toBe(true);
    expect(isZzTestName("Alice")).toBe(false);
    expect(isZzTestContact("zz-test-contact")).toBe(true);
    expect(isZzTestContact("+15551212")).toBe(false);
  });
});

describe("ChatbotX escalation webhook", () => {
  it("signs the raw JSON body with HMAC-SHA256", () => {
    const body = "{\"event\":\"ticket.escalated\"}";
    const signature = signEscalationBody(body, EXAMPLE_SECRET);
    const expected = crypto.createHmac("sha256", EXAMPLE_SECRET).update(body).digest("hex");
    expect(signature).toBe(expected);
  });

  it("dry-run returns the payload and does not call fetch", async () => {
    const fetchImpl = vi.fn();
    const result = await deliverEscalation(zzDraft(), {
      mode: "dry-run",
      secret: EXAMPLE_SECRET,
      keyId: "example-chatbotx-bridge",
      now: NOW,
      fetchImpl,
    });

    expect(result.posted).toBe(false);
    expect(result.mode).toBe("dry-run");
    expect(result.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(result.body).ticket.title).toBe("ZZ escalation fixture");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stub mode posts the JSON body to loopback for a ZZ fixture", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok", { status: 202 }));
    const result = await deliverEscalation(zzDraft(), {
      mode: "stub",
      url: "http://127.0.0.1:9/chatbotx/escalations",
      secret: EXAMPLE_SECRET,
      keyId: "example-chatbotx-bridge",
      now: NOW,
      fetchImpl,
    });

    expect(result.posted).toBe(true);
    expect(result.status).toBe(202);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9/chatbotx/escalations");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(String(init.body));
    expect(sent.event).toBe("ticket.escalated");
    expect(sent.ticket.id).toBe("zz-ticket-b3");
    expect(sent.conversation.customerName).toBe("ZZ Test Customer");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Owly-ChatbotX-Signature"]).toBe(
      signEscalationBody(String(init.body), EXAMPLE_SECRET)
    );
  });

  it("refuses a stub post for a non-ZZ customer and does not call fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      deliverEscalation(zzDraft({ customerName: "Pat Example", customerContact: "zz-test-contact" }), {
        mode: "stub",
        url: "http://127.0.0.1:9/chatbotx/escalations",
        secret: EXAMPLE_SECRET,
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: "CE_SAFE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a stub post that carries a real-looking contact", async () => {
    const fetchImpl = vi.fn();
    await expect(
      deliverEscalation(zzDraft({ customerContact: "+15551212" }), {
        mode: "stub",
        url: "http://127.0.0.1:9/chatbotx/escalations",
        secret: EXAMPLE_SECRET,
        fetchImpl,
      })
    ).rejects.toBeInstanceOf(ChatbotxBridgeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses stub URLs that are not loopback", () => {
    expect(() => assertLoopbackStubUrl("https://example.com/hook")).toThrow(ChatbotxBridgeError);
    expect(() => assertLoopbackStubUrl("http://127.0.0.1:9/chatbotx/escalations")).not.toThrow();
  });

  it("refuses an unsigned stub post", async () => {
    const fetchImpl = vi.fn();
    await expect(
      deliverEscalation(zzDraft(), {
        mode: "stub",
        url: "http://127.0.0.1:9/chatbotx/escalations",
        secret: "",
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: "UNSIGNED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

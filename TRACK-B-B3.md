# Track B — Phase B3

Owly-style ticket and escalation bridge toward ChatbotX.

This is a **spike on the unofficial Owly fork** (`kaibin330/owly`, MIT). It is not a production integration and it is not a merge into the live 10X monorepo. Nothing in this phase opens a WhatsApp session or sends a message to a real client.

## Unofficial WhatsApp risk

Owly’s running WhatsApp path is the **unofficial WhatsApp Web client**, not the WhatsApp Business Platform (Cloud API).

| Piece | Where | What it actually does |
| --- | --- | --- |
| Client | `src/lib/channels/whatsapp.ts` | `whatsapp-web.js` `Client` + Puppeteer (`headless`, `--no-sandbox`) |
| Session | `LocalAuth`, data path `.wwebjs_auth` | Linked-device session on disk. Docker mounts this as `whatsapp_auth`. |
| Connect | `POST /api/channels/whatsapp` `{ action: "connect" }` | Calls `initWhatsApp()`, which initializes that client and can emit a QR code. |
| Inbound | `client.on("message")` | Resolves a customer, finds or creates a conversation, calls `chat()`, then `message.reply()`. |
| Outbound helper | `sendWhatsAppMessage()` | `client.sendMessage` when status is `connected`. |
| Settings UI | `whatsappMode`, `whatsappApiKey`, `whatsappPhone` | Stores a “Business API” key. **The channel runtime never reads that key.** There is no Cloud API send/receive implementation in this repo. |

Risk of that client, called out so it is not treated as a supported channel:

- It speaks the WhatsApp Web protocol. That is outside WhatsApp’s supported business APIs and can violate WhatsApp’s terms. Linked numbers can be banned.
- The session is a logged-in device. Whoever can read `.wwebjs_auth` can act as that number.
- The phone must stay linked. Disconnects drop the session (`disconnected` / `auth_failure`).
- Inbound handling replies automatically. Pointing it at a production number would message real customers.
- Puppeteer runs with `--no-sandbox` in the current client options.

**This B3 spike does not call `initWhatsApp`, `sendWhatsAppMessage`, or `message.reply`.** The new modules do not import `src/lib/channels/whatsapp.ts`. Payloads that describe a WhatsApp conversation set `escalation.unofficialWhatsApp: true` and `escalation.liveSessionInvoked: false`.

## Architecture map

```
WhatsApp Web (unofficial) ── message ──► src/lib/channels/whatsapp.ts
Email / SMS / Telegram / Phone ────────► src/lib/channels/*
                                              │
                                              ▼
                                    conversation row (Prisma)
                                    status: active | escalated | resolved | closed | snoozed
                                              │
                                              ▼
                                    src/lib/ai/engine.ts  chat()
                                      ├─ guardrail keyword → metadata.escalationReason (status unchanged)
                                      ├─ low confidence → conversation.status = escalated
                                      └─ tools: create_ticket / assign_to_person
                                              │
                                              ▼
                                    Ticket row (open → in_progress → resolved → closed)
                                              │
                         existing product     │     B3 spike (additive, not wired in)
                                              │
                         dashboard CRUD       │     POST /api/integrations/chatbotx/escalate
                         /api/tickets         │       dry-run JSON, or loopback stub POST
                         (no outbound event)  │       toward a future ChatbotX receiver
```

### Tickets

Prisma model `Ticket` (`prisma/schema.prisma`): `id`, optional `conversationId`, optional `departmentId`, optional `assignedToId`, `title`, `description`, `status` (`open` default), `priority` (`medium` default), `resolution`, timestamps.

Writers that already exist and are **left unchanged**:

- `POST /api/tickets` — dashboard create. Auth `tickets:create`.
- `PUT /api/tickets/[id]` — status, priority, assignment, resolution. Auth `tickets:update`.
- AI tool `create_ticket` in `src/lib/ai/tools.ts` — inserts a row linked to the current conversation. Optional department name match. Does not set conversation status to `escalated` and does not emit an event.
- AI tool `assign_to_person` — sets `assignedToId` and status `in_progress`.

The Tickets UI is `src/app/(dashboard)/tickets/page.tsx`.

B3 does **not** add columns or a migration. The adapter is a TypeScript view of that row (`src/lib/chatbotx/ticket-adapter.ts`).

### Escalation

“Escalated” is a **conversation** status, not a ticket status.

| Trigger | Code | Effect today |
| --- | --- | --- |
| Low model confidence | `estimateConfidence` in `src/lib/ai/guardrails.ts`, applied in `src/lib/ai/engine.ts` | Sets `conversation.status` to `escalated` when the score is under `0.6`. |
| Human-approval keywords | `requiresHumanApproval` (`refund`, `cancellation`, `discount`, `compensation`, `legal`) | Writes `metadata.escalationReason`, sentiment, and intent. Does **not** change status. |
| SLA first-response miss | `checkSLABreaches` in `src/lib/conversation-engine.ts` | Sets matching `active` conversations to `escalated`. |
| Operator | `PUT /api/conversations/[id]` | Accepts status `escalated` (also `snoozed`). |

Channel handlers (including WhatsApp) keep replying on conversations whose status is `active` **or** `escalated`. Escalation does not by itself stop the unofficial client from answering.

### Webhooks that already exist, and the gap

`Webhook.triggerOn` is a free string. The Webhooks screen offers `ticket_created` and `escalation`, but **no ticket or escalation path calls `deliverWebhook`**. The generic AI tool `trigger_webhook` will POST whatever URL is stored on a webhook row, with no loopback restriction. B3 does not hook that tool and does not start delivering those events automatically. Doing so would change live Owly behavior and could notify an arbitrary host.

The bridge below is a separate contract ChatbotX can call.

## How a ticket escalates into ChatbotX

Full wiring (Owly ticket create / SLA escalate → ChatbotX conversation) waits on a ChatbotX-side receiver. This fork exposes the contract and a handler ChatbotX, or a local stub, can call.

1. Something in Owly decides a ticket should leave the inbox. Today that decision is one of: manual, `sla_breach`, `low_confidence`, `human_approval`, `ticket_created`. B3 does not auto-fire on those paths.
2. Caller sends `POST /api/integrations/chatbotx/escalate` with either an inline ticket snapshot or a `ticketId`.
3. Owly authenticates the caller (cookie or API key, permission `tickets:read`).
4. The adapter builds `owly.chatbotx.escalation.v1`. Contacts that are not `zz-test-*` are removed from the JSON.
5. **Default:** `mode` is `dry-run`. The handler returns the JSON and does not open a socket.
6. **Stub:** only if `CHATBOTX_BRIDGE_MODE=stub` **and** the body asks for `mode: "stub"`. The handler POSTs the same JSON to `CHATBOTX_BRIDGE_URL`.
7. A later ChatbotX PR would verify the HMAC and open its own ticket. That code is not in this repo. Do not point step 6 at a live 10X URL; the stub URL check rejects anything that is not loopback.

`GET /api/integrations/chatbotx/escalate` returns the contract (schema, auth headers, default mode) and does not post.

The handler does not insert or update `Ticket` or `Conversation` rows.

## Payload

`event` is always `ticket.escalated`. `schema` is `owly.chatbotx.escalation.v1`.

```json
{
  "schema": "owly.chatbotx.escalation.v1",
  "event": "ticket.escalated",
  "timestamp": "2026-09-27T00:00:00.000Z",
  "source": {
    "system": "owly",
    "spike": "track-b-b3",
    "isolatedFromLive10x": true
  },
  "ticket": {
    "id": "zz-ticket-b3",
    "title": "ZZ escalation fixture",
    "description": "Spike-only ticket used to show the ChatbotX payload. No client send.",
    "status": "open",
    "priority": "high",
    "resolution": "",
    "departmentName": "ZZ Test Desk",
    "assignedToName": "ZZ Spike Agent"
  },
  "conversation": {
    "id": "zz-conversation-b3",
    "channel": "whatsapp",
    "status": "escalated",
    "customerName": "ZZ Test Customer",
    "customerContact": "zz-test-contact",
    "customerContactRedacted": false
  },
  "escalation": {
    "reason": "manual",
    "unofficialWhatsApp": true,
    "channelRisk": "unofficial-whatsapp-web",
    "liveSessionInvoked": false
  }
}
```

`reason` is one of `manual`, `sla_breach`, `low_confidence`, `human_approval`, `ticket_created`.

`channelRisk` is `unofficial-whatsapp-web` when the linked conversation channel is `whatsapp`, otherwise `not-whatsapp`. `unofficialWhatsApp` mirrors that. `liveSessionInvoked` is always `false` in this spike.

Message transcripts are omitted on purpose. They can contain customer content, and ChatbotX does not receive them until a later PR defines a redaction policy.

Non-fixture contacts are dropped: `customerContact` becomes `null` and `customerContactRedacted` becomes `true`. A stub POST still refuses the call unless the **input** name matches `^ZZ\s+\S` and the contact is empty or `^zz-test-[a-z0-9-]{1,64}$`. Redaction is not a way to sneak a real number into a stub send.

Proof command (no network):

```bash
npm run chatbotx:dry-run
```

`scripts/chatbotx-escalation-dry-run.ts` prints the envelope for **ZZ Test Customer** / `zz-test-contact` only.

### Request body

```json
{
  "mode": "dry-run",
  "reason": "manual",
  "ticket": {
    "id": "zz-ticket-b3",
    "title": "ZZ escalation fixture",
    "description": "",
    "status": "open",
    "priority": "high",
    "conversation": {
      "id": "zz-conversation-b3",
      "channel": "whatsapp",
      "status": "escalated",
      "customerName": "ZZ Test Customer",
      "customerContact": "zz-test-contact"
    }
  }
}
```

Or `{ "ticketId": "<existing owly ticket id>", "reason": "sla_breach" }`. An inline `ticket` wins when both are present, so a dry-run does not need the database. `ticketId` loads the row and does not write it back.

## Auth hooks

Inbound (this route):

| Mechanism | Detail |
| --- | --- |
| Cookie | `owly-token` JWT, same as the dashboard. Enforced again in `src/middleware.ts`. |
| API key | `X-API-Key`, looked up by `requireAuth`. |
| Permission | `tickets:read` (viewer and above). |
| Not public | The path is not on the middleware public list and is not treated as a channel webhook. |

Outbound (stub POST only):

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-Owly-ChatbotX-Signature` | Hex HMAC-SHA256 of the **raw** body. |
| `X-Owly-ChatbotX-Key-Id` | `CHATBOTX_BRIDGE_KEY_ID`, example default `example-chatbotx-bridge`. |
| `X-Owly-ChatbotX-Timestamp` | Same `timestamp` field as the body. |
| `User-Agent` | `Owly-ChatbotX-Bridge/0.1 (stub; no-whatsapp)` |

The HMAC key is `CHATBOTX_BRIDGE_SECRET`. ChatbotX should recompute the hex digest over the raw body and reject mismatches. The secret is server-only.

Example values live in `.env.example` only:

```
CHATBOTX_BRIDGE_MODE="dry-run"
CHATBOTX_BRIDGE_URL="http://127.0.0.1:9/chatbotx/escalations"
CHATBOTX_BRIDGE_SECRET="example-only-not-a-real-secret"
CHATBOTX_BRIDGE_KEY_ID="example-chatbotx-bridge"
```

`NEXT_PUBLIC_APP_URL` stays the existing localhost example. Do not put the bridge secret in any `NEXT_PUBLIC_` variable. This spike adds no new `NEXT_PUBLIC_` key.

A requested `mode: "stub"` is ignored unless `CHATBOTX_BRIDGE_MODE=stub` as well. The response then has `stubIgnored: true` and `posted: false`.

Stub POST extra gates:

- URL host must be `localhost`, `127.0.0.1`, or `::1`. No userinfo. `http` or `https` only.
- Secret must be non-empty. Unsigned stub posts are refused.
- Customer must be a ZZ fixture, as above.
- One attempt, 5s timeout, no retry. Non-2xx becomes HTTP 502 from this route. The upstream body is not copied back.

## What stays isolated from live 10X

- Code lives only on this Owly fork. There is no 10X package, base URL, database, or deploy step in the change.
- The stub URL allow-list is loopback. A live 10X host fails `STUB_URL` before `fetch`.
- Default mode does not call `fetch`.
- No WhatsApp connect, QR, or send. No Twilio, SMTP, or campaign send was added.
- No Prisma migration and no writes from the new route.
- Existing ticket, conversation, channel, and webhook handlers are untouched, so current Owly flows keep their current behavior.
- Dry-run and tests use ZZ names only (`ZZ Test Customer`, `ZZ Spike Agent`, `ZZ Test Desk`, `zz-test-contact`).

## Files

| File | Role |
| --- | --- |
| `src/lib/chatbotx/ticket-adapter.ts` | Ticket view, ZZ checks, payload builder |
| `src/lib/chatbotx/escalation-webhook.ts` | HMAC, dry-run, loopback stub POST |
| `src/app/api/integrations/chatbotx/escalate/route.ts` | Auth’d handler |
| `scripts/chatbotx-escalation-dry-run.ts` | Local proof printout |
| `tests/unit/chatbotx-escalation.test.ts` | Adapter and poster |
| `tests/api/chatbotx-escalate.test.ts` | Route |

## Later ChatbotX PR (not this change)

ChatbotX would add a receiver that checks `X-Owly-ChatbotX-Signature`, stores the ticket id, and links an agent thread. Owly would then, in a separate change, call `deliverEscalation` from the escalation sites listed above. That call should stay dry-run until both sides agree on a non-production URL and a real secret outside this example file.

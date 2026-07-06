import type { DragClient } from "../api/client.js";
import type { WhatsAppTemplate, WhatsAppTemplatesResponse } from "../api/types.js";
import { shapeWhatsappTemplate } from "../api/shaping.js";

export const whatsappTools = [
  {
    name: "get_whatsapp_conversation",
    description:
      "Get the full message history of a WhatsApp conversation (card) on a WhatsApp board. Returns the chat messages in order. Use the cardId returned by list_threads / search_threads on a WhatsApp board (the `cardId` field).",
    inputSchema: {
      type: "object" as const,
      properties: {
        cardId: {
          type: "string",
          description:
            "The WhatsApp card ID (whatsappCardId), formatted '<id>-<phoneNumber>'. Get it from list_threads or search_threads on a WhatsApp board.",
        },
      },
      required: ["cardId"],
    },
  },
  {
    name: "list_whatsapp_templates",
    description:
      "List the pre-approved WhatsApp message templates available on a WhatsApp board. Returns each template's name, language, status, category, body text, and how many {{n}} variables it expects. Only APPROVED templates can be sent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: { type: "number", description: "The WhatsApp board ID" },
        limit: {
          type: "number",
          description: "Maximum templates to return (default: 50)",
        },
      },
      required: ["boardId"],
    },
  },
  {
    name: "send_whatsapp_message",
    description:
      "Send a free-text WhatsApp message into an existing conversation. Note: WhatsApp only allows free-text messages inside the 24-hour customer service window; outside it, use send_whatsapp_template instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cardId: {
          type: "string",
          description:
            "The WhatsApp card ID (whatsappCardId) of the conversation to reply to.",
        },
        text: { type: "string", description: "The message text to send" },
        boardId: {
          type: "number",
          description: "Board ID. Auto-resolved from the card when omitted.",
        },
        columnId: {
          type: "string",
          description:
            "Column ID the card is in. Auto-resolved from the card when omitted.",
        },
      },
      required: ["cardId", "text"],
    },
  },
  {
    name: "send_whatsapp_template",
    description:
      "Send a pre-approved WhatsApp template message into a conversation. Use this to reach a contact outside the 24-hour window. Call list_whatsapp_templates first to get the exact template name and language, and to see how many {{n}} variables it needs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cardId: {
          type: "string",
          description:
            "The WhatsApp card ID (whatsappCardId) of the conversation to send to.",
        },
        templateName: {
          type: "string",
          description:
            "The exact template name (e.g. 'french'). Get it from list_whatsapp_templates.",
        },
        languageCode: {
          type: "string",
          description:
            "Template language code (e.g. 'fr', 'en_US'). Required only when a board has multiple templates sharing the same name; otherwise auto-resolved.",
        },
        bodyParameters: {
          type: "array",
          items: { type: "string" },
          description:
            "Values to fill the template's {{1}}, {{2}}… BODY variables, in order. Required when the template has variables.",
        },
        components: {
          type: "array",
          items: { type: "object" },
          description:
            "Advanced: a fully-formed WhatsApp components array (for templates with media headers or buttons). Overrides bodyParameters when provided.",
        },
        boardId: {
          type: "number",
          description: "Board ID. Auto-resolved from the card when omitted.",
        },
        columnId: {
          type: "string",
          description:
            "Column ID the card is in. Auto-resolved from the card when omitted.",
        },
      },
      required: ["cardId", "templateName"],
    },
  },
];

interface WhatsappDetailResponse {
  BoardId?: number;
  ColumnId?: string;
}

interface ResolvedCard {
  cardId: string;
  to: string;
  boardId: number;
  columnId: string;
}

/**
 * The templates endpoint returns `{ data: [...], paging }`. Depending on
 * whether the client unwrapped a v2 envelope, the array may sit at the top
 * level or one level down — handle both.
 */
function extractTemplates(
  raw: WhatsAppTemplatesResponse | WhatsAppTemplate[] | null | undefined,
): WhatsAppTemplate[] {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.data)) return raw.data;
  return [];
}

async function fetchTemplates(
  client: DragClient,
  boardId: number,
  limit: number,
): Promise<WhatsAppTemplate[]> {
  const raw = await client.get<WhatsAppTemplatesResponse | WhatsAppTemplate[]>(
    "/v2/whatsapp/fetch-whatsapp-templates",
    { boardId, limit },
  );
  return extractTemplates(raw);
}

/**
 * Resolve the three values /whatsapp/send-message needs from a card ID.
 * `to` is the phone number embedded in the entity ID ("<id>-<phone>"),
 * mirroring the extension's `entityId.split("-")[1]`. boardId/columnId are
 * taken from the args when present, else looked up via the detail-page
 * endpoint (entityType "3" = WhatsApp).
 */
async function resolveCard(
  client: DragClient,
  args: Record<string, unknown>,
): Promise<ResolvedCard> {
  const cardId = String(args.cardId);
  const to = cardId.split("-")[1];
  if (!to) {
    throw new Error(
      `cardId "${cardId}" is not a WhatsApp card ID — expected the "<id>-<phoneNumber>" format from list_threads.`,
    );
  }

  let boardId = args.boardId as number | undefined;
  let columnId = args.columnId as string | undefined;

  if (boardId === undefined || columnId === undefined) {
    const detail = await client.get<WhatsappDetailResponse>(
      "/v1.18/entityConversation/detail-page",
      { entityId: cardId, entityType: "3", skipUpdateReadStatus: "true" },
    );
    if (boardId === undefined) boardId = detail.BoardId;
    if (columnId === undefined) columnId = detail.ColumnId;
  }

  if (boardId === undefined) {
    throw new Error(
      "Could not resolve the card's boardId; pass boardId explicitly.",
    );
  }
  if (columnId === undefined) {
    throw new Error(
      "Could not resolve the card's columnId; pass columnId explicitly.",
    );
  }

  return { cardId, to, boardId, columnId };
}

export async function handleWhatsappTool(
  client: DragClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_whatsapp_conversation": {
      // v2 wrapped response — client unwraps to the `data` payload.
      return client.get("/v2/whatsapp/get-conversation", {
        whatsappCardId: String(args.cardId),
      });
    }
    case "list_whatsapp_templates": {
      const templates = await fetchTemplates(
        client,
        args.boardId as number,
        (args.limit as number | undefined) ?? 50,
      );
      return { templates: templates.map(shapeWhatsappTemplate) };
    }
    case "send_whatsapp_message": {
      const text = args.text as string;
      if (!text || text.trim() === "") {
        throw new Error("text must not be empty");
      }
      const card = await resolveCard(client, args);
      return client.post("/v2/whatsapp/send-message", {
        boardId: card.boardId,
        columnId: card.columnId,
        to: card.to,
        msgType: "text",
        recipientType: "individual",
        messagePayload: {
          type: "text",
          text: { preview_url: false, body: text },
        },
      });
    }
    case "send_whatsapp_template": {
      const templateName = args.templateName as string;
      if (!templateName) {
        throw new Error("templateName is required");
      }

      // Fetch the board's templates so we can resolve the language and
      // validate the variable count before sending.
      const card = await resolveCard(client, args);
      const all = await fetchTemplates(client, card.boardId, 250);
      const languageCode = args.languageCode as string | undefined;
      const matches = all.filter(
        (t) =>
          t.name === templateName &&
          (languageCode === undefined || t.language === languageCode),
      );

      if (matches.length === 0) {
        const available = all.map((t) => `${t.name} (${t.language})`).join(", ");
        throw new Error(
          `No WhatsApp template named "${templateName}"${
            languageCode ? ` in language "${languageCode}"` : ""
          } on board ${card.boardId}. Available: ${available || "none"}.`,
        );
      }
      if (matches.length > 1) {
        const langs = matches.map((t) => t.language).join(", ");
        throw new Error(
          `Multiple templates named "${templateName}" exist (languages: ${langs}). Pass languageCode to disambiguate.`,
        );
      }

      const template = matches[0];
      if (template.status !== "APPROVED") {
        throw new Error(
          `Template "${templateName}" is ${template.status}, not APPROVED — WhatsApp will reject it.`,
        );
      }

      // Build the send `components`. A fully-formed array can be passed
      // directly; otherwise fill the BODY {{n}} variables from bodyParameters.
      const shaped = shapeWhatsappTemplate(template);
      let components: unknown[];
      if (Array.isArray(args.components)) {
        components = args.components as unknown[];
      } else {
        const bodyParameters = (args.bodyParameters as string[] | undefined) ?? [];
        if (shaped.variableCount > 0 && bodyParameters.length === 0) {
          throw new Error(
            `Template "${templateName}" has ${shaped.variableCount} variable(s) — pass bodyParameters with ${shaped.variableCount} value(s).`,
          );
        }
        components =
          bodyParameters.length > 0
            ? [
                {
                  type: "BODY",
                  parameters: bodyParameters.map((text) => ({
                    type: "TEXT",
                    text,
                  })),
                },
              ]
            : [];
      }

      return client.post("/v2/whatsapp/send-message", {
        boardId: card.boardId,
        columnId: card.columnId,
        to: card.to,
        msgType: "template",
        recipientType: "individual",
        messagePayload: {
          type: "template",
          template: {
            name: template.name,
            language: { code: template.language },
            components,
          },
        },
      });
    }
    default:
      throw new Error(`Unknown WhatsApp tool: ${name}`);
  }
}

import type { DragClient } from "../api/client.js";
import { findField, listFieldDefinitions, setCardField } from "../api/customFields.js";
import { resolveCardBoard } from "./cards.js";

export const customFieldTools = [
  {
    name: "list_custom_fields",
    title: "List custom fields",
    annotations: { title: "List custom fields", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description:
      "List the custom fields a board defines for its cards (e.g. Order number, Priority, Amount): each field's id, name, type and, for dropdown and radio fields, the allowed options. A card's own values are returned by get_card and in card listings. Custom fields are a Plus-plan feature.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: { type: "number", description: "The board ID" },
      },
      required: ["boardId"],
    },
  },
  {
    name: "set_custom_field",
    title: "Set a custom field",
    annotations: { title: "Set a custom field", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description:
      "Set (or clear) one custom field on a card: an email thread or a task. Name the field by its name or id from list_custom_fields. Values by type: text, email and id fields take text; number fields a number; dropdown and radio fields one of their options; phone and currency fields a value plus a two-letter country code (country). Pass clear: true to empty the field.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cardId: {
          type: "string",
          description: "The card: an email thread's `threadId` or a task's numeric `cardId`.",
        },
        boardId: { type: "number", description: "Optional. The card's board; looked up from the card when omitted." },
        field: { type: "string", description: "The field's name or id, from list_custom_fields." },
        value: {
          oneOf: [{ type: "string" }, { type: "number" }],
          description: "The new value. Not needed with clear: true.",
        },
        country: {
          type: "string",
          description: "Phone and currency fields only: two-letter country code (e.g. GB, US, BR). Defaults to the field's own default when it has one.",
        },
        clear: { type: "boolean", description: "Optional. true empties the field." },
      },
      required: ["cardId", "field"],
    },
  },
];

export async function handleCustomFieldTool(
  client: DragClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "list_custom_fields":
      return listFieldDefinitions(client, Number(args.boardId));
    case "set_custom_field": {
      const cardId = String(args.cardId);
      const boardId = await resolveCardBoard(client, cardId, args.boardId as number | undefined);
      const fields = await listFieldDefinitions(client, boardId);
      const field = findField(fields, args.field as string | number);
      const result = await setCardField(client, boardId, cardId, field, {
        value: args.value,
        country: args.country as string | undefined,
        clear: args.clear === true,
      });
      return { cardId, boardId, ...result };
    }
    default:
      throw new Error(`Unknown custom field tool: ${name}`);
  }
}

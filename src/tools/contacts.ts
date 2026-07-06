import type { DragClient } from "../api/client.js";
import type { ContactsResponse, ContactConversationsResponse } from "../api/types.js";
import { shapeContact, shapeContactConversation } from "../api/shaping.js";

export const contactTools = [
  {
    name: "search_contacts",
    description:
      "Search for contacts by name or email. The search text must not be empty. Returns matching contact records with name, email, phone, and domain.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query — matches against name and email (must not be empty)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_contact_conversations",
    description:
      "Get all email conversations involving a specific contact. Returns thread subjects, dates, and preview text. Use search_contacts first to find the contact ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        contactId: {
          type: "number",
          description: "The numeric contact ID (use search_contacts to find it — do not pass an email address)",
        },
      },
      required: ["contactId"],
    },
  },
  {
    name: "create_contact",
    description:
      "Create a new contact record in DragApp with name, email, and optional phone and note.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Contact name",
        },
        email: {
          type: "string",
          description: "Contact email address",
        },
        phone: {
          type: "string",
          description: "Phone number",
        },
        note: {
          type: "string",
          description: "Note about the contact",
        },
      },
      required: ["name", "email"],
    },
  },
];

export async function handleContactTool(
  client: DragClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "search_contacts": {
      const searchText = ((args.query ?? args.searchText) as string);
      if (!searchText || searchText.trim() === "") {
        throw new Error("query must not be empty");
      }
      // v2 returns paginated: { rows, totalRecords, currentPage, totalPages }
      // The v2 client unwraps the outer { data } wrapper, so we get the inner object
      const response = await client.get<ContactsResponse>("/v2/contact/list", {
        searchText,
      });
      return {
        contacts: response.rows.map(shapeContact),
        totalRecords: response.totalRecords,
        currentPage: response.currentPage,
        totalPages: response.totalPages,
      };
    }
    case "get_contact_conversations": {
      const response = await client.get<ContactConversationsResponse>(
        "/v2/contact/get-conversations",
        { contactId: args.contactId as number },
      );
      const conversations = response.rows ?? [];
      return {
        conversations: conversations.map(shapeContactConversation),
        totalRecords: response.totalRecords,
        currentPage: response.currentPage,
        totalPages: response.totalPages,
      };
    }
    case "create_contact": {
      // Backend Create reads `req.body.data` and expects a non-empty array
      // of contact objects (it's a batch endpoint). A single contact must be
      // wrapped — sending the flat object returns "data should be a non-empty array".
      const contact: Record<string, unknown> = {
        Name: args.name,
        Email: args.email,
      };
      if (args.phone) contact.Phone = args.phone;
      if (args.note) contact.Note = args.note;

      return client.post("/v2/contact/create", { data: [contact] });
    }
    default:
      throw new Error(`Unknown contact tool: ${name}`);
  }
}

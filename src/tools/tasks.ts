import type { DragClient } from "../api/client.js";
import { encodeTitleForCreate, isoToBackendDueDate } from "../utils/encoding.js";

interface CreateTaskResponse {
  taskId?: number;
  data?: { taskId?: number };
  Response?: { taskId?: number };
}

function extractTaskId(response: unknown): number | undefined {
  if (!response || typeof response !== "object") return undefined;
  const r = response as CreateTaskResponse;
  return r.taskId ?? r.data?.taskId ?? r.Response?.taskId;
}

export const taskTools = [
  {
    name: "create_task",
    description:
      "Create a standalone task in DragApp. Tasks are lightweight to-do items that can be assigned, given a due date, and tracked on a board.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: {
          type: "number",
          description: "The board to create the task on",
        },
        columnId: {
          type: "string",
          description: "Column ID to place the task in, e.g. 'Label_1'",
        },
        title: {
          type: "string",
          description: "Task title",
        },
        assignee: {
          type: "string",
          description: "Email address of the assignee",
        },
        note: {
          type: "string",
          description: "Initial note attached to the task",
        },
        comment: {
          type: "string",
          description: "Initial comment attached to the task",
        },
        dueDate: {
          type: "string",
          description: "Due date in ISO-8601 format (e.g. 2026-05-20T00:00:00.000Z). Saved via a separate call after the task is created.",
        },
      },
      required: ["boardId", "columnId", "title"],
    },
  },
];

export async function handleTaskTool(
  client: DragClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "create_task": {
      // Backend SaveTask base64-decodes taskName for activity logs and stores
      // the raw (base64) string in the DB. Pre-encode here to match the
      // extension's specialEncoder (btoa(unescape(encodeURIComponent(s)))).
      const body: Record<string, unknown> = {
        boardId: args.boardId,
        columnId: args.columnId,
        taskName: encodeTitleForCreate(args.title as string),
      };
      if (args.assignee) body.assignee = args.assignee;
      if (args.note) body.note = args.note;
      if (args.comment) body.comment = args.comment;

      const createResponse = await client.post<CreateTaskResponse>(
        "/v1.18/task/create",
        body,
      );
      const taskId = extractTaskId(createResponse);

      // /v1.18/task/create's schema rejects dueDate. Persist it via the
      // dedicated SaveDueDate endpoint after the task exists.
      if (args.dueDate && taskId) {
        try {
          await client.post("/v1.18/checklistComment/SaveDueDate", {
            entityId: String(taskId),
            entityType: "1",
            DueDate: isoToBackendDueDate(args.dueDate as string),
          });
        } catch (err) {
          return {
            ...createResponse,
            dueDateError: err instanceof Error ? err.message : String(err),
          };
        }
      }

      return createResponse;
    }
    default:
      throw new Error(`Unknown task tool: ${name}`);
  }
}

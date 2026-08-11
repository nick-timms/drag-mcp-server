import type { DragClient } from "../api/client.js";
import { DragApiError } from "../api/client.js";
import {
  shapeActivityEvent,
  shapeResponseTimeEvent,
  shapeClosedEvent,
} from "../api/shaping.js";

export const analyticsTools = [
  {
    name: "get_response_times",
    title: "Get response times",
    annotations: { title: "Get response times", readOnlyHint: true },
    description:
      "List individual first-response events for a board over a date range. Every event is a first response to a new email; use get_avg_response_time if you also need follow-up replies. Each event gives intervalTime in milliseconds, the responder, and the thread. Returns raw events, not computed metrics.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: {
          type: "number",
          description: "The board ID",
        },
        dateFrom: {
          type: "string",
          description: "Start date for the period (ISO-8601)",
        },
        dateTo: {
          type: "string",
          description: "End date for the period (ISO-8601)",
        },
      },
      required: ["boardId", "dateFrom", "dateTo"],
    },
  },
  {
    name: "get_avg_response_time",
    title: "Get average response time",
    annotations: { title: "Get average response time", readOnlyHint: true },
    description:
      "List individual reply events on a board over a date range, covering follow-up replies as well as first responses. Each event gives intervalTime in milliseconds, the responder, and the thread; firstResponse is true on first responses and absent on follow-ups. Returns raw events, not a computed average.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: {
          type: "number",
          description: "The board ID",
        },
        dateFrom: {
          type: "string",
          description: "Start date for the period (ISO-8601)",
        },
        dateTo: {
          type: "string",
          description: "End date for the period (ISO-8601)",
        },
      },
      required: ["boardId", "dateFrom", "dateTo"],
    },
  },
  {
    name: "get_daily_activity",
    title: "Get daily activity",
    annotations: { title: "Get daily activity", readOnlyHint: true },
    description:
      "List individual emails received on a board over a date range, each with its creation timestamp. Returns raw records, not per-day counts. Narrow the date range on busy boards.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: {
          type: "number",
          description: "The board ID",
        },
        dateFrom: {
          type: "string",
          description: "Start date for the period (ISO-8601)",
        },
        dateTo: {
          type: "string",
          description: "End date for the period (ISO-8601)",
        },
      },
      required: ["boardId", "dateFrom", "dateTo"],
    },
  },
  {
    name: "get_closed_activity",
    title: "Get closed-thread activity",
    annotations: { title: "Get closed-thread activity", readOnlyHint: true },
    description:
      "List individual thread-close events for a board over a date range. Each event gives openedAt, closedAt, intervalTime in milliseconds, and who closed it. Returns raw events, not per-day counts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: {
          type: "number",
          description: "The board ID",
        },
        dateFrom: {
          type: "string",
          description: "Start date for the period (ISO-8601)",
        },
        dateTo: {
          type: "string",
          description: "End date for the period (ISO-8601)",
        },
      },
      required: ["boardId", "dateFrom", "dateTo"],
    },
  },
];

async function analyticsRequest(
  client: DragClient,
  path: string,
  args: Record<string, unknown>,
  shaper: (event: Record<string, unknown>) => unknown,
): Promise<unknown> {
  try {
    const startDate = Math.floor(new Date(args.dateFrom as string).getTime() / 1000);
    const endDate = Math.floor(new Date(args.dateTo as string).getTime() / 1000);
    const events = await client.post<unknown>(path, {
      boardIds: JSON.stringify([args.boardId]),
      startDate,
      endDate,
    });
    return Array.isArray(events)
      ? events.map((e) => shaper(e as Record<string, unknown>))
      : events;
  } catch (err) {
    if (err instanceof DragApiError && (err.code === 402 || err.code === 403)) {
      throw new DragApiError(
        "Analytics requires a paid DragApp plan.",
        402,
      );
    }
    throw err;
  }
}

export async function handleAnalyticsTool(
  client: DragClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_response_times":
      return analyticsRequest(
        client,
        "/v1.18/activityLog/notification/getFirstResponseTime/new-temp",
        args,
        shapeResponseTimeEvent,
      );
    case "get_avg_response_time":
      return analyticsRequest(
        client,
        "/v1.18/activityLog/notification/getAverageResponseTime/new-temp",
        args,
        shapeResponseTimeEvent,
      );
    case "get_daily_activity":
      return analyticsRequest(
        client,
        "/v1.18/activityLog/notification/getDailyHistoricalActivity/new",
        args,
        shapeActivityEvent,
      );
    case "get_closed_activity":
      return analyticsRequest(
        client,
        "/v1.18/activityLog/notification/getClosedActivity-temp",
        args,
        shapeClosedEvent,
      );
    default:
      throw new Error(`Unknown analytics tool: ${name}`);
  }
}

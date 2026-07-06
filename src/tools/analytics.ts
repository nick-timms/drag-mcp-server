import type { DragClient } from "../api/client.js";
import { DragApiError } from "../api/client.js";

export const analyticsTools = [
  {
    name: "get_response_times",
    description:
      "Get first response time metrics for a board. Shows how quickly the team responds to new emails. Useful for SLA monitoring and performance reviews.",
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
    description:
      "Get average response time across all replies on a board for a given period. Complements get_response_times which shows first response only.",
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
    description:
      "Get daily email activity counts for a board over a time period. Returns per-day counts useful for volume trends and workload analysis.",
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
    description:
      "Get the count of closed/resolved threads per day for a board. Useful for tracking team throughput and resolution rates.",
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
): Promise<unknown> {
  try {
    const startDate = Math.floor(new Date(args.dateFrom as string).getTime() / 1000);
    const endDate = Math.floor(new Date(args.dateTo as string).getTime() / 1000);
    return await client.post(path, {
      boardIds: JSON.stringify([args.boardId]),
      startDate,
      endDate,
    });
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
      );
    case "get_avg_response_time":
      return analyticsRequest(
        client,
        "/v1.18/activityLog/notification/getAverageResponseTime/new-temp",
        args,
      );
    case "get_daily_activity":
      return analyticsRequest(
        client,
        "/v1.18/activityLog/notification/getDailyHistoricalActivity/new",
        args,
      );
    case "get_closed_activity":
      return analyticsRequest(
        client,
        "/v1.18/activityLog/notification/getClosedActivity-temp",
        args,
      );
    default:
      throw new Error(`Unknown analytics tool: ${name}`);
  }
}

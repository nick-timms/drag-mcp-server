import type { DragClient } from "../api/client.js";
import type { V1Board, Board, OrderedBoardsResponse } from "../api/types.js";
import { shapeV1Board, shapeBoard, shapeV1Column } from "../api/shaping.js";

export const boardTools = [
  {
    name: "list_boards",
    description:
      "List all DragApp boards the user has access to. Returns board name, owner, unread count, and contributor info.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_board",
    description:
      "Get details of a specific DragApp board by ID. Returns board name, owner, and members.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: {
          type: "number",
          description: "The board ID",
        },
      },
      required: ["boardId"],
    },
  },
  {
    name: "list_columns",
    description:
      "List all columns (stages) on a DragApp board. Columns represent workflow stages like To Do, In Progress, Done. Returns label-style IDs (e.g. \"Label_1\") used by list_threads, filter_threads, and move_thread.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: {
          type: "number",
          description: "The board ID",
        },
      },
      required: ["boardId"],
    },
  },
  {
    name: "list_board_members",
    description:
      "List all boards with their columns and member info. Returns the main board and secondary boards with columns for each.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_teams",
    description:
      "List all teams the user belongs to. Returns team IDs needed by knowledge base tools (list_articles, get_article, create_article, update_article).",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

export async function handleBoardTool(
  client: DragClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "list_boards": {
      // v1.18 POST returns raw array of V1Board
      const boards = await client.post<V1Board[]>("/v1.18/teamBoard/list");
      return boards.map(shapeV1Board);
    }
    case "get_board": {
      // v2 GET with wrapped response (auto-unwrapped by client)
      const board = await client.get<Board>(`/v2/board/${args.boardId}`);
      const result = shapeBoard(board);
      // v2 often returns empty members — enrich from v1.18 if needed
      if (result.members.length === 0) {
        try {
          const data = await client.get<OrderedBoardsResponse>("/v1.18/teamBoard/boards");
          const allBoards = [data.MainBoard, ...data.SecondaryBoards];
          const match = allBoards.find((b) => b.Id === Number(args.boardId));
          if (match?.ContributorEmails) {
            result.members = match.ContributorEmails.split(",").map((e: string) => e.trim()).filter(Boolean);
          }
        } catch {
          // v1.18 fallback failed — return v2 data without members
        }
      }
      return result;
    }
    case "list_columns": {
      // Use v1.18 endpoint to get label-style IDs (e.g. "Label_1") that are
      // compatible with list_threads, filter_threads, and move_thread.
      const data = await client.get<OrderedBoardsResponse>("/v1.18/teamBoard/boards");
      const columns = data.ColumnsByBoard[String(args.boardId)] ?? [];
      return columns.map(shapeV1Column);
    }
    case "list_board_members": {
      // v1.18 returns { MainBoard, SecondaryBoards, ColumnsByBoard }
      const data = await client.get<OrderedBoardsResponse>("/v1.18/teamBoard/boards");
      const allBoards = [data.MainBoard, ...data.SecondaryBoards];
      return allBoards.map((board) => ({
        ...shapeBoard({
          Id: board.Id,
          Name: board.BoardName,
          Owner: board.BoardOwnerEmail,
          Users: board.ContributorEmails
            ? board.ContributorEmails.split(",").map((e) => e.trim()).filter(Boolean)
            : [],
        }),
        columns: (data.ColumnsByBoard[String(board.Id)] ?? []).map(shapeV1Column),
      }));
    }
    case "list_teams": {
      // v1.18 returns { Response: TeamMember[], Error: boolean, Success: boolean }
      // Each entry is a team *member*, not a team — deduplicate by TeamId
      const data = await client.get<{
        Response: Array<{
          UserId: number; Name: string; Email: string;
          ProfileImage: string | null; TeamId: number;
          IsOwnerId: number; PermissionLevel: string;
        }>;
        Error: boolean; Success: boolean;
      }>("/v1.18/team/list");
      const members = Array.isArray(data.Response) ? data.Response : [];
      const teamMap = new Map<number, {
        id: number; owner: string;
        members: Array<{ userId: number; name: string; email: string; permission: string }>;
      }>();
      for (const m of members) {
        if (!teamMap.has(m.TeamId)) {
          teamMap.set(m.TeamId, { id: m.TeamId, owner: "", members: [] });
        }
        const team = teamMap.get(m.TeamId)!;
        team.members.push({
          userId: m.UserId, name: m.Name,
          email: m.Email, permission: m.PermissionLevel,
        });
        if (m.PermissionLevel === "Administrator") {
          team.owner = m.Email;
        }
      }
      return Array.from(teamMap.values());
    }
    default:
      throw new Error(`Unknown board tool: ${name}`);
  }
}

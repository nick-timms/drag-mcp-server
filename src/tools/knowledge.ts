import type { DragClient } from "../api/client.js";
import type { Article } from "../api/types.js";
import { shapeArticle, shapeArticleCompact } from "../api/shaping.js";
import { stripHtmlToPlain } from "../utils/encoding.js";

export const knowledgeTools = [
  {
    name: "list_articles",
    description:
      "List all knowledge base articles for a team. Returns article titles, categories, and publication status. Use list_teams to find your team ID first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        teamId: {
          type: "number",
          description: "The team ID",
        },
      },
      required: ["teamId"],
    },
  },
  {
    name: "get_article",
    description:
      "Get the full content of a knowledge base article by ID, including title, body, category, and publication status. Use list_teams to find your team ID first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        teamId: {
          type: "number",
          description: "The team ID",
        },
        articleId: {
          type: "number",
          description: "The article ID",
        },
      },
      required: ["teamId", "articleId"],
    },
  },
  {
    name: "create_article",
    description:
      "Create a new knowledge base article. Articles can be categorised and published for team or public access. Use list_teams to find your team ID first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        teamId: {
          type: "number",
          description: "The team ID",
        },
        title: {
          type: "string",
          description: "Article title",
        },
        body: {
          type: "string",
          description: "Article body in HTML",
        },
        categoryId: {
          type: "number",
          description: "Category to file the article under",
        },
      },
      required: ["teamId", "title", "body"],
    },
  },
  {
    name: "update_article",
    description:
      "Update an existing knowledge base article's title, body, or category. Use list_teams to find your team ID first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        teamId: {
          type: "number",
          description: "The team ID",
        },
        articleId: {
          type: "number",
          description: "The article ID to update",
        },
        title: {
          type: "string",
          description: "New article title",
        },
        body: {
          type: "string",
          description: "New article body in HTML",
        },
        categoryId: {
          type: "number",
          description: "New category ID",
        },
      },
      required: ["teamId", "articleId"],
    },
  },
  {
    name: "search_knowledge",
    description:
      "Search a Help Center knowledge base by keyword. teamId, slug, and query are all optional except query — with no teamId or slug, the first team that has a configured Help Center slug is used.",
    inputSchema: {
      type: "object" as const,
      properties: {
        teamId: {
          type: "number",
          description: "Team ID — resolves to the Help Center slug via the team's KB settings. Use list_teams to find your team ID.",
        },
        slug: {
          type: "string",
          description: "Help Center slug (public identifier). Overrides teamId-based resolution.",
        },
        query: {
          type: "string",
          description: "Search query text",
        },
      },
      required: ["query"],
    },
  },
];

interface KBSettingsResponse {
  slug?: string;
  [key: string]: unknown;
}

interface TeamListResponse {
  Response?: Array<{ TeamId: number }>;
}

async function resolveSlugFromTeam(
  client: DragClient,
  teamId: number,
): Promise<string | undefined> {
  try {
    const settings = await client.get<KBSettingsResponse>(
      `/v1.18/knowledge/${teamId}/settings`,
    );
    return settings?.slug;
  } catch {
    return undefined;
  }
}

export async function handleKnowledgeTool(
  client: DragClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "list_articles": {
      const articles = await client.get<Article[]>(
        `/v1.18/knowledge/${args.teamId}/articles`,
      );
      return articles.map(shapeArticleCompact);
    }
    case "get_article": {
      const article = await client.get<Article>(
        `/v1.18/knowledge/${args.teamId}/articles/${args.articleId}`,
      );
      return shapeArticle(article);
    }
    case "create_article": {
      // Backend expects lowercase field names. `content` is the canonical
      // TipTap JSON; the route also accepts an HTML string as a fallback.
      const html = args.body as string;
      const body: Record<string, unknown> = {
        title: args.title,
        content: html,
        contentHtml: html,
        contentPlain: stripHtmlToPlain(html),
      };
      if (args.categoryId) body.categoryId = args.categoryId;

      return client.post(`/v1.18/knowledge/${args.teamId}/articles`, body);
    }
    case "update_article": {
      const body: Record<string, unknown> = {};
      if (args.title) body.title = args.title;
      if (args.body) {
        const html = args.body as string;
        body.content = html;
        body.contentHtml = html;
        body.contentPlain = stripHtmlToPlain(html);
      }
      if (args.categoryId !== undefined) body.categoryId = args.categoryId;

      return client.put(
        `/v1.18/knowledge/${args.teamId}/articles/${args.articleId}`,
        body,
      );
    }
    case "search_knowledge": {
      let slug = args.slug as string | undefined;

      if (!slug && args.teamId) {
        slug = await resolveSlugFromTeam(client, args.teamId as number);
        if (!slug) {
          throw new Error(
            `No Help Center slug is configured for team ${args.teamId}. Set one in Help Center settings, or pass slug directly.`,
          );
        }
      }

      if (!slug) {
        // Last-resort discovery: walk the user's teams and use the first one
        // that has a slug configured. Lets callers run `search_knowledge(query=…)`
        // with no other context.
        const teams = await client.get<TeamListResponse>("/v1.18/team/list");
        const uniqueTeamIds = Array.from(
          new Set((teams.Response ?? []).map((m) => m.TeamId)),
        );
        for (const teamId of uniqueTeamIds) {
          const candidate = await resolveSlugFromTeam(client, teamId);
          if (candidate) {
            slug = candidate;
            break;
          }
        }
        if (!slug) {
          throw new Error(
            "No Help Center slug is configured on any of your teams. Configure one in Help Center settings, or pass slug/teamId explicitly.",
          );
        }
      }
      const results = await client.get<Article[]>(
        `/v1.18/knowledge/public/${slug}/search`,
        { q: args.query as string },
      );
      return results.map(shapeArticleCompact);
    }
    default:
      throw new Error(`Unknown knowledge tool: ${name}`);
  }
}

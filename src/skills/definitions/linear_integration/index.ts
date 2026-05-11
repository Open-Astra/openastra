import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Linear Integration Skill ─────────────────────────────────────────
// Manages issues, projects, and teams in Linear via the GraphQL API.
// Requires LINEAR_API_KEY environment variable.

const LINEAR_API = "https://api.linear.app/graphql";

const LinearParams = z.object({
  operation: z
    .enum([
      "list_issues",
      "get_issue",
      "create_issue",
      "update_issue",
      "list_projects",
      "search_issues",
      "list_teams",
    ])
    .describe("Linear operation to perform"),
  teamId: z.string().optional().describe("Team ID (required for create_issue)"),
  issueId: z.string().optional().describe("Issue ID (for get/update)"),
  title: z.string().optional().describe("Issue title (for create/update)"),
  description: z.string().optional().describe("Issue description (for create/update)"),
  status: z.string().optional().describe("Issue status name (for update, e.g. 'In Progress', 'Done')"),
  priority: z.number().int().min(0).max(4).optional().describe("Priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low"),
  assigneeId: z.string().optional().describe("Assignee user ID (for create/update)"),
  query: z.string().optional().describe("Search query (for search_issues)"),
  projectId: z.string().optional().describe("Project ID to filter issues"),
  first: z.number().int().min(1).max(50).default(25).describe("Number of results to return"),
});

async function linearQuery(apiKey: string, query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  const response = await safeFetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": apiKey,
    },
    body: JSON.stringify({ query, variables }),
    ssrfProtection: false,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Linear API ${response.status}: ${text || response.statusText}`);
  }

  const body = (await response.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new Error(`Linear GraphQL error: ${body.errors.map((e) => e.message).join(", ")}`);
  }
  return body.data;
}

const linearSkill: SkillDefinition = {
  name: "linear_integration",
  version: "1.0.0",

  manifest: {
    id: "linear_integration",
    name: "Linear",
    description: "Manage issues, projects, and teams in Linear. Create, update, search, and list issues via the Linear GraphQL API.",
    category: "execute",
    tools: ["linear_integration"],
    configFields: [
      {
        name: "apiKey",
        type: "string",
        required: true,
        description: "Linear API key",
        envVar: "LINEAR_API_KEY",
      },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "linear_integration",
      description:
        "Manage Linear issues: list, get, create, update, search issues, list projects and teams. Requires LINEAR_API_KEY.",
      parameters: LinearParams,

      async execute(params) {
        const apiKey = process.env.LINEAR_API_KEY;
        if (!apiKey) {
          return { error: "LINEAR_API_KEY environment variable is not set." };
        }

        try {
          switch (params.operation) {
            case "list_teams": {
              const data = (await linearQuery(apiKey, `
                query { teams { nodes { id name key } } }
              `)) as { teams: { nodes: Array<{ id: string; name: string; key: string }> } };
              return { teams: data.teams.nodes };
            }

            case "list_projects": {
              const data = (await linearQuery(apiKey, `
                query($first: Int!) {
                  projects(first: $first) {
                    nodes { id name state startDate targetDate }
                  }
                }
              `, { first: params.first })) as { projects: { nodes: unknown[] } };
              return { projects: data.projects.nodes };
            }

            case "list_issues": {
              const filter: Record<string, unknown> = {};
              if (params.teamId) filter.team = { id: { eq: params.teamId } };
              if (params.projectId) filter.project = { id: { eq: params.projectId } };

              const data = (await linearQuery(apiKey, `
                query($first: Int!, $filter: IssueFilter) {
                  issues(first: $first, filter: $filter, orderBy: updatedAt) {
                    nodes {
                      id identifier title state { name } priority assignee { name }
                      createdAt updatedAt
                    }
                  }
                }
              `, { first: params.first, filter: Object.keys(filter).length ? filter : undefined })) as {
                issues: { nodes: unknown[] };
              };
              return { issues: data.issues.nodes };
            }

            case "get_issue": {
              if (!params.issueId) return { error: "issueId is required for get_issue" };
              const data = (await linearQuery(apiKey, `
                query($id: String!) {
                  issue(id: $id) {
                    id identifier title description state { name }
                    priority assignee { name } project { name }
                    labels { nodes { name } }
                    createdAt updatedAt
                    comments { nodes { body user { name } createdAt } }
                  }
                }
              `, { id: params.issueId })) as { issue: unknown };
              return { issue: data.issue };
            }

            case "create_issue": {
              if (!params.title) return { error: "title is required for create_issue" };
              if (!params.teamId) return { error: "teamId is required for create_issue" };

              const input: Record<string, unknown> = {
                title: params.title,
                teamId: params.teamId,
              };
              if (params.description) input.description = params.description;
              if (params.priority !== undefined) input.priority = params.priority;
              if (params.assigneeId) input.assigneeId = params.assigneeId;
              if (params.projectId) input.projectId = params.projectId;

              const data = (await linearQuery(apiKey, `
                mutation($input: IssueCreateInput!) {
                  issueCreate(input: $input) {
                    success
                    issue { id identifier title url }
                  }
                }
              `, { input })) as { issueCreate: { success: boolean; issue: unknown } };
              return data.issueCreate;
            }

            case "update_issue": {
              if (!params.issueId) return { error: "issueId is required for update_issue" };

              const input: Record<string, unknown> = {};
              if (params.title) input.title = params.title;
              if (params.description) input.description = params.description;
              if (params.priority !== undefined) input.priority = params.priority;
              if (params.assigneeId) input.assigneeId = params.assigneeId;
              if (params.status) input.stateId = params.status; // accepts state ID

              const data = (await linearQuery(apiKey, `
                mutation($id: String!, $input: IssueUpdateInput!) {
                  issueUpdate(id: $id, input: $input) {
                    success
                    issue { id identifier title state { name } }
                  }
                }
              `, { id: params.issueId, input })) as { issueUpdate: { success: boolean; issue: unknown } };
              return data.issueUpdate;
            }

            case "search_issues": {
              if (!params.query) return { error: "query is required for search_issues" };
              const data = (await linearQuery(apiKey, `
                query($query: String!, $first: Int!) {
                  searchIssues(query: $query, first: $first) {
                    nodes {
                      id identifier title state { name } priority
                      assignee { name } updatedAt
                    }
                  }
                }
              `, { query: params.query, first: params.first })) as {
                searchIssues: { nodes: unknown[] };
              };
              return { issues: data.searchIssues.nodes };
            }

            default:
              return { error: `Unknown operation: ${params.operation}` };
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: message };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "linear_integration",
      instructions:
        "You can manage Linear issues using the `linear_integration` tool. " +
        "Operations: list_teams, list_projects, list_issues, get_issue, create_issue, update_issue, search_issues. " +
        "Use list_teams first to get team IDs needed for creating issues.",
    };
  },
};

export default linearSkill;

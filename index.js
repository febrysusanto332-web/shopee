import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config — set these in Render's Environment Variables tab
// Two Threads accounts are supported. "akun_1" and "akun_2" select between them.
// ---------------------------------------------------------------------------
const GRAPH_BASE = "https://graph.threads.net/v1.0";

const ACCOUNTS = {
  akun_1: {
    label: process.env.THREADS_ACCOUNT_1_LABEL || "Akun 1",
    accessToken: process.env.THREADS_ACCESS_TOKEN_1,
    userId: process.env.THREADS_USER_ID_1,
  },
  akun_2: {
    label: process.env.THREADS_ACCOUNT_2_LABEL || "Akun 2",
    accessToken: process.env.THREADS_ACCESS_TOKEN_2,
    userId: process.env.THREADS_USER_ID_2,
  },
};

for (const [key, acc] of Object.entries(ACCOUNTS)) {
  if (!acc.accessToken || !acc.userId) {
    console.warn(
      `[WARN] Credentials for ${key} (${acc.label}) are incomplete. ` +
        `Set THREADS_ACCESS_TOKEN_${key === "akun_1" ? "1" : "2"} and ` +
        `THREADS_USER_ID_${key === "akun_1" ? "1" : "2"} in Render's Environment Variables.`
    );
  }
}

function getAccount(accountKey) {
  const acc = ACCOUNTS[accountKey];
  if (!acc) throw new Error(`Unknown account "${accountKey}". Use "akun_1" or "akun_2".`);
  if (!acc.accessToken || !acc.userId) {
    throw new Error(`Account "${accountKey}" (${acc.label}) is not configured with credentials yet.`);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Small helper for calling the Threads Graph API
// ---------------------------------------------------------------------------
async function threadsFetch(accessToken, path, { method = "GET", params = {}, body } = {}) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  url.searchParams.set("access_token", accessToken ?? "");

  const res = await fetch(url.toString(), {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Threads API error (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

const accountField = z
  .enum(["akun_1", "akun_2"])
  .default("akun_1")
  .describe("Akun Threads mana yang dipakai: 'akun_1' atau 'akun_2'");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------
function createServer() {
  const server = new McpServer({ name: "threads-mcp", version: "1.0.0" });

  server.registerTool(
    "list_accounts",
    {
      title: "List configured Threads accounts",
      description:
        "Show which Threads accounts are configured on this server (their label and username), so you know what to pass as 'account' to other tools.",
      inputSchema: {},
    },
    async () => {
      const results = [];
      for (const [key, acc] of Object.entries(ACCOUNTS)) {
        if (!acc.accessToken || !acc.userId) {
          results.push({ key, label: acc.label, status: "not configured" });
          continue;
        }
        try {
          const me = await threadsFetch(acc.accessToken, "/me", {
            params: { fields: "id,username" },
          });
          results.push({ key, label: acc.label, username: me.username, id: me.id, status: "ok" });
        } catch (err) {
          results.push({ key, label: acc.label, status: "error", error: String(err.message || err) });
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.registerTool(
    "get_profile_info",
    {
      title: "Get Threads profile info",
      description: "Fetch profile info (username, bio, follower count, profile picture) for a configured account.",
      inputSchema: {
        account: accountField,
      },
    },
    async ({ account }) => {
      const { accessToken } = getAccount(account);
      const data = await threadsFetch(accessToken, "/me", {
        params: {
          fields: "id,username,name,threads_biography,threads_profile_picture_url",
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "post_thread",
    {
      title: "Post to Threads",
      description:
        "Create and publish a new post on Threads. Supports plain text, or text with a single image URL.",
      inputSchema: {
        account: accountField,
        text: z.string().min(1).describe("The text content of the post"),
        image_url: z
          .string()
          .url()
          .optional()
          .describe("Optional public URL of an image to attach to the post"),
      },
    },
    async ({ account, text, image_url }) => {
      const { accessToken, userId, label } = getAccount(account);
      const container = await threadsFetch(accessToken, `/${userId}/threads`, {
        method: "POST",
        body: {
          media_type: image_url ? "IMAGE" : "TEXT",
          text,
          ...(image_url ? { image_url } : {}),
        },
      });

      // Threads recommends a short delay before publishing a created container
      await sleep(2000);

      const published = await threadsFetch(accessToken, `/${userId}/threads_publish`, {
        method: "POST",
        body: { creation_id: container.id },
      });

      return {
        content: [
          { type: "text", text: `[${label}] Post published successfully. Post ID: ${published.id}` },
        ],
      };
    }
  );

  server.registerTool(
    "get_my_posts",
    {
      title: "Get my Threads posts",
      description: "Fetch recent posts from the connected Threads account.",
      inputSchema: {
        account: accountField,
        limit: z.number().int().min(1).max(50).default(10).describe("Number of posts to fetch"),
      },
    },
    async ({ account, limit }) => {
      const { accessToken, userId } = getAccount(account);
      const data = await threadsFetch(accessToken, `/${userId}/threads`, {
        params: { fields: "id,text,timestamp,permalink,media_type", limit },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "get_full_thread",
    {
      title: "Get a full self-reply thread chain",
      description:
        "Walk a chain of self-replies (a thread where the author keeps replying to their own previous post, e.g. '1/20', '2/20', ...) starting from the first post, and return all parts concatenated in order. Use this for long storytelling threads split into numbered parts.",
      inputSchema: {
        account: accountField,
        post_id: z.string().min(1).describe("The ID of the FIRST post in the thread"),
        max_parts: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(30)
          .describe("Safety limit on how many parts to follow"),
      },
    },
    async ({ account, post_id, max_parts }) => {
      const { accessToken } = getAccount(account);

      const parts = [];
      let currentId = post_id;
      let authorUsername = null;

      for (let i = 0; i < max_parts; i++) {
        const detail = await threadsFetch(accessToken, `/${currentId}`, {
          params: { fields: "id,text,timestamp,username" },
        });
        parts.push({ id: detail.id, username: detail.username, text: detail.text });
        if (!authorUsername) authorUsername = detail.username;

        const repliesData = await threadsFetch(accessToken, `/${currentId}/replies`, {
          params: { fields: "id,text,timestamp,username" },
        });
        const replies = (repliesData.data || [])
          .filter((r) => r.username === authorUsername)
          .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        if (replies.length === 0) break;
        currentId = replies[0].id;
      }

      const combined = parts
        .map((p, idx) => `--- Bagian ${idx + 1}/${parts.length} (ID: ${p.id}) ---\n${p.text}`)
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Total ${parts.length} bagian ditemukan.\n\n${combined}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_post_detail",
    {
      title: "Get full detail of a single post",
      description:
        "Fetch the FULL, untruncated text and details of a single Threads post by its ID. Use this when get_my_posts returns truncated text.",
      inputSchema: {
        account: accountField,
        post_id: z.string().min(1).describe("The Threads post/media ID"),
      },
    },
    async ({ account, post_id }) => {
      const { accessToken } = getAccount(account);
      const data = await threadsFetch(accessToken, `/${post_id}`, {
        params: { fields: "id,text,timestamp,permalink,media_type,username" },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "get_post_insights",
    {
      title: "Get post insights",
      description:
        "Fetch performance metrics (views, likes, replies, reposts, quotes) for a specific post.",
      inputSchema: {
        account: accountField,
        post_id: z.string().min(1).describe("The Threads post/media ID"),
      },
    },
    async ({ account, post_id }) => {
      const { accessToken } = getAccount(account);
      const data = await threadsFetch(accessToken, `/${post_id}/insights`, {
        params: { metric: "views,likes,replies,reposts,quotes" },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "get_replies",
    {
      title: "Get replies to a post",
      description:
        "Fetch replies/comments on a specific Threads post. Supports pagination — if there are more replies, the response includes a 'next_cursor' you can pass back in to get the next page.",
      inputSchema: {
        account: accountField,
        post_id: z.string().min(1).describe("The Threads post/media ID"),
        after: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous call's next_cursor, to fetch the next page"),
      },
    },
    async ({ account, post_id, after }) => {
      const { accessToken } = getAccount(account);
      const data = await threadsFetch(accessToken, `/${post_id}/replies`, {
        params: {
          fields: "id,text,username,timestamp",
          ...(after ? { after } : {}),
        },
      });

      const nextCursor = data.paging?.cursors?.after || null;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                replies: data.data || [],
                next_cursor: nextCursor,
                has_more: Boolean(nextCursor),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "delete_post",
    {
      title: "Delete a Threads post or reply",
      description:
        "Permanently delete a post or reply on Threads by its ID. Requires the threads_delete permission to be enabled on the Meta App — if this fails with a permission error, that permission needs to be added in the Meta App dashboard first.",
      inputSchema: {
        account: accountField,
        post_id: z.string().min(1).describe("The ID of the post/reply to delete"),
      },
    },
    async ({ account, post_id }) => {
      const { accessToken } = getAccount(account);
      const data = await threadsFetch(accessToken, `/${post_id}`, {
        method: "DELETE",
      });
      return {
        content: [
          {
            type: "text",
            text: `Post ${post_id} deleted. Response: ${JSON.stringify(data)}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "reply_to_post",
    {
      title: "Reply to a Threads post",
      description: "Post a reply to an existing Threads post or comment.",
      inputSchema: {
        account: accountField,
        reply_to_id: z.string().min(1).describe("The ID of the post/comment to reply to"),
        text: z.string().min(1).describe("The reply text"),
      },
    },
    async ({ account, reply_to_id, text }) => {
      const { accessToken, userId, label } = getAccount(account);
      const container = await threadsFetch(accessToken, `/${userId}/threads`, {
        method: "POST",
        body: { media_type: "TEXT", text, reply_to_id },
      });

      await sleep(2000);

      const published = await threadsFetch(accessToken, `/${userId}/threads_publish`, {
        method: "POST",
        body: { creation_id: container.id },
      });

      return {
        content: [{ type: "text", text: `[${label}] Reply published successfully. Reply ID: ${published.id}` }],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server (stateless — one MCP server instance per request)
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/", (_req, res) => {
  res.send("Threads MCP server is running.");
});

// OAuth redirect target — just displays the code so it's easy to copy.
app.get("/callback", (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) {
    res.send(`<html><body style="font-family:sans-serif;padding:2rem">
      <h2>OAuth error</h2>
      <p><b>${error}</b></p>
      <p>${error_description || ""}</p>
    </body></html>`);
    return;
  }
  res.send(`<html><body style="font-family:sans-serif;padding:2rem">
    <h2>Authorization code:</h2>
    <pre style="background:#eee;padding:1rem;word-break:break-all">${code || "(tidak ada code di URL)"}</pre>
    <p>Copy kode di atas, lalu pakai untuk tukar ke access token.</p>
  </body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Threads MCP server listening on port ${PORT}`);
});

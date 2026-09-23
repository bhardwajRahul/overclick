import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { db } from "../lib/db";
import { authenticateBearer } from "./auth";
import { createOverclickMcpServer } from "./server";
import type { McpDatabase } from "./types";

export async function handleMcpRequest(
  request: Request,
  deps?: { db: McpDatabase },
): Promise<Response> {
  // OCL-214: this route runs without sessions, so it has no event stream to
  // offer. The transport used to answer GET with a stream that closed at once,
  // and every live client reopened it in a loop (about 12 GETs a second in
  // production, each rebuilding the whole server). 405 is the spec's way to
  // say "no stream here"; clients stop asking.
  if (request.method === "GET") {
    return new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } });
  }
  const database = deps?.db ?? db();
  const auth = await authenticateBearer(
    database,
    request.headers.get("authorization"),
  );
  if (!auth.ok) {
    return Response.json(
      { error: { code: auth.code, message: auth.message } },
      { status: 401 },
    );
  }

  const server = await createOverclickMcpServer({ db: database, ctx: auth.ctx });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp.ts";

const transport = new StdioServerTransport();
transport.onclose = () => process.exit(0);
process.stdin.on("end", () => process.exit(0));
await createServer().connect(transport);

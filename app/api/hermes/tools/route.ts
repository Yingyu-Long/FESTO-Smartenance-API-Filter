import { NO_STORE } from "@/lib/festo/http";
import { HERMES_TOOLS } from "@/lib/hermes/tools";

export async function GET() {
  return Response.json(
    {
      tools: HERMES_TOOLS.map(({ name, category, description }) => ({
        name,
        category,
        description,
      })),
    },
    { headers: NO_STORE },
  );
}

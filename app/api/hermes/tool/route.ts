import { FestoError } from "@/lib/festo/client";
import { NO_STORE, readBody } from "@/lib/festo/http";
import {
  AmbiguousMachineError,
  MachineNotFoundError,
} from "@/lib/hermes/incident-service";
import { executeHermesTool } from "@/lib/hermes/tools";

export async function POST(request: Request) {
  try {
    const body = (await readBody(request)) as {
      tool?: unknown;
      arguments?: unknown;
      accountKey?: unknown;
    };
    if (!body || typeof body.tool !== "string" || !body.tool.trim()) {
      return Response.json(
        { ok: false, error: "A tool name is required." },
        { status: 400, headers: NO_STORE },
      );
    }
    const result = await executeHermesTool(body.tool.trim(), body.arguments ?? {}, {
      accountKey: typeof body.accountKey === "string" ? body.accountKey : undefined,
    });
    return Response.json({ ok: true, result }, { headers: NO_STORE });
  } catch (error) {
    const status =
      error instanceof FestoError
        ? error.status
        : error instanceof MachineNotFoundError
          ? 404
          : error instanceof AmbiguousMachineError
            ? 400
            : 400;
    const message = error instanceof Error ? error.message : "Tool execution failed.";
    return Response.json({ ok: false, error: message }, { status, headers: NO_STORE });
  }
}

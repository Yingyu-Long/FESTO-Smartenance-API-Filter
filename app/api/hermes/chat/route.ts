import { FestoError } from "@/lib/festo/client";
import { NO_STORE, readBody } from "@/lib/festo/http";
import { normalizeThinkLevel, readHermesConfig } from "@/lib/hermes/config";
import { runHermesAgentChat, type ChatTurnInput } from "@/lib/hermes/llm";

export async function POST(request: Request) {
  try {
    const body = (await readBody(request)) as {
      language?: unknown;
      messages?: unknown;
      thinkLevel?: unknown;
    };
    if (!body || !Array.isArray(body.messages)) {
      return Response.json(
        { error: "messages array is required." },
        { status: 400, headers: NO_STORE },
      );
    }
    const language = body.language === "zh" ? "zh" : "en";
    const config = await readHermesConfig();
    const thinkLevel =
      body.thinkLevel !== undefined
        ? normalizeThinkLevel(body.thinkLevel, config.thinkLevel)
        : config.thinkLevel;
    const outcome = await runHermesAgentChat({
      language,
      messages: body.messages as ChatTurnInput[],
      config,
      thinkLevel,
      signal: request.signal,
    });
    return Response.json(outcome, { headers: NO_STORE });
  } catch (error) {
    const status = error instanceof FestoError ? error.status : 400;
    const message = error instanceof Error ? error.message : "Agent failed to respond.";
    return Response.json({ error: message }, { status, headers: NO_STORE });
  }
}

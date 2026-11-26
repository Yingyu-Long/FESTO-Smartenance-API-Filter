import { NO_STORE, readBody } from "@/lib/festo/http";
import { readHermesConfig } from "@/lib/hermes/config";
import { testModelConnection } from "@/lib/hermes/llm";

export async function POST(request: Request) {
  try {
    const body = (await readBody(request)) as {
      provider?: string;
      apiFormat?: "openai" | "anthropic";
      baseUrl?: string;
      apiKey?: string;
      model?: string;
    };
    const saved = await readHermesConfig();
    const result = await testModelConnection({
      provider: body?.provider?.trim() || saved.provider,
      apiFormat: body?.apiFormat === "anthropic" ? "anthropic" : "openai",
      baseUrl: body?.baseUrl?.trim() || saved.baseUrl,
      apiKey: body?.apiKey?.trim() ? body.apiKey.trim() : saved.apiKey,
      model: body?.model?.trim() || saved.model,
    });
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection test failed.";
    return Response.json({ ok: false, error: message }, { status: 400, headers: NO_STORE });
  }
}

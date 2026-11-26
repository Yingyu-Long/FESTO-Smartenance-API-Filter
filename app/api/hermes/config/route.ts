import { FestoError } from "@/lib/festo/client";
import { NO_STORE, readBody } from "@/lib/festo/http";
import {
  readHermesBootstrap,
  saveHermesConfig,
  toClientConfig,
  type HermesConfigPatch,
} from "@/lib/hermes/config";

function jsonError(error: unknown) {
  const status = error instanceof FestoError ? error.status : 400;
  const message = error instanceof Error ? error.message : "Failed to process configuration.";
  return Response.json({ error: message }, { status, headers: NO_STORE });
}

export async function GET() {
  try {
    const payload = await readHermesBootstrap();
    return Response.json(payload, { headers: NO_STORE });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await readBody(request)) as HermesConfigPatch;
    const saved = await saveHermesConfig(body ?? {});
    return Response.json(
      { saved: true, config: toClientConfig(saved) },
      { headers: NO_STORE },
    );
  } catch (error) {
    return jsonError(error);
  }
}

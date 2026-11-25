import { readAutoSyncStatus } from "@/lib/festo/auto-sync";
import { errorResponse, NO_STORE } from "@/lib/festo/http";

export async function GET() {
  try {
    const status = await readAutoSyncStatus();
    return Response.json(status, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

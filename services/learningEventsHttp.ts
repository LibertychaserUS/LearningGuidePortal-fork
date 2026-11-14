import { NextResponse } from "next/server";
import { currentProductUserFromRequest } from "@/services/productAuth";
import {
  createLearningEventsService,
  createPostgresLearningEventStore,
  createPostgresLearningPlanSource,
  LearningEventError,
  publicLearningEvent,
  type LearningEventsService
} from "@/services/learningEvents";

/**
 * HTTP adapter for `POST /api/learning/events` (design §14 C8 / §12).
 *
 * The handler factory lives here, not in the route module: Next.js route files
 * may only export HTTP methods and route configuration, so a named export in
 * `app/api/learning/events/route.ts` fails `next build`. The route re-exports
 * only `dynamic` and the production-wired `POST`; unit tests import this module
 * to supply the service (memory store + plan source).
 */

const RESPONSE_HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" };

function defaultService(): LearningEventsService {
  return createLearningEventsService({
    store: createPostgresLearningEventStore(),
    planSource: createPostgresLearningPlanSource()
  });
}

/**
 * The route only parses the request, resolves the signed-in user from the
 * session cookie, calls the application service and returns its result
 * (AGENTS.md route-handler rule). userId and receivedAt are server-owned: the
 * service rejects them in the body and stamps the authoritative clock.
 */
export function createLearningEventsPostHandler(service: LearningEventsService = defaultService()) {
  return async function POST(request: Request) {
    const user = await currentProductUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ ok: false, error: "Sign in is required." }, { status: 401, headers: RESPONSE_HEADERS });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { ok: false, code: "INVALID_LEARNING_EVENT", error: "Request body must be valid JSON." },
        { status: 400, headers: RESPONSE_HEADERS }
      );
    }

    try {
      const result = await service.appendEvent(user.id, body);
      return NextResponse.json(
        {
          ok: true,
          duplicate: result.duplicate,
          event: publicLearningEvent(result.event, result.stageValidated)
        },
        { status: 200, headers: RESPONSE_HEADERS }
      );
    } catch (error) {
      if (error instanceof LearningEventError) {
        return NextResponse.json(
          { ok: false, code: error.code, error: error.message },
          { status: error.status, headers: RESPONSE_HEADERS }
        );
      }
      throw error;
    }
  };
}

import { createLearningEventsPostHandler } from "@/services/learningEventsHttp";

/**
 * POST /api/learning/events — append one learning event (design §14 C8 / §12).
 *
 * A Next.js route module may only export HTTP methods and route configuration;
 * the handler factory and the service wiring live in
 * `services/learningEventsHttp.ts` (unit tests import it from there). This file
 * exports exactly `dynamic` and `POST`.
 */
export const dynamic = "force-dynamic";

export const POST = createLearningEventsPostHandler();

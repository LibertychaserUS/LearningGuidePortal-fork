import { NextResponse } from "next/server";
import { getCourseCatalogue, saveCatalogueEntry } from "@/services/productStore";
import { authoringActor, authoringBody, authoringFailure, authoringSuccess } from "@/services/courseAuthoringHttp";
import { CatalogueManagedInAdminError, type CatalogueInput } from "@/contracts/course-authoring";

export async function GET(request: Request) {
  try {
    const user = await authoringActor(request);
    return authoringSuccess({ entries: await getCourseCatalogue(user.id) });
  } catch (error) { return authoringFailure(error); }
}

export async function POST(request: Request) {
  try {
    const user = await authoringActor(request, true);
    return authoringSuccess({ entry: await saveCatalogueEntry(user.id, null, await authoringBody<CatalogueInput>(request)) }, 201);
  } catch (error) {
    // P7: the legacy catalogue write entry stays closed during the read-only transition.
    if (error instanceof CatalogueManagedInAdminError) return NextResponse.json({ ok: false, code: error.code, requestId: crypto.randomUUID() }, { status: error.status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
    return authoringFailure(error);
  }
}

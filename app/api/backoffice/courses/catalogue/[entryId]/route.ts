import { NextResponse } from "next/server";
import { saveCatalogueEntry } from "@/services/productStore";
import { authoringActor, authoringBody, authoringFailure, authoringSuccess } from "@/services/courseAuthoringHttp";
import { CatalogueManagedInAdminError, type CatalogueInput } from "@/contracts/course-authoring";

export async function PATCH(request: Request, { params }: { params: Promise<{ entryId: string }> }) {
  try {
    const user = await authoringActor(request, true);
    const input = await authoringBody<CatalogueInput>(request);
    return authoringSuccess({ entry: await saveCatalogueEntry(user.id, (await params).entryId, input) });
  } catch (error) {
    // P7: the legacy catalogue write entry stays closed during the read-only transition.
    if (error instanceof CatalogueManagedInAdminError) return NextResponse.json({ ok: false, code: error.code, requestId: crypto.randomUUID() }, { status: error.status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
    return authoringFailure(error);
  }
}

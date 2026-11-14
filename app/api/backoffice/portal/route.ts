import { getPortalContent, savePortalContent } from "@/services/productStore";
import { portalCmsAccess, portalCmsBody, portalCmsFailure, portalCmsResponse } from "@/services/portalCmsHttp";
import { CategoriesManagedInAdminError } from "@/lib/portalContent";

export async function GET(request: Request) {
  const denied = await portalCmsAccess(request);
  if (denied) return denied;
  return portalCmsResponse({ content: await getPortalContent() });
}
export async function PUT(request: Request) {
  const denied = await portalCmsAccess(request, true);
  if (denied) return denied;
  try { return portalCmsResponse({ content: await savePortalContent(await portalCmsBody(request)) }); }
  catch (error) {
    // P6: category edits belong to Admin; the CMS answers 422 with the shared error code.
    if (error instanceof CategoriesManagedInAdminError) return portalCmsResponse({ error: error.message, code: error.code }, 422);
    return portalCmsFailure(error, "Save failed.");
  }
}

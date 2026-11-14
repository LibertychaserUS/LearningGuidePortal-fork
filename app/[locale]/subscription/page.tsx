import { getMessages } from "@/lib/i18n/messages";
import { localeFrom } from "@/lib/i18n/config";
import { resolveCourseCategory } from "@/lib/coursePage";
import { subscriptionCategories } from "@/lib/subscriptionCategoryLabel";
import { getAdminCatalogue } from "@/services/adminCatalogueCache";
import { getProductCourse, getSubscriptionSelection, listPlansForPurchase, listPublishedCourses } from "@/services/productStore";
import { PurchasePanel } from "@/components/portal/PurchasePanel";
import { SubscriptionSelection } from "@/components/portal/SubscriptionSelection";
import { PortalFooter } from "@/components/portal/PortalFooter";
import { PortalHeader } from "@/components/portal/PortalHeader";
import { currentProductUser } from "@/services/productAuth";

export default async function SubscriptionPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ courseId?: string; upgradeFrom?: string; planId?: string; device?: string }> }) {
  const locale = localeFrom((await params).locale);
  const { courseId, planId, device } = await searchParams;
  const user = await currentProductUser();
  const plans = await listPlansForPurchase(user?.id);
  // P5: the subscription cards are the Admin catalogue's ACTIVE categories
  // (stable `name` + `localized`), the same keys `activeCategoryKeys` uses in
  // `getSubscriptionSelection`; the retired Portal CMS three-category list is
  // not consulted.
  const [selection, catalogue] = await Promise.all([getSubscriptionSelection(user?.id), getAdminCatalogue()]);
  const categories = subscriptionCategories(catalogue);
  const publishedCourses = await listPublishedCourses();
  const course = courseId ? await getProductCourse(courseId) : null;
  const messages = getMessages(locale);
  const copy = messages.pricingDesign;
  const courseCategory = course?.status === "published" ? resolveCourseCategory(course, catalogue)?.name ?? undefined : undefined;
  const directPlans = device === "mobile" ? plans.filter((plan) => plan.device === "mobile") : course?.status === "published" ? plans.filter((plan) => plan.scope === "course" && (plan.scopeId || plan.courseId) === course.id) : [];
  return <main className="portal-page pricing-design-page">
    <PortalHeader locale={locale} active="subscription" signedIn={Boolean(user)} displayName={user?.nickname} avatarUrl={user?.avatarPath ? "/api/my-learning/avatar" : undefined} />
    <section className="pricing-design-main">
      <SubscriptionSelection key={`${course?.id || ""}:${planId || ""}`} selection={selection} locale={locale} plans={plans} categories={categories} courseTitles={publishedCourses.map((item) => ({ category: resolveCourseCategory(item, catalogue)?.name ?? undefined, title: item.title }))} selectedPlanId={planId} selectedCategoryId={courseCategory} copy={copy} />
      {directPlans.length && selection.kind !== "everything" && selection.kind !== "all_categories" ? <section className="pricing-direct"><h2>{course?.title || messages.portal.pricingTitle}</h2><PurchasePanel locale={locale} courseId={course?.id || "*"} plans={directPlans} allowTrial={device !== "mobile"} copy={{ startTrial: messages.learning.startTrial, buy: messages.learning.buy, choosePlan: messages.learning.choosePlan }} /></section> : null}
    </section>
    <section className="pricing-design-information"><div><h2>{copy.information}</h2><div className="pricing-information-grid">{copy.rules.map((rule) => <div key={rule.title}><h3>{rule.title}</h3><p>{rule.text}</p></div>)}</div></div></section>
    <PortalFooter locale={locale} />
  </main>;
}

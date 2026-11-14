import { redirect } from "next/navigation";
import { AccountNav } from "@/components/portal/AccountNav";
import { OverviewDesign } from "@/components/portal/OverviewDesign";
import { OverviewModeSync } from "@/components/portal/OverviewModeSync";
import { PortalFooter } from "@/components/portal/PortalFooter";
import { PortalHeader } from "@/components/portal/PortalHeader";
import type { OverviewDisplay } from "@/contracts/overview-display";
import type { Locale } from "@/lib/i18n/config";
import { localeFrom } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";
import { resolveCourseCategory } from "@/lib/coursePage";
import { currentProductUser } from "@/services/productAuth";
import { getOverviewDisplay } from "@/services/overviewDisplay";
import { listPublishedCourses } from "@/services/productStore";
import { getAdminCatalogue } from "@/services/adminCatalogueCache";
import styles from "@/components/portal/overview-design.module.css";

/**
 * P3/P4: My Learning cards resolve their category through the Admin catalogue, not the CMS and
 * not the retired store `category` string. Unclassified courses render no category tag.
 */
async function withResolvedCategories(data: OverviewDisplay, locale: Locale): Promise<OverviewDisplay> {
  if (!data.courses.length) return data;
  const [courses, catalogue] = await Promise.all([listPublishedCourses(), getAdminCatalogue()]);
  const byId = new Map(courses.map((course) => [course.id, course]));
  return {
    ...data,
    courses: data.courses.map((card) => {
      const resolved = resolveCourseCategory(byId.get(card.courseId), catalogue);
      return { ...card, category: resolved ? resolved.localized[locale]?.name || resolved.name : "" };
    }),
  };
}

export default async function MyLearningPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeFrom((await params).locale);
  const user = await currentProductUser();
  if (!user) redirect(`/${locale}/portal/sign-in?returnTo=/${locale}/account/my-learning`);
  const data = await withResolvedCategories(await getOverviewDisplay(user.id, user.nickname, locale), locale);
  const messages = getMessages(locale);
  return <main className={`portal-page portal-account-page ${styles.page}`}>
    <PortalHeader locale={locale} active="my-learning" signedIn displayName={user.nickname} avatarUrl={user.avatarPath ? "/api/my-learning/avatar" : undefined}/>
    <AccountNav locale={locale} copy={messages.account}/>
    <OverviewDesign data={data} locale={locale}/>
    <PortalFooter locale={locale}/>
    <OverviewModeSync userId={user.id} courses={data.syncCourses || data.courses.map(course => ({ courseId: course.courseId, mode: course.mode }))}/>
  </main>;
}

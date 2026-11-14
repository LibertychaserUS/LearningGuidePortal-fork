import Link from "next/link";
import Image from "next/image";
import { getMessages } from "@/lib/i18n/messages";
import { localeFrom } from "@/lib/i18n/config";
import { listPublishedCourses } from "@/services/productStore";
import { getAdminCatalogue } from "@/services/adminCatalogueCache";
import { currentProductUser } from "@/services/productAuth";
import { CatalogueCourseCard } from "@/components/portal/CatalogueCourseCard";
import { PortalFooter } from "@/components/portal/PortalFooter";
import { PortalHeader } from "@/components/portal/PortalHeader";
import { BannerCarousel } from "@/components/portal/BannerCarousel";
import { signCourseMediaUrl } from "@/services/persistence/s3";
import { resolveCourseCategory } from "@/lib/coursePage";
import styles from "@/components/portal/home.module.css";

export default async function PortalHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  const locale = localeFrom(rawLocale);
  const copy = getMessages(locale).portal;
  const home = getMessages(locale).homeDesign;
  const [courses, catalogue] = await Promise.all([listPublishedCourses(), getAdminCatalogue()]);
  const popularCourses = [...courses].reverse().slice(0, 6);
  const user = await currentProductUser();

  return (
    <main className={`portal-page portal-home-page ${styles.page}`}>
      <PortalHeader locale={locale} signedIn={Boolean(user)} displayName={user?.nickname} avatarUrl={user?.avatarPath ? "/api/my-learning/avatar" : undefined} />
      <BannerCarousel locale={locale} home />

      <section className={styles.courses} aria-labelledby="course-heading">
        <h2 id="course-heading">{home.popular}</h2>
        {popularCourses.length ? <div className={styles.courseGrid}>{await Promise.all(popularCourses.map(async course => {
          // P4: card labels come from the Admin catalogue localized name; unclassified shows no badge.
          const resolved = resolveCourseCategory(course, catalogue);
          return <CatalogueCourseCard variant="home" key={course.id} course={{ ...course, cover: await signCourseMediaUrl(course.cover || course.thumbnailPath || "") }} locale={locale} category={resolved ? resolved.localized[locale]?.name || resolved.name : null} />;
        }))}</div> : <p className="portal-empty">{copy.noCourses}</p>}
        <Link prefetch={false} className={styles.allCourses} href={`/${locale}/portal/courses`}>{home.allCourses}</Link>
      </section>

      <section id="why-us" className={styles.why} aria-labelledby="why-heading"><p>{home.why}</p><h2 id="why-heading">{home.whyTitle}</h2><Image className={styles.underline} src="/portal/home/underline.svg" alt="" width={161.5} height={14.1308} /></section>
      <section className={styles.values} aria-label={home.why}>{home.values.map((value, index) => <article key={value.title}><span>{index + 1}.</span><h3>{value.title}</h3><p>{value.text}</p></article>)}</section>
      <section className={styles.guide}><div className={styles.guideInner}><div><h2>{home.guide}</h2><div className={styles.guideSteps}>{home.steps.map(step => <article key={step.title}><h3>{step.title}</h3><p>{step.text}</p></article>)}</div></div><Image className={styles.guideImage} src="/portal/home/quick-guide.png" width={563} height={522} alt={home.guideImage} /></div></section>
      <PortalFooter locale={locale} />
    </main>
  );
}

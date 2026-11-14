import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultPortalContent } from "../../lib/portalContent";
import { getMessages } from "../../lib/i18n/messages";
import { isolate } from "../io/harness";

/**
 * S7 — Portal category resolver and display surfaces (black-box TDD spec).
 *
 * Design SSOT: /Users/nihao/AI infra/LearningGuideAdmin/docs/Course_Category_Single_Source_Design.md
 *
 *   I7  A course keeps exactly one category membership; the stable key is the category
 *       path name (ProductCourse carries `categoryKey: string | null`), never a display
 *       name and never the retired `category`/`categoryId` pair.
 *   P3  `resolveCourseCategory(course, catalogue) -> { name, localized } | null` is the
 *       single resolver: it maps the course's `categoryKey` through the Admin catalogue;
 *       a display name that is not a stable key resolves to null (no guessing); an
 *       unknown `?category=` value yields an empty catalogue list, never a default.
 *   P4  `/portal/courses?category=<stable key>` shows only courses whose resolved name
 *       equals the value; `All` shows everything including unclassified courses; cards,
 *       home cards, footer, course-detail breadcrumb/chip, My Learning and lesson pages
 *       render the catalogue `localized` name for the current locale and render no
 *       category badge for unclassified courses. The legacy `|| 'European Humanities'`
 *       fallback (and equivalents) is forbidden.
 *   P8  The "Start preview" CTA is derived from data: a published, trial-enabled course
 *       with a public first lesson links to that lesson; with no such course the CTA is
 *       not rendered. No hard-coded course/lesson ids (e.g. horatius/lesson-21).
 *
 * Observation boundary (black box): the real page/route components and the real
 * catalogue consumer modules are compiled with esbuild exactly as the app composes
 * them; only the two data suppliers are replaced with fixtures —
 *   - `@/services/productStore` (public page data entries; the fixture store returns
 *     courses shaped by the post-refactor contract: `categoryKey` only, plus
 *     `trialEnabled`/`trial` for P8), and
 *   - the Admin catalogue client `services/adminCatalogue.ts` /
 *     `services/adminCatalogueCache.ts` (P1/P2; fixture nodes follow C1:
 *     `{ name, localized: { "en-GB": { name }, "zh-CN": { name } }, sortOrder, children }`).
 * Both suppliers are located by module specifier, so the tests keep working while the
 * implementation changes their internals. Assertions only look at rendered output.
 *
 * Fixture store contract used by the pages (all values are plain public projections):
 *   listPublishedCourses(), getProductCourse(slug), getCoursePage(slug, userId),
 *   getCourseLearningMode(userId, courseId), getLessonBookmarks(userId, courseId),
 *   getPortalContent(), listPlans(), getLearningOverview(userId), publicFirstLesson(course).
 * `getCoursePage` deliberately reports the pre-refactor default `track: "European
 * Humanities"` to expose any surface that leaks the store projection instead of the
 * P3-resolved category (the leak this seam forbids).
 *
 * Run:
 *   node --import tsx --require ./scripts/register-tsconfig-paths.cjs \
 *     --test tests/unit/category-surfaces.test.ts
 */

type CatalogueNode = {
  name: string;
  localized: Record<string, { name: string }>;
  sortOrder: number;
  children: CatalogueNode[];
};

const TIME = "2026-01-01T00:00:00.000Z";
const ROOT = process.cwd();
const OUTPUT = path.join(ROOT, "test-results", "category-surfaces");

const node = (name: string, labels: Record<string, string>, sortOrder: number): CatalogueNode => ({
  name,
  localized: Object.fromEntries(Object.entries(labels).map(([locale, label]) => [locale, { name: label }])),
  sortOrder,
  children: [],
});

/** Admin catalogue fixture (C1): four pre-set categories, including Society (M6). */
const CATALOGUE: CatalogueNode[] = [
  node("Science", { "en-GB": "Science", "zh-CN": "科学" }, 0),
  node("Chinese Humanities", { "en-GB": "Chinese Humanities", "zh-CN": "中国人文" }, 1),
  node("European Humanities", { "en-GB": "European Humanities", "zh-CN": "欧洲人文" }, 2),
  node("Society", { "en-GB": "Society", "zh-CN": "社会" }, 3),
];

const labelOf = (name: string, locale: "en-GB" | "zh-CN") => {
  const entry = CATALOGUE.find((item) => item.name === name);
  assert.ok(entry, `catalogue fixture has ${name}`);
  return entry.localized[locale].name;
};

const lesson = (id: string, title: string, isPublic: boolean) => ({ id, title, durationMinutes: 30, isPublic });

type CourseInput = { id: string; slug?: string; title: string; categoryKey: string | null; trial: boolean; lessons: ReturnType<typeof lesson>[] };

/**
 * Post-refactor ProductCourse fixture (I7/P3): one `categoryKey` stable key, no
 * `category`/`categoryId` pair. `trialEnabled`/`trial` mirror the Admin projection
 * used by P8.
 */
const course = (input: CourseInput) => ({
  id: input.id,
  slug: input.slug ?? input.id,
  title: input.title,
  description: `${input.title} is a fixture course for category surface verification.`,
  authorIds: [],
  thumbnailPath: null,
  status: "published",
  createdAt: TIME,
  updatedAt: TIME,
  categoryKey: input.categoryKey,
  trialEnabled: input.trial,
  trial: { enabled: input.trial, lessonIds: input.trial ? input.lessons.filter((item) => item.isPublic).slice(0, 1).map((item) => item.id) : [] },
  sections: [{ id: `${input.id}-section`, title: "Lessons", lessons: input.lessons }],
});

const SOCIETY_COURSE = course({
  id: "civic-life",
  slug: "civic-life",
  title: "Civic Life",
  categoryKey: "Society",
  trial: true,
  lessons: [lesson("social-contract", "The Social Contract", true), lesson("civic-virtue", "Civic Virtue", false)],
});
const DISPLAY_NAME_COURSE = course({
  id: "justice-community",
  slug: "justice-community",
  title: "Justice and Community",
  categoryKey: "社会科学",
  trial: false,
  lessons: [lesson("justice-one", "Justice One", false)],
});
const UNCLASSIFIED_COURSE = course({
  id: "fragments",
  slug: "fragments",
  title: "Fragments and Notes",
  categoryKey: null,
  trial: false,
  lessons: [lesson("fragments-one", "Fragments One", false)],
});
const PUBLIC_BUT_NOT_TRIAL = course({
  id: "open-lecture",
  slug: "open-lecture",
  title: "Open Lecture",
  categoryKey: "Science",
  trial: false,
  lessons: [lesson("open-one", "Open One", true)],
});
const TRIAL_BUT_NO_PUBLIC = course({
  id: "closed-trial",
  slug: "closed-trial",
  title: "Closed Trial",
  categoryKey: "Science",
  trial: true,
  lessons: [lesson("closed-one", "Closed One", false)],
});

type SurfaceFixture = {
  user: { id: string; nickname: string } | null;
  catalogue: CatalogueNode[];
  store: Record<string, (...args: any[]) => any>;
};

const globalState = globalThis as unknown as { __lgCategorySurfaces?: SurfaceFixture };

function install(input: { user?: SurfaceFixture["user"]; catalogue?: CatalogueNode[]; store: SurfaceFixture["store"] }) {
  globalState.__lgCategorySurfaces = { user: input.user ?? null, catalogue: input.catalogue ?? CATALOGUE, store: input.store };
}

/** Portal CMS is no longer the category display source (P6): the fixture content has none. */
function portalContentFixture() {
  const content = structuredClone(defaultPortalContent) as Record<string, unknown>;
  content.categories = [];
  return content;
}

const learningRecord = {
  id: "learning-record-society",
  userId: "learner-1",
  courseId: SOCIETY_COURSE.id,
  startedAt: TIME,
  updatedAt: TIME,
  currentLessonId: "social-contract",
  currentContentId: null,
  mode: "text",
  totalSeconds: 120,
  openedLearningPointCount: 0,
  totalLearningPoints: 2,
  progress: 0,
  progressFailed: false,
  completedAt: null,
  completedLessonIds: [] as string[],
  completedContentIds: [] as string[],
  legacyCompletedLessonIds: [] as string[],
  previewAvailable: true,
  nextPreviewLessonId: null,
  courseTitle: SOCIETY_COURSE.title,
  courseDescription: SOCIETY_COURSE.description,
  courseCategory: "European Humanities",
  courseStatus: "published",
  lessonCount: 2,
  totalMinutes: 60,
  entitlement: null,
  cardState: "preview",
  cta: "continue_preview",
};

function learningOverviewFixture() {
  return {
    name: "Learner",
    courses: [structuredClone(learningRecord)],
    subscriptions: [],
    entitlements: [],
    orders: [],
    emptyState: null,
    emptyCta: null,
    syncCourses: [],
  };
}

/**
 * Legacy store projection for the course detail page: the store does not resolve
 * display categories, so its `identity.track` still carries the old default. Any
 * surface that renders this value instead of the P3 resolver result fails the test.
 */
function legacyCoursePage(courseValue: any) {
  if (!courseValue) {
    return {
      pageState: "failed", identity: null, syllabus: [], cta: null, secondaryCta: null, accessState: "none",
      openedLearningPointCount: 0, totalLearningPoints: 0, progress: null, nextPreviewLessonId: null, actionLessonId: null,
    };
  }
  const lessons = courseValue.sections.flatMap((section: any) => section.lessons);
  return {
    pageState: courseValue.status === "published" ? "available" : "withdrawn",
    identity: {
      title: courseValue.title,
      track: "European Humanities",
      lessonCount: lessons.length,
      previewAvailable: Boolean(lessons[0]?.isPublic),
      totalMinutes: lessons.reduce((total: number, item: any) => total + (item.durationMinutes || 0), 0),
    },
    syllabus: lessons.map((item: any) => ({ lessonId: item.id, title: item.title, access: item.isPublic ? "previewable" : "locked", openable: Boolean(item.isPublic) })),
    cta: "view_plans",
    secondaryCta: null,
    accessState: "none",
    openedLearningPointCount: 0,
    totalLearningPoints: lessons.length,
    progress: null,
    nextPreviewLessonId: null,
    actionLessonId: lessons[0]?.id || null,
  };
}

function storeFixture(courses: any[]) {
  const findCourse = (slug: string) => courses.find((item) => item.slug === slug || item.id === slug) || null;
  return {
    listPublishedCourses: async () => structuredClone(courses.filter((item) => item.status === "published")),
    getProductCourse: async (slug: string) => structuredClone(findCourse(slug)),
    getPortalContent: async () => structuredClone(portalContentFixture()),
    listPlans: async () => [],
    getCoursePage: async (slug: string) => legacyCoursePage(findCourse(slug)),
    getCourseLearningMode: async () => null,
    getLessonBookmarks: async () => null,
    getLearningOverview: async () => structuredClone(learningOverviewFixture()),
    publicFirstLesson: (courseValue: any) => {
      const first = courseValue.sections.flatMap((section: any) => section.lessons)[0];
      return first?.isPublic ? first : null;
    },
  } satisfies Record<string, (...args: any[]) => any>;
}

const MOCK_PRODUCT_STORE = `
const state = () => globalThis.__lgCategorySurfaces;
const names = [
  "getPortalContent", "listPublishedCourses", "getProductCourse", "getCoursePage",
  "getCourseLearningMode", "getLessonBookmarks", "listPlans", "listPlansForPurchase",
  "getLearningOverview", "publicFirstLesson", "checkEntitlement", "getTrialPreview",
  "getTrialCourse", "firstPublicLesson"
];
const exportsObject = { __esModule: true };
for (const name of names) {
  exportsObject[name] = (...args) => {
    const store = state() && state().store;
    const entry = store && store[name];
    if (typeof entry !== "function") throw new Error("Category surface fixture store has no public entry " + name);
    return entry(...args);
  };
}
module.exports = new Proxy(exportsObject, {
  get(target, prop) {
    if (typeof prop !== "string") return undefined;
    if (prop === "__esModule") return true;
    if (prop === "default") return target;
    if (!(prop in target)) target[prop] = (...args) => {
      const store = state() && state().store;
      const entry = store && store[prop];
      if (typeof entry !== "function") throw new Error("Category surface fixture store has no public entry " + prop);
      return entry(...args);
    };
    return target[prop];
  },
  ownKeys(target) { return Reflect.ownKeys(target); },
  getOwnPropertyDescriptor(target, prop) { return { enumerable: true, configurable: true, value: target[prop] }; }
});
`;

const MOCK_ADMIN_CATALOGUE = `
const state = () => globalThis.__lgCategorySurfaces;
const load = () => Promise.resolve(state() ? state().catalogue : []);
const cache = { getCatalogue: load, get: load, refresh: load, clear() {} };
const names = [
  "getCatalogue", "getAdminCatalogue", "loadCatalogue", "fetchCatalogue", "getCatalogueTree",
  "createAdminCatalogueCache", "createAdminCatalogueClient"
];
const exportsObject = { __esModule: true };
for (const name of names) {
  exportsObject[name] = name.indexOf("create") === 0 ? () => cache : load;
}
exportsObject.catalogueCache = cache;
exportsObject.adminCatalogueCache = cache;
module.exports = new Proxy(exportsObject, {
  get(target, prop) {
    if (typeof prop !== "string") return undefined;
    if (prop === "__esModule") return true;
    if (prop === "default") return target;
    if (prop in target) return target[prop];
    if (prop === "DEFAULT_CATALOGUE" || prop === "ADMIN_CATALOGUE_SEED" || prop === "builtInCatalogue") {
      return state() ? state().catalogue : [];
    }
    return load;
  },
  ownKeys(target) {
    return [...Reflect.ownKeys(target), "DEFAULT_CATALOGUE", "ADMIN_CATALOGUE_SEED", "builtInCatalogue"];
  },
  getOwnPropertyDescriptor(target, prop) { return { enumerable: true, configurable: true, value: target[prop] }; }
});
`;

const MOCK_LINK = `
import React from "react";
export default function Link({ prefetch, replace, scroll, shallow, locale, legacyBehavior, passHref, ...props }) {
  return React.createElement("a", props);
}
`;

const MOCK_IMAGE = `
import React from "react";
export default function Image({ unoptimized, priority, fill, loader, placeholder, blurDataURL, quality, ...props }) {
  return React.createElement("img", props);
}
`;

const MOCK_NAVIGATION = `
export const redirect = (href) => { throw new Error("redirect:" + href); };
export const permanentRedirect = redirect;
export const notFound = () => { throw new Error("notFound"); };
export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} });
export const usePathname = () => "/";
export const useSearchParams = () => new URLSearchParams("");
export const useParams = () => ({});
`;

const MOCK_HEADERS = `
export const cookies = async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {} });
export const headers = async () => new Map();
export const draftMode = async () => ({ isEnabled: false, enable() {}, disable() {} });
`;

const MOCK_CACHE = `
export const revalidateTag = () => {};
export const revalidatePath = () => {};
export const unstable_cache = (fn) => fn;
export const cache = (fn) => fn;
export const unstable_noStore = () => {};
`;

const MOCK_AUTH = `
const state = () => globalThis.__lgCategorySurfaces;
export const currentProductUser = async () => (state() ? state().user : null);
export const requireProductUser = async () => {
  const user = await currentProductUser();
  if (!user) throw new Error("unauthorised");
  return user;
};
export const currentOperatorUser = async () => null;
export const currentBackofficeAuthor = async () => null;
`;

const MOCK_MEDIA = `
export const signCourseMediaUrl = async (value) => value || "/portal/course-study.jpg";
export const signCourseMediaReferences = async (value) => value;
export const signLessonMediaReferences = async (value) => value;
`;

const MOCK_COMPONENTS = `
import React from "react";
const Null = () => null;
export const PortalHeader = Null;
export const PortalFooter = Null;
export const CourseDetailSync = Null;
export const CourseLearningModeDialog = Null;
export const BannerCarousel = Null;
export const AccountNav = Null;
export const OverviewModeSync = Null;
export const StreamedContent = ({ children }) => children;
export const CourseThumbnail = ({ src, title }) => React.createElement("img", { src, alt: title });
export default Null;
`;

function mockContents(specifier: string) {
  if (specifier === "next/link") return MOCK_LINK;
  if (specifier === "next/image") return MOCK_IMAGE;
  if (specifier === "next/navigation") return MOCK_NAVIGATION;
  if (specifier === "next/headers") return MOCK_HEADERS;
  if (specifier === "next/cache") return MOCK_CACHE;
  if (specifier === "productStore") return MOCK_PRODUCT_STORE;
  if (specifier === "adminCatalogue") return MOCK_ADMIN_CATALOGUE;
  if (specifier === "productAuth") return MOCK_AUTH;
  if (specifier === "media") return MOCK_MEDIA;
  return MOCK_COMPONENTS;
}

function categorySurfacePlugin(): Plugin {
  return {
    name: "category-surfaces",
    setup(api) {
      api.onResolve({ filter: /^next\/(link|image|navigation|headers|cache)$/ }, (args) => ({ path: args.path, namespace: "category-surface" }));
      api.onResolve({ filter: /^(\.\/|@\/services\/)productStore$/ }, () => ({ path: "productStore", namespace: "category-surface" }));
      api.onResolve({ filter: /^(\.\/|@\/services\/)productAuth$/ }, () => ({ path: "productAuth", namespace: "category-surface" }));
      api.onResolve({ filter: /(^|\/)persistence\/s3$/ }, () => ({ path: "media", namespace: "category-surface" }));
      api.onResolve({ filter: /(^|\/)(adminCatalogueCache|adminCatalogue)$/ }, () => ({ path: "adminCatalogue", namespace: "category-surface" }));
      api.onResolve({ filter: /^@\/components\/portal\/(PortalHeader|PortalFooter|StreamedContent|CourseThumbnail|CourseDetailSync|CourseLearningModeDialog|BannerCarousel|AccountNav|OverviewModeSync)$/ }, () => ({ path: "component", namespace: "category-surface" }));
      api.onResolve({ filter: /\.(png|jpe?g|svg|webp|woff2?|ttf|otf)(\?.*)?$/ }, () => ({ path: "asset", namespace: "category-surface-asset" }));
      api.onLoad({ filter: /.*/, namespace: "category-surface-asset" }, () => ({ loader: "empty", contents: "" }));
      api.onLoad({ filter: /.*/, namespace: "category-surface" }, (args) => ({
        loader: "js",
        resolveDir: ROOT,
        contents: mockContents(args.path),
      }));
    },
  };
}

const ENTRIES = {
  courses: "app/[locale]/portal/courses/page.tsx",
  home: "app/[locale]/portal/page.tsx",
  detail: "app/[locale]/portal/courses/[slug]/page.tsx",
  learning: "app/[locale]/account/my-learning/page.tsx",
  footer: "components/portal/PortalFooter.tsx",
} as const;

type SurfaceName = keyof typeof ENTRIES;

const compiled = new Map<SurfaceName, any>();

async function compile(name: SurfaceName) {
  const outfile = path.join(OUTPUT, `${name}.cjs`);
  const result = await build({
    entryPoints: [path.join(ROOT, ENTRIES[name])],
    absWorkingDir: ROOT,
    bundle: true,
    write: false,
    outfile,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-dom/server"],
    loader: { ".css": "local-css" },
    plugins: [categorySurfacePlugin()],
    logLevel: "silent",
  });
  const bundle = result.outputFiles.find((file) => file.path.endsWith(".cjs"));
  assert.ok(bundle, `${name} page bundle produced CommonJS output`);
  await writeFile(bundle.path, bundle.text);
  return createRequire(import.meta.url)(bundle.path);
}

before(async () => {
  await mkdir(OUTPUT, { recursive: true });
  for (const name of Object.keys(ENTRIES) as SurfaceName[]) compiled.set(name, await compile(name));
});

async function renderCourses(locale: "en-GB" | "zh-CN", category?: string) {
  const Page = compiled.get("courses").default;
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ locale }), searchParams: Promise.resolve({ category }) }));
}

async function renderHome(locale: "en-GB" | "zh-CN") {
  const Page = compiled.get("home").default;
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ locale }) }));
}

async function renderDetail(locale: "en-GB" | "zh-CN", slug: string) {
  const Page = compiled.get("detail").default;
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ locale, slug }), searchParams: Promise.resolve({}) }));
}

async function renderLearning(locale: "en-GB" | "zh-CN") {
  const Page = compiled.get("learning").default;
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ locale }) }));
}

async function renderFooter(locale: "en-GB" | "zh-CN") {
  const footerModule = compiled.get("footer");
  const Footer = footerModule.PortalFooter || footerModule.default;
  return renderToStaticMarkup(await Footer({ locale }));
}

const stripTags = (html: string) => html
  .replace(/<[^>]*>/g, "")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&#x27;/g, "'")
  .trim();

function articles(html: string) {
  return html.split(/<article\b/).slice(1).map((part) => `<article${part.split("</article>")[0]}`);
}

function anchors(html: string) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => ({
    href: /href="([^"]*)"/.exec(match[1])?.[1] ?? "",
    text: stripTags(match[2]),
  }));
}

/** All localized catalogue names; used to prove a badge-less card renders none of them. */
const ALL_LABELS = CATALOGUE.flatMap((entry) => Object.values(entry.localized).map((localized) => localized.name));

function assertNoCategoryBadge(markup: string, context: string) {
  for (const label of ALL_LABELS) assert.ok(!markup.includes(label), `${context}: card must not display category label "${label}"`);
}

// ---------------------------------------------------------------------------
// 1) P3/P4 — stable key = "Society" resolves and displays localised.
// ---------------------------------------------------------------------------

test("[S7][P3][P4] categoryKey=Society: the catalogue page lists the course under ?category=Society and labels it 社会 / Society", async () => {
  install({ store: storeFixture([SOCIETY_COURSE]) });
  for (const locale of ["en-GB", "zh-CN"] as const) {
    const html = await renderCourses(locale, "Society");
    const cards = articles(html).filter((card) => card.includes(SOCIETY_COURSE.title));
    assert.equal(cards.length, 1, `${locale}: ?category=Society must list the Society course (P4 stable-key filter)`);
    assert.ok(cards[0].includes(labelOf("Society", locale)), `${locale}: the card renders the Admin localized name for Society`);
  }
});

// ---------------------------------------------------------------------------
// 2) P3/P4 — a display name is not a stable key; no guessing.
// ---------------------------------------------------------------------------

test("[S7][P3][P4] categoryKey=社会科学 (a display name): resolves to null, appears only under All and is never matched by a display-name guess", async () => {
  install({ store: storeFixture([DISPLAY_NAME_COURSE]) });
  const all = await renderCourses("en-GB", "All");
  assert.ok(articles(all).some((card) => card.includes(DISPLAY_NAME_COURSE.title)), "All shows every published course, including unresolved categories (P4)");
  for (const filter of ["Society", "European Humanities", "Chinese Humanities", "Science", "社会科学"]) {
    const html = await renderCourses("en-GB", filter);
    assert.ok(!articles(html).some((card) => card.includes(DISPLAY_NAME_COURSE.title)), `?category=${filter} must not show a course whose categoryKey is a display name (P3: resolve by stable key only)`);
  }
});

// ---------------------------------------------------------------------------
// 3) P4 — unclassified only under All, no badge, no European Humanities fallback.
// ---------------------------------------------------------------------------

test("[S7][P4] categoryKey=null: only All shows the course, its card carries no category badge and never displays European Humanities", async () => {
  install({ store: storeFixture([UNCLASSIFIED_COURSE]) });
  const all = await renderCourses("zh-CN", "All");
  const cards = articles(all).filter((card) => card.includes(UNCLASSIFIED_COURSE.title));
  assert.equal(cards.length, 1, "All shows unclassified courses (P4)");
  assertNoCategoryBadge(cards[0], "unclassified card");
  for (const filter of ["Science", "Chinese Humanities", "European Humanities", "Society"]) {
    const html = await renderCourses("zh-CN", filter);
    assert.ok(!articles(html).some((card) => card.includes(UNCLASSIFIED_COURSE.title)), `?category=${filter} must not show an unclassified course (P4)`);
  }
});

// ---------------------------------------------------------------------------
// 4) P4 — unknown ?category= is empty; no default fallback.
// ---------------------------------------------------------------------------

test("[S7][P4] unknown ?category=ScienceX returns an empty list and does not fall back to a default category", async () => {
  install({ store: storeFixture([SOCIETY_COURSE, UNCLASSIFIED_COURSE]) });
  const html = await renderCourses("en-GB", "ScienceX");
  assert.equal(articles(html).length, 0, "unknown category value renders no course cards (P4)");
  assert.ok(html.includes(getMessages("en-GB").portal.noCourses), "the catalogue page renders its empty state for an unknown category");
});

// ---------------------------------------------------------------------------
// 5) P4 — footer links come from the Admin catalogue with stable-key params.
// ---------------------------------------------------------------------------

test("[S7][P4] footer category links come from the Admin catalogue (including Society) and hrefs use stable keys", async () => {
  install({ store: storeFixture([]) });
  for (const locale of ["en-GB", "zh-CN"] as const) {
    const html = await renderFooter(locale);
    const links = anchors(html).filter((anchor) => anchor.href.startsWith(`/${locale}/portal/courses?category=`));
    assert.ok(links.length > 0, `${locale}: footer renders category links from the catalogue, not from empty CMS content`);
    for (const entry of CATALOGUE) {
      const link = links.find((anchor) => anchor.href === `/${locale}/portal/courses?category=${encodeURIComponent(entry.name)}`);
      assert.ok(link, `${locale}: footer links ${entry.name} with the stable key as the query parameter (P4)`);
      assert.equal(link!.text, labelOf(entry.name, locale), `${locale}: footer label for ${entry.name} is the Admin localized name`);
    }
  }
});

// ---------------------------------------------------------------------------
// 6) P3/P4 — one resolver result across home, course detail and My Learning.
// ---------------------------------------------------------------------------

test("[S7][P3][P4] home card, course-detail breadcrumb/chip and My Learning card show the same resolved Society label", async () => {
  for (const locale of ["en-GB", "zh-CN"] as const) {
    const expected = labelOf("Society", locale);
    const commonStore = storeFixture([SOCIETY_COURSE]);

    install({ store: commonStore });
    const homeHtml = await renderHome(locale);
    const homeCard = articles(homeHtml).find((card) => card.includes('data-course-id="civic-life"'));
    assert.ok(homeCard, `${locale}: home renders a card for the Society course`);
    assert.ok(homeCard!.includes(expected), `${locale}: home card shows the resolved category label ${expected} (P4)`);

    const detailHtml = await renderDetail(locale, "civic-life");
    const chip = /<p[^>]*data-course-track="([^"]*)"[^>]*>([\s\S]*?)<\/p>/.exec(detailHtml);
    assert.ok(chip, `${locale}: course detail renders the category chip`);
    assert.equal(chip![1], "Society", `${locale}: the chip carries the stable key, not a display name (P3)`);
    assert.equal(stripTags(chip![2]), expected, `${locale}: the chip shows the resolved localized name`);
    const breadcrumb = anchors(detailHtml).find((anchor) => anchor.href === `/${locale}/portal/courses?category=Society`);
    assert.ok(breadcrumb, `${locale}: the breadcrumb category link uses the stable key in ?category= (P4)`);
    assert.equal(breadcrumb!.text, expected, `${locale}: the breadcrumb shows the resolved localized name`);
    assert.ok(!detailHtml.includes("European Humanities"), `${locale}: the course detail never renders the legacy European Humanities fallback (P4)`);

    install({ user: { id: "learner-1", nickname: "Learner" }, store: commonStore });
    const learningHtml = await renderLearning(locale);
    const learningCard = articles(learningHtml).find((card) => card.includes('data-overview-course="learning-record-society"'));
    assert.ok(learningCard, `${locale}: My Learning renders the course card`);
    assert.ok(learningCard!.includes(expected), `${locale}: My Learning shows the same resolved category label ${expected} (P4 same resolver)`);
    assert.ok(!learningCard!.includes("European Humanities"), `${locale}: My Learning never renders the legacy European Humanities fallback`);
  }
});

// ---------------------------------------------------------------------------
// 7) P8 — preview CTA derived from data; no hard-coded ids.
// ---------------------------------------------------------------------------

test("[S7][P8] the Start preview CTA links to the first public lesson of a published trial-enabled course and contains no hard-coded horatius ids", async () => {
  install({ store: storeFixture([SOCIETY_COURSE]) });
  for (const locale of ["en-GB", "zh-CN"] as const) {
    const html = await renderCourses(locale, "All");
    const cta = anchors(html).filter((anchor) => anchor.text === getMessages(locale).portal.startPreview);
    assert.equal(cta.length, 1, `${locale}: exactly one Start preview CTA is derived from the catalogue data (P8)`);
    assert.equal(cta[0].href, `/${locale}/portal/courses/civic-life/public-lesson?lessonId=social-contract`, `${locale}: the CTA points at the trial course's first public lesson`);
    assert.ok(!/horatius|lesson-21/i.test(html), `${locale}: no hard-coded preview course/lesson ids remain (P8)`);
  }
});

test("[S7][P8] the Start preview CTA is not rendered when no published course has both trial enabled and a public first lesson", async () => {
  install({ store: storeFixture([PUBLIC_BUT_NOT_TRIAL, TRIAL_BUT_NO_PUBLIC]) });
  const html = await renderCourses("en-GB", "All");
  const cta = anchors(html).filter((anchor) => anchor.text === getMessages("en-GB").portal.startPreview);
  assert.equal(cta.length, 0, "without an eligible trial course the CTA must be hidden (P8)");
});

// ---------------------------------------------------------------------------
// 8) I7/P3/P4/M8 — no legacy category fields or string fallbacks in data/render.
// ---------------------------------------------------------------------------

test("[S7][I7][P3][P4][M8] the Portal product projection exposes categoryKey only and never reconstructs legacy category fields", async () => {
  const { restore } = await isolate("lg-category-surfaces-store-");
  try {
    const store = await import("../../services/productStore");
    const assertContract = (courseValue: any) => {
      assert.equal(typeof courseValue.id, "string");
      assert.ok(!("category" in courseValue), `${courseValue.id}: ProductCourse must not construct the legacy category string (I7/P4)`);
      assert.ok(!("categoryId" in courseValue), `${courseValue.id}: ProductCourse must not construct the legacy categoryId field (I7)`);
      assert.ok(!("subjectId" in courseValue), `${courseValue.id}: subjectId is retired from the course contract (I7)`);
      assert.ok("categoryKey" in courseValue, `${courseValue.id}: ProductCourse carries the single categoryKey stable key (I7/P3)`);
      assert.ok(courseValue.categoryKey === null || typeof courseValue.categoryKey === "string", `${courseValue.id}: categoryKey is a stable key string or null`);
    };
    const published = await store.listPublishedCourses();
    assert.ok(published.length > 0, "the default store seeds at least one published course");
    published.forEach(assertContract);
    const seeded = await store.getProductCourse("epicureanism");
    assert.ok(seeded, "the seeded Epicureanism course is readable");
    assertContract(seeded);
    assert.equal((seeded as any).categoryKey, "European Humanities", "the seeded course keeps its stable category key (M3/M6), not a display fallback");
  } finally {
    await restore();
  }
});

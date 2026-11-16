import "./scripts/register-tsconfig-paths.cjs";
import { defineConfig } from "playwright/test";

const ci = Boolean(process.env.CI);
const port = ci ? 8080 : Number(process.env.E2E_PORT || 3012);
const baseURL = `http://127.0.0.1:${port}`;
const sessionSecret = "e2e-session-secret-at-least-32-chars!!";

const localEnv = {
  APP_ENV: "DEV",
  // DEV 默认把 localhost / 127.0.0.1 当作后台域名，会把产品页 307 到 Backoffice。
  // 与 playwright.studygroup.config.ts 一样，把后台域名钉到真实 admin 域，产品页才可达。
  ADMIN_HOSTS: "admin.ilovelearningguide.com,admin.sit.ilovelearningguide.com",
  // 课程封面在服务端用 S3 预签名（services/persistence/s3.ts）；本机没有凭据时
  // 页面会直接抛 CredentialsProviderError。占位键只让签名在本地算出来，不发起任何 AWS 请求。
  AWS_REGION: "ap-southeast-1",
  AWS_ACCESS_KEY_ID: "local-presign-only",
  AWS_SECRET_ACCESS_KEY: "local-presign-only",
  PAYMENT_MODE: "demo",
  LOCAL_SOCIAL_LOGIN: "1",
  STORAGE_BACKEND: "local",
  EMAIL_VERIFICATION_REQUIRED: "0",
  SESSION_SECRET: sessionSecret,
  APP_VERSION: "e2e",
};

const ciEnv = {
  NODE_ENV: "production",
  APP_ENV: "PROD",
  PAYMENT_MODE: "stripe",
  LOCAL_SOCIAL_LOGIN: "0",
  STORAGE_BACKEND: "local",
  SESSION_SECRET: sessionSecret,
  APP_VERSION: "e2e",
  HOSTNAME: "127.0.0.1",
  PORT: String(port),
  NEXT_PUBLIC_APP_URL: "https://e2e.local.test",
};

const chromium = { use: { browserName: "chromium" as const } };

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL,
    browserName: "chromium",
  },
  webServer: {
    command: ci
      ? `npm run start -- -p ${port}`
      : `npx next dev --hostname 127.0.0.1 -p ${port}`,
    url: ci ? `${baseURL}/en-GB/portal` : `${baseURL}/api/health`,
    // Always own the server, even locally. With `reuseExistingServer: true` Playwright
    // silently attached to whatever was already on the port; when a leftover `next dev`
    // died mid-run every later test failed with net::ERR_CONNECTION_REFUSED, which reads
    // as a product failure but is an environment one. Owning the process makes Playwright
    // surface a real webServer error instead. If a manual dev server holds the port this
    // now fails fast; stop it or run with `E2E_PORT=<free port>`.
    reuseExistingServer: false,
    timeout: 180_000,
    env: ci ? ciEnv : localEnv,
  },
  projects: [
    {
      name: "e2e-cloud",
      ...chromium,
      testMatch: [
        "**/E2E-B1-visitor-auth.spec.ts",
        "**/password-reset.spec.ts",
        "**/email-binding.spec.ts",
        "**/E2E-B1-negative.spec.ts",
        "**/PAY-stripe.skip.spec.ts",
      ],
    },
    // BUG-0348：公开页面的跨面一致性，不需要登录或外部服务。
    {
      name: "e2e-public-pages",
      ...chromium,
      testMatch: ["**/course-duration-consistency.spec.ts"],
    },
    // 本地专用，不计入 CI 门禁。这组依赖 demo 支付链路
    // （PAYMENT_MODE=demo、EMAIL_VERIFICATION_REQUIRED=0、`next dev`）和
    // /api/purchase/demo/confirm；CI 的 webServer 是 PAYMENT_MODE=stripe + APP_ENV=PROD，
    // 依赖不成立。这里始终注册项目，让 `--list` 在本地和 CI 都能枚举到它；真正的 CI
    // 排除写在用例里的显式 test.skip(Boolean(process.env.CI), 理由)，而不是把这个
    // project 从 projects 数组里静默删掉。ci.yml 目前不运行 test:e2e（现状，未改）。
    {
      name: "e2e-local-demo",
      ...chromium,
      testMatch: ["**/E2E-B1-purchase-learn.spec.ts"],
    },
  ],
});

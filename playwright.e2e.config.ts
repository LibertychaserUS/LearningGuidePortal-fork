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
    reuseExistingServer: !ci,
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
    ...(!ci
      ? [
          {
            name: "e2e-local-demo",
            ...chromium,
            testMatch: ["**/E2E-B1-purchase-learn.spec.ts"],
          },
        ]
      : []),
  ],
});

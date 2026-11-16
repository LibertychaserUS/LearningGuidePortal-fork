# 测试目录

- `unit/`：Rule Engine、价格、资格、状态转换、progress、Prompt/knowledge selection 等确定性规则。
- `integration/`：repository transaction、API contract、Stripe Webhook 去重、session 和权限。
- `e2e/`：Portal、注册、试用、购买、My Learning、Study、AI Tutor、双语页面和失败状态。

- `npm run test:unit` / `test:integration` / `test:ci`：tsc + unit + integration；GitHub Actions 用（云构建形态，不启 demo 服务器）。
- `npm run test:e2e`：本机 only（Playwright e2e，3012/本机站点；`webServer.reuseExistingServer: false`，每次自起 `next dev`，端口被占时直接报错而不是复用可能中途死掉的残留服务）。
- `e2e-local-demo`（`E2E-B1-purchase-learn.spec.ts`）：本地专用，不计入 CI 门禁。依赖 `PAYMENT_MODE=demo`、`EMAIL_VERIFICATION_REQUIRED=0` 和 `/api/purchase/demo/confirm`；CI 的 `next start` + `PAYMENT_MODE=stripe` / `APP_ENV=PROD` 不满足。`CI=1` 时由用例里的显式 `test.skip` 跳过，项目保持注册以便 `--list` 枚举。`.github/workflows/ci.yml` 目前不运行 `npm run test:e2e`（现状，未改）。
- `npm run test:local` / `smoke:product`：本机 only（3011 + DEV/demo 断言；不进 Actions）。

每条 PRD 的用户路径至少需要一个 service test 和一个 API/E2E test。上线前用同一组 smoke script 在 DEV、SIT、UAT、PPE/PROD 逐步运行。

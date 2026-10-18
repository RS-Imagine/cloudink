# 开发 CloudInk

唯一产品流程是单 Worker、单私有 R2 桶、一次性设置向导。用户通过 GitHub 与 Cloudflare 网页部署，本文中的工具仅供项目开发者使用。

## 本地构建

需要 Node.js 24、Rust 1.98.1 和 Chromium。构建脚本准备 Rust/WASM 工具链，版本由锁文件及 `rust-toolchain.toml` 管理。

```bash
npm ci
npm run build
npm run check
npx wrangler deploy --dry-run --outdir cloud-web/dist
```

根目录 `.dev.vars.example` 复制为 `.dev.vars`，填写本地测试用 `SETUP_TOKEN`，然后运行 `npx wrangler dev`，访问显示地址的 `/admin`。Wrangler 默认使用本地存储；开发过程中不要添加生产远程桶绑定。

`build` 始终构建通用模板，不读取个人配置或文章；`deploy` 只部署根目录的一个 Worker。`cloud-admin` 是内部模块，没有独立 Worker 配置。所有模块共享根配置生成的 `WebEnv` 类型；类型检查使用已提交的 `.dev.vars.example` 声明密钥名称，无需私人文件或生产凭据。

## 代码边界

- `cloud-web/src/index.ts`：使用根配置生成的 `WebEnv`，所有功能共享唯一 `STORAGE` 绑定。公开 URL 只对应固定页面与图片范围。
- `cloud-admin/src/auth.ts`：初始化口令校验、唯一账户条件写入、密码哈希、会话和账号修改。
- `cloud-admin/src/models.ts`：输入校验、文章原稿、设置和发布结构。
- `cloud-admin/src/image-library.ts`：分页图片目录、原稿引用索引、引用检查与受保护的物理删除。
- `cloud-admin/src/storage-mutations.ts`：协调引用内容修改与图片删除的 R2 条件写入租约，不增加 Cloudflare 资源或变量。
- `cloud-admin/src/media.ts`：允许访问的上传图片路径、类型识别和大小限制，以及公共图片响应。
- `cloud-admin/src/backup.ts`：受登录保护的备份清单、图片导入和原稿恢复；不导入账号或线上指针。
- `cloud-admin/src/browser-publishing.ts`：页面上传、完整性检查、取消和原子切换线上指针。
- `cloud-admin/src/publishing.ts`：发布快照准备与状态查询。
- `cloud-admin/ui`：首次设置、写作、网站设置、账号及备份界面；WASM 渲染运行在 Web Worker 中。
- `crates/blog-core` / `crates/blog-wasm`：原生与浏览器共用 Markdown、公式与页面生成。

根目录 `wrangler.jsonc` 是唯一部署配置。项目不提供多 Worker、双桶、本地后台或 Deploy Hook 发布模式。不要把个人部署配置、文章、实际凭据或维护记录放入仓库。

## 前后台排版与动效

正式前台的 HTML 在 `crates/blog-core/src/render.rs`，共享样式和交互在同目录的 `assets/styles.css` 与 `assets/client.js`。原生构建和浏览器 WASM 发布使用相同模板；后台文章预览也使用这份样式。

前后台与预览共享 `assets/design-tokens.css` 的明暗主题与墨绿/中性灰蓝主题色，
`assets/design-foundation.css` 提供按钮、输入、焦点与表面规则。
Rust 在编译期 include_str!，后台在 build-ui.mjs 拼接同一源，不复制颜色表。
旧页面的布局保持可用，CloudInk 2.0 的导航与页面重设计按 [阶段计划](design/UI-2.0-PLAN.md)推进。

唯一主题控制器 `assets/theme.js` 在 CSS 前执行，并按原有 URL 输出公开 /theme.js 与
后台 /admin-theme.js；系统模式为 auto，明确选择为 light/dark，沿用 localStorage.theme。
作者配色保存在既有网站设置的可选 `themePalette` 字段（ink/neutral）。
保存影响后台与预览，发布后应用到所有公开页；SSR 直接输出配色，Swup 同步后续页面配色。
后台缓存不覆盖公开页面。文章预览同步明暗与主题色到禁用脚本的 iframe，沿用公开字体与样式。
CSS 提供无脚本系统主题、普通圆角与不支持 color-mix 的回退，减少动态效果关闭过渡。

更新模板后，需要在后台重新发布内容才能生成使用新模板的公开页面；仅更新 Worker 不会覆盖桶中已发布的 HTML。无需新增配置项或迁移存储。浏览器检查覆盖搜索退出与焦点、主题、文章导航、移动目录、减少动态效果和窄屏溢出；CI 保存截图供视觉审查。

## 图片、阅读工具与搜索收录

前台响应由 `cloud-web/src/reader.ts` 补充图片加载属性和搜索元信息。第一张正文图片优先加载，后续图片原生延迟加载，图片异步解码。编辑器新上传且浏览器能够解码的图片会以带 `width/height` 的 HTML 图片插入原稿，供浏览器预留实际比例；已有 Markdown 图片和从图片库插入的图片仍可用，但缺少尺寸时不会猜测比例。本次不压缩图片，也不生成多尺寸版本。

图片放大和分享卡片使用原生 dialog，支持 Escape、关闭按钮及焦点恢复。代码支持复制与键盘横向滚动，表格可键盘滚动；手机目录提供关闭按钮、焦点约束和重复标题的独立锚点。剪贴板不可用时显示手动复制提示。

规范链接、Open Graph、Twitter 卡片及 JSON-LD 根据请求的域名生成，去掉查询参数并规范文章路径，支持 workers.dev 与自定义域名，无需新增变量。文章使用第一张 HTTP(S) 正文图片作为分享图；没有图片时使用文字摘要卡片。搜索引擎及社交平台是否展示和何时刷新由平台决定。同时启用多个域名时，各域名独立规范化；若要集中到唯一主域名，应在 Cloudflare 配置重定向。

`/sitemap.xml` 仅枚举当前线上版本的公开页面，包含首页、已发布文章及存在的关于页，排除草稿、后台和旧版本；取消发布后随提交切换。`/robots.txt` 提供站点地图地址并声明后台与 API 不抓取，访问控制仍由认证实现。404 响应标记 noindex。公开 HTML 的 ETag 包含渲染版本、域名和路径，避免更新元信息后误用旧缓存。

新上传图片尺寸及作者元信息需要重新发布页面；已发布页面的加载策略、分享元信息和站点地图在部署代码后生效。保持原有单 Worker、单桶部署，不创建额外服务。

## 单桶数据布局

| 路径                                  | 用途                       | 公开访问                |
| ------------------------------------- | -------------------------- | ----------------------- |
| `auth/account.json`、`auth/sessions/` | 账户与会话                 | 无                      |
| `drafts/`                             | 草稿                       | 无                      |
| `draft-site.json`                     | 待发布网站设置             | 无                      |
| `releases/`                           | 原稿和设置的发布快照       | 无                      |
| `state/`                              | 当前线上版本、进行中的发布 | 无直接对象访问          |
| `public/<版本>/`                      | 完整生成的公开页面         | Worker 根据线上指针提供 |
| `uploads/`                            | 上传图片                   | 受限图片路由            |

桶必须保持私有。目录前缀不是权限边界，公开路由不可直接代理任意桶对象。URL 解码后检查路径，图片类型限制为 JPEG、PNG、WebP、GIF、AVIF；不接受 SVG/HTML 上传作为图片。修改单桶路由时必须验证私有路径不可读取。

## 一致性与更新

初始化通过 R2 条件写入确保唯一账户。初次博客设置与账户一起保存，以便中断后通过正常登录继续；已有账户时初始化口令不再有效。密码采用带随机盐的 PBKDF2 哈希，会话 cookie 使用 HttpOnly、Secure、SameSite；写接口检查来源与 CSRF。

文章、设置和账号更新使用 ETag；发布先上传完整文件，再通过条件写入切换线上指针。取消与提交并发不能恢复已取消的发布。统计只使用校验过的 Clarity 项目 ID，默认关闭；公开 HTML 删除用户脚本和事件处理器，加载固定的项目脚本。

备份 ZIP 的原稿和图片包含 SHA-256 校验。恢复先校验清单，文章作为草稿导入，设置待发布；原有不同内容不覆盖，账户和线上指针不变。恢复多个对象不是跨对象事务，中断或冲突时可能已导入一部分，可处理冲突后重试。

代码更新不得清空桶、重置账号、替换用户设置或静默迁移绑定。新增数据格式时需要明确版本校验与兼容策略。

## 图片引用与删除

图片目录只枚举合法 `uploads/` 图片。删除检查当前线上版本、进行中的版本、草稿和待发布设置；过期发布快照不会作为线上引用。匹配会保守处理 Markdown、原始 HTML、绝对链接和编码路径，相同图片可供多篇文章共用。

新保存和恢复的原稿包含有界的 `image_refs` 元数据；超过 600 字节时回退到原稿检查。一次引用检查最多 2000 个原稿对象、32 MB 原文、30 个没有索引的对象，避免耗尽 Worker 请求预算。超限或对象异常时不声明图片未引用、不允许删除；目录仍提供预览与复用。

引用内容修改、备份恢复、发布切换和图片删除通过 R2 条件写入协调；租约正常完成后条件释放，异常中断最多阻塞 10 分钟。页面上传和普通读取不争抢租约。写入草稿、设置和恢复原稿前验证同源托管图片链接仍存在；外部图片链接和代码示例不强制要求本桶对象存在。不要在网页维护期间直接通过 Cloudflare 控制台修改同一桶对象；平台外的写入不参与应用租约。

不保存文章历史版本。旧版本留下的 `history/` 对象不再读取、备份或参与图片引用检查，也不会被自动删除。

这不是自动垃圾回收：没有删除旧发布快照的任务，也不会主动操作用户的图片。删除必须由已登录作者明确确认，且通过 CSRF、有效路径、ETag 和引用检查。

## 检查与测试

```bash
npm run format:check
npm run check
npm test
cargo test --workspace --locked
npm run test:web:browser
```

测试前完成上述构建。浏览器测试需要 Playwright Chromium，可在 `cloud-admin` 目录运行 `npx playwright install chromium`；也可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定已有 Chromium。

测试使用本地临时 R2，覆盖初始化、账号、单桶隔离、备份恢复、发布失败与并发、设置、图片、预览及浏览器完整流程。截图与测试 ZIP 写入被忽略的 `dist/`，不提交仓库。GitHub Actions 对 PR 执行同一套检查，不部署云端资源，也不使用生产凭据。

格式化使用 `npm run format`。改动 Worker 绑定后重新生成类型。提交前检查 `git diff --check`，并核对暂存文件，仅包含项目源代码、通用配置、文档和必要测试。

## UI 2.0 设计审阅

[执行计划](design/UI-2.0-PLAN.md)、[设计规范](design/UI-2.0-SYSTEM.md)与[现状审计](design/UI-2.0-AUDIT.md)记录分阶段 UI 升级。PR-00 的[四页交互原型](../prototypes/ui-2.0/README.md)独立于正式构建，使用通用演示内容。

完成项目构建后，安装 Playwright 的 Chromium、Firefox、WebKit，再运行 `npm run test:ui:audit`。截图对比、资源与实验性能报告生成在 `build-work/ui-audit`；CI 保存为 `ui-design-review` 附件。`npm run format:ui:check` 检查设计原型、规范与审计脚本格式。

实验不连接生产 R2，也不能替代真实 Safari、真机性能或人工视觉验收。每个设计阶段经确认后再接入正式界面。

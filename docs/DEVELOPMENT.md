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

## 单桶数据布局

| 路径                                  | 用途                       | 公开访问                |
| ------------------------------------- | -------------------------- | ----------------------- |
| `auth/account.json`、`auth/sessions/` | 账户与会话                 | 无                      |
| `drafts/`、`history/`                 | 草稿、历史                 | 无                      |
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

图片目录只枚举合法 `uploads/` 图片。删除检查当前线上版本、进行中的版本、草稿、历史和待发布设置；过期发布快照不会作为线上引用。匹配会保守处理 Markdown、原始 HTML、绝对链接和编码路径，相同图片可供多篇文章共用。

新保存和恢复的原稿及历史包含有界的 `image_refs` 元数据；超过 600 字节时回退到原稿检查。一次引用检查最多 2000 个原稿/历史对象、32 MB 原文、30 个没有索引的对象，避免耗尽 Worker 请求预算。超限或对象异常时不声明图片未引用、不允许删除；目录仍提供预览与复用。

引用内容修改、备份恢复、发布切换和图片删除通过 R2 条件写入协调；租约正常完成后条件释放，异常中断最多阻塞 10 分钟。页面上传和普通读取不争抢租约。写入草稿、设置和恢复原稿前验证托管图片仍存在，避免删除后保存失效引用。不要在网页维护期间直接通过 Cloudflare 控制台修改同一桶对象；平台外的写入不参与应用租约。

这不是自动垃圾回收：没有删除历史或旧发布快照的任务，也不会主动操作用户的图片。删除必须由已登录作者明确确认，且通过 CSRF、有效路径、ETag 和引用检查。

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

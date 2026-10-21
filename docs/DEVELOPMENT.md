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

前后台与预览共享 `assets/design-tokens.css` 的明暗主题与六套作者主题色（含棕褐 Brown），
`assets/design-foundation.css` 提供按钮、输入、焦点与表面规则。
Rust 在编译期 include_str!，后台在 build-ui.mjs 拼接同一源，不复制颜色表。
首页、阅读页、后台壳与写作工作流共享同一设计系统；[升级与验收](design/UI-2.0-RELEASE.md)记录最终回归、资源预算与回滚。

唯一主题控制器 `assets/theme.js` 在 CSS 前执行，并按原有 URL 输出公开 /theme.js 与
后台 /admin-theme.js；系统模式为 auto，明确选择为 light/dark，沿用 localStorage.theme。
网站图标使用可选的 `siteIcon` 字段，值仅接受 `uploads/icons/<SHA-256>.svg|ico` 内容地址。
`POST /api/site-icon` 沿用会话和 CSRF，限制 256 KiB；服务器校验 ICO 目录、像素/遮罩长度、PNG 数据块 CRC 和解压后的扫描行（总解码预算 4 MiB），并使用仅在 Worker 内打包的 `saxes` 校验 SVG XML 结构，再用静态 SVG 元素/属性白名单重写 SVG，移除脚本、样式表、事件、外部链接和嵌入内容。
SVG 的局部渐变/裁剪引用可保留；复杂 SVG 建议先导出为基本图形。公开 `/site-icon/<hash>.<ext>` 只映射图标专用键，使用正确 MIME、nosniff、sandbox CSP、ETag 和 immutable 缓存，不依赖 Referer。
后台、Rust/WASM 页面共用内容地址，更新图标即更新 URL；保存与公开发布仍分离。图标纳入既有图片库的设置/发布引用保护与 ZIP 备份，不新增存储桶或配置变量。
加入图标上传控件后的后台 JS gzip 护栏为 29 KiB；其他资源护栏不变，实测增量见对应 PR 的 CI 报告。

可选的云端真实运行检查：先在现有 Worker 的 Domains / Worker URL 中开启 Preview 网址并构建项目，在已认证的 Cloudflare Builds / CI 中设置专用的 `CLOUDINK_PREVIEW_STORAGE`（桶名必须以 `-test` 结尾），运行 `npm run test:icons:preview`。它只调用 `wrangler preview`，目标为既有 `cloudink` Worker 下的 `feat/custom-site-icon` 预览，不执行生产部署。更名的 Worker 可通过测试专用的 `CLOUDINK_PREVIEW_WORKER` 指定。临时配置仅写入被忽略的 `build-work/`，结束后删除；初始化口令随机生成并隐藏。真实边缘测试覆盖 SVG/ICO 上传、WASM 发布、保存隔离、恢复默认与备份恢复。如果 Preview 使用 Cloudflare Access，CI 还需注入已获授权的 `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` 服务凭据；未授权访问返回登录页时测试会明确失败。上述变量仅供可选 CI 测试，不是网站部署所需配置。

作者配色保存在既有网站设置的可选 `themePalette` 字段（ink/neutral/brown/blue/violet/rose）。
后台通过有可访问名称、选中标记及焦点环的原生单选色块选择，强制颜色模式显示名称和原生控件。
保存影响后台与预览，发布后应用到所有公开页；SSR 直接输出配色，Swup 同步后续页面配色。
后台缓存不覆盖公开页面。文章预览同步明暗与主题色到禁用脚本的 iframe，沿用公开字体与样式。
CSS 提供无脚本系统主题、普通圆角与不支持 color-mix 的回退，减少动态效果关闭过渡。

更新模板后，需要在后台重新发布内容才能生成使用新模板的公开页面；仅更新 Worker 不会覆盖桶中已发布的 HTML。无需新增配置项或迁移存储。浏览器检查覆盖搜索退出与焦点、主题、文章导航、移动目录、减少动态效果和窄屏溢出；CI 保存截图供视觉审查。

## 首页与全局导航

`crates/blog-core/src/assets/home.css` 负责首页与新页眉/页脚，随 Rust 原生/WASM 共用样式输出。
首页只消费既有站点信息与已发布文章：第一篇为大卡，其余响应式网格；CSS 山形是装饰，
不是文章封面，不读取正文大图。无需新增配置。
手机菜单使用原生 details，JavaScript 增强 Escape、外部点击与路由清理；
无脚本时菜单及原有链接仍可操作。主内容包含跳转入口、唯一 h1 与 SSR 导航状态。
品牌文本结构变更同步更新分享卡片与 HTMLRewriter 的站点名读取，保留旧发布页的选择器。

阅读正文由 reader.css 统一控制，全局首页样式与组件基础共用现有 Token。
`npm run test:ui:audit` 同时验证三引擎首页、320/360/390px、长文本、键盘与无脚本导航；
实际 Safari/iOS、200% 浏览器缩放与真机观感仍需人工检查。

## 共享动效

`assets/motion.js` 提供 CloudInkMotion，前台原生/浏览器构建与后台打包共享同一源，
`assets/motion.css` 追加到前后台样式中。没有额外请求、依赖或动画框架。
详情及取消/清理契约见 [设计规范](design/UI-2.0-SYSTEM.md)。
按钮按压使用物理弹簧，过渡使用 WAAPI/CSS；业务保存、发布和认证状态由原有逻辑控制。
不要让动画完成回调写入草稿、触发发布或替换编辑器 DOM。

`npm test` 含解析轨迹、能量衰减、速度衔接、取消、单 rAF、可见性与减少动态效果测试。
`npm run test:ui:audit` 含三引擎的真实 DOM 按压、原生弹窗反向、取消与无 WAAPI 回退；
审阅包的 motion.html 可离线体验正式动效。

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

## 阅读界面回归

PR-04 的正文与阅读工具样式在 blog-core 的 reader.css，随 Rust/WASM 模板生成公开页面。
后台预览使用相同样式；调整预览的隐藏规则时，仅选择站点页眉/页脚，不能隐藏文章的 header。
目录以 1100px 为分界，桌面右侧静态列、窄屏浮动入口；移动面板共享 mobile.js 的手势系统。

三引擎隔离审计包含目录锚点/焦点、初始深链、搜索加载中输入、快速重开、
失败后重试、文本高亮安全、键盘选择、浏览器前进/后退及无脚本正文访问。
阅读 CSS 单独压缩预算为 4 KiB；资源与实验截图记录在 ui-design-review 附件。
真实 Safari/iOS、软键盘和真机性能仍需对应阶段的人工检查。

## 后台布局回归

后台外壳样式为 cloud-admin/ui/studio.css，由 build-ui.mjs 拼接到同一份 /style.css，
不新增资源请求；shell.js 只处理原生折叠菜单和界面快捷入口。
主导航仍由 app.js 的已有保存/导航保护执行，不能用单纯隐藏视图绕过 flush。

文章切换菜单默认关闭。浏览器测试使用 openPostSwitcher 后选择 .post-item；
切换延迟的计时从菜单已打开后开始，仍覆盖保存/获取并行和缓存命中。
三引擎审计包含登录错误与重试、初始化两步焦点、全部/草稿/已发布筛选、
空结果、主导航、菜单 Esc/焦点、窄屏触控入口及跨视图草稿保存。
所有截图仍来自临时 Miniflare；后台壳 CSS 单独压缩预算为 4 KiB。
审计使用本地 HTTPS 测试证书，浏览器仅在测试上下文接受该证书，
以便 WebKit 也能验证真实的 Secure/HttpOnly 会话；不修改生产 Cookie 或认证规则。

## 写作工作流回归

后台 workflows.css 追加到既有 /style.css，workflows.js 提供视图、就近反馈与统一确认弹窗。
正文 textarea 和预览 iframe 始终复用同一节点；视图切换不能改写原稿、重置选区或触发发布。
saveCurrent、flush、发布与图片引用保护仍由原有工作流维护，不在动效回调执行数据操作。

确认弹窗采用原生 dialog；测试使用 acceptConfirmation 明确操作，
不能用浏览器 dialog 事件跳过网页确认。取消与 Escape 均不得执行删除或恢复。
三引擎 workflows.browser.mjs 覆盖保存失败/重试、视图与选区、窄屏操作、图片库加载失败/重试、
引用保护、弹窗焦点与取消、设置及备份错误。原有完整浏览器流程仍验证发布、恢复与图片物理删除。
审阅包还包含 workflow-editor/images/settings/confirmation 开头的截图。
工作流 CSS 单独 minify 后 gzip 预算为 4 KiB；最终资源影响记录在对应 PR 与审计报告。

## 移动交互回归

共享 mobile.js/mobile.css 通过现有前后台资源构建输出，原生与 WASM 使用同一实现。
data-sheet 标记的原生 dialog 由 CloudInkMotion 接入手机面板；目录使用相同控制器与原有导航清理。
面板只改变布局与展示，不能在关闭回调中执行删除、发布或保存。

移动后台菜单临时移动原有 panel/search 节点，关闭、导航与断点变化后还原。
修改 shell 时必须覆盖原生弹窗的背景 inert、Esc/焦点、重复开关和无重复 ID。
移动面板新增单独压缩预算 5 KiB（JS+CSS），共享动效原有预算不变。
自动检查包含释放方向与速度、拖拽/取消、停靠、键盘替代、原生内容滚动、
横竖屏/尺寸变化和 viewport 键盘尺寸模拟；真实移动输入法与 Safari 仍需真机验收。

## 表面增强回归

assets/expressive.css 通过原有 Rust/WASM 和后台构建共享，格式检查与 2KiB minified gzip 预算覆盖新增样式。
theme.js 复用阻塞式引导，主题与效果 bootstrap 合计 gzip 预算 2KiB。
视觉效果是本浏览器偏好，不写入站点设置，也不需要发布才生效；公开模板代码更新后仍按既有流程重发内容。
运行 npm run test:ui:audit 验证 Chromium、Firefox、WebKit 的效果/不透明比较、合成对比度、面积、关闭与降级。
report.json 的 surfaces 包含 4× CPU 滚动帧样本；它是实验记录，不能作为真实 GPU 或输入延迟的结论。
原型 prototypes/ui-2.0/surfaces.html 只使用共享资源和本地示例，审阅包可直接解压打开。

## UI 发布候选收尾

release.browser.mjs 在三引擎 360px 下施加文字间距覆盖，验证公开阅读/搜索、登录、工作台、图片和设置重排。
mobile.browser.mjs 覆盖键盘视口缩小、缩放几何变化和键盘收起；不得用它宣称已经通过真实输入法测试。
ui-audit 的 releaseBudgets 同时限制实际公开/后台 bundle、预览 Worker 和 WASM；不是只测各模块文件。
需要调整预算时，提供具体 gzip 增量、视觉收益及原始报告，不通过放宽上限掩盖异常增长。

清理 CSS 前检查 render.rs、前后台交互与原型的实际引用。目录仍使用 zoom-overlay，搜索仍保留旧模板回退，
不能按历史名称批量删除。新增颜色/交互继续使用共享来源，不在页面样式中复制主题表。
截图解压包中的原型是设计参考；升级前后对比使用 PR-00 的同尺寸正式页面截图。
完整发布、人工验收和回滚步骤见 [UI 升级指南](design/UI-2.0-RELEASE.md)。

## UI 2.0 最终交付与复查

PR-00 至 PR-09 已完成代码合并，设计规范作为后续维护约束，不再描述待迁移的页面。
completion.browser.mjs 补充启动、配置/会话/首次读取失败重试、卡片键盘导航、登录/退出和预览断点焦点，
仅使用本地示例和临时会话；不改变 Cookie、CSRF、自动保存或发布算法。
后台启动需要等待配置与会话检查，展示失败状态时不得伪造登录成功或退出登录。

在 GitHub **Actions → Project checks → Run workflow** 可从任一分支运行完整检查与三引擎 UI 审阅，
无须本地克隆或生产凭据。审阅包包含主要页面、全部补充截图目录与离线动效演示。
测试每次清空生成的 build-work/ui-audit 输出，避免把旧截图当作当前提交的结果。
真实终端、辅助技术及能耗没有使用模拟结果替代；边界与人工清单见 UI 升级指南。

## Markdown 导入

导入转换位于 blog-core 的 import 模块，通过既有浏览器 Worker / WASM 执行；保存仍提交结构化 draft 并使用现有认证、CSRF 和 ETag。持久化原稿、备份及发布继续使用严格的 TOML 格式，不迁移 R2 数据，也不放宽备份解析。

普通 Markdown 无需头信息。未提供标题时，将文档开头真实的一级标题移入标题栏，否则使用去除扩展名的文件名；正文中的代码、分隔线和后续标题保留。含图片、链接、HTML、公式、脚注、显式锚点或超过标题长度上限的一级标题保留在正文，使用文件名作为标题，避免导入时丢失内容。没有日期时使用浏览器本地的今天，摘要可留空。可选的 +++ TOML 可以只填写部分文章信息；已提供的标题、日期、摘要和更新日期保留。错误的显式 TOML/日期会显示该文件的失败原因，不吞掉正文。YAML 头信息本期不做元数据转换。

导入始终新建草稿、强制 draft=true 并生成新 slug，包括带旧 slug 的 CloudInk 原稿；不把导入文件作为覆盖指令。完整迁移需使用网站备份恢复。每批最多 100 个 UTF-8 文件，单个最多 1,000,000 字节。单文件成功后直接打开；多文件逐个处理、分别展示结果，单项失败不影响其余文件。取消等待当前写入完成，跳过后续文件，不删除已保存的草稿。

图片上传期间不启动 Markdown 导入，避免锁定编辑器后阻止图片链接插入。导入前先保存当前编辑内容；遇到保存失败或并发冲突时，整个导入在写入前停止。浏览器回归覆盖三引擎实际文件上传、新地址和不自动发布、逐项错误、取消与原稿冲突、窄屏明暗截图及测试数据清理。Rust 测试覆盖可选信息、一级标题解析、UTF-8 字符长度、日期和内容保留。

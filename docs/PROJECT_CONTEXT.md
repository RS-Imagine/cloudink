# r-blog 项目接续记录

记录日期：2026-10-01，Asia/Shanghai。本文记录已确认的需求、实现和交接时状态；后续维护应更新本文，并重新核对线上配置。

## 项目目标与最终方案

解决个人博客新增、修改文章时需要手动生成网页、操作 Git 分支和部署的问题。保留 Rust 静态前台，增加浏览器里的私人写作后台。

最终确认的产品要求：

- 后台仅供站点所有者使用，采用指定邮箱和密码登录，不开放注册。
- 继续使用 Markdown，预览应与发布后的 Rust 排版一致，包括数学公式和代码。
- 接受发布后的构建等待，后台应明确显示处理中、已上线和失败状态。
- Markdown 原稿、草稿和历史记录直接保存在 Cloudflare，GitHub 用于项目代码。
- 保存草稿不改变线上文章；发布一篇文章不能顺带发布其他草稿。
- 支持上传、拖入和粘贴图片，导入已有 Markdown，以及导出原稿备份。
- 保留原网站的设计、文章地址、历史页面、图片、搜索及公式渲染。

早期讨论中曾建议 GitHub 保存文章，后续已明确改为私有 R2。早期 `forimagine` 分支部署生成好的 `public/` 的配置已被新的构建流程替代，不应作为当前方案。

接续工作中已核实 Pages 生产分支及部署来源均为 `master`。旧分支 `forimagine` 随后已按要求直接删除，不再作为部署或迁移备份入口；删除前末次提交为 `6ec057576fcaaeb7f6f9c8a66ea898a7490a7953`，未另建备份标签。

## 服务与资源

| 资源 | 当前用途 |
| --- | --- |
| GitHub `RS-Imagine/r-blog` | 项目代码，生产分支 `master` |
| `https://forimagine.eu.org`、`www.forimagine.eu.org` | 公开博客 |
| Worker `r-blog` | Workers Builds + Static Assets，公开博客 |
| 原 Cloudflare Pages `r-blog` | 所有者要求删除，项目与历史部署已删除 |
| `https://admin.forimagine.eu.org` | 私人写作后台 |
| Worker `r-blog-admin` | 登录、编辑、R2 保存、上传和发布接口 |
| 私有 R2 桶 `r-blog-content` | 原稿、草稿、历史、网站配置及不可变发布快照 |
| R2 桶 `images-blog` | 已有及新上传图片 |
| Worker `image-hosting`、`img.forimagine.eu.org` | 现有图片服务，维持原访问限制 |

原系统将生成后的 HTML 提交到 `forimagine`；Markdown 原稿保存在所有者电脑上。迁移时保留了 10 篇既有文章的 HTML，以及本地图片。没有将 HTML 伪造为 Markdown 原稿。旧文章需要导入原始 `.md` 后才能在线修改；导入必须保留原 `slug`，且不会自动发布。

## 当前启用状态

首次密码设置、Deploy Hook 配置和生产发布流程已经完成，并在原聊天中核实。不能再将这些项目列为待启用步骤，也不要重新生成初始化链接、重置密码或让所有者重复配置 Hook。

后台所有者邮箱是 `imagine@forimagine.eu.org`，密码由所有者自行设置。本文不保存密码、初始化链接或任何密钥。

## 日常写作操作

1. 登录后台，新建或打开文章，编辑标题、摘要和正文。
2. 填写标题后会自动保存；也可点击保存草稿或按 Ctrl/Cmd + S。
3. 上传、粘贴或拖入图片，系统插入图片链接。
4. 查看页面预览，满意后点击“发布这篇”。
5. 等待“最新发布已上线”，再检查公开网站。

恢复历史版本会保存为草稿，仍需发布才能更新线上内容。取消发布移除公开页面但保留原稿和历史。导出全部原稿生成 ZIP，图片需要另外备份。网站设置可管理标题、副标题、作者信息、密码和发布连接。

## 实现与关键保护

- `crates/blog-core`：Markdown、数学、模板及静态生成。
- `crates/sitegen`：静态构建入口，支持指定内容与输出目录。
- `crates/blog-wasm`：浏览器预览及 Markdown 导入解析，共用 Rust 核心。
- `crates/admin`：保留原本机 Axum 后台。
- `cloud-admin/src`：Worker API、认证、R2 内容和发布逻辑。
- `cloud-admin/ui`：后台界面、预览协调器和预览 Web Worker。
- `scripts/cloudflare-build.sh`：Cloudflare 构建时从 R2 发布快照读取内容，再运行 Rust。

发布生成不可变快照；只有线上 `_release.json` 与目标发布 ID 相符，才确认更新已发布版本。构建失败应保留原稿和上次成功的线上内容。草稿不能经公开文章地址、首页或搜索泄露。R2 ETag 防止多个编辑窗口相互覆盖；冲突时必须保留编辑器中的文字。

认证采用加盐 PBKDF2 密码哈希、HttpOnly/Secure 会话、CSRF 校验和登录限速。私有文章桶没有公开访问。图片支持 JPEG、PNG、WebP、GIF、AVIF，单张最多 10 MB；当前发布快照最多 16 MB。

不要提交 `content/`、`public/`、`build-work/`、生成资产、构建产物、密钥或私有内容。不要更换或放宽现有图片访问策略来完成后台改动。

## 已上线的后台体验优化

针对切换文章卡顿、按钮反馈迟钝的问题，已实现：

- 缓存最近访问的文章，保存当前内容与读取下一篇并行执行。
- 快速连续点击时，以最后选择为准；失败或冲突时不丢弃编辑内容。
- 预览计算和代码高亮移入 Web Worker，先显示正文，再下载图片。
- 图片预览最多同时下载三张，提供有界缓存。
- 保存后在本地更新文章列表，避免额外读取全部文章。
- 发布未进行时停止持续查询状态，隐藏页面暂停状态查询。
- 保存、下载、历史、恢复、上传、删除和发布提供明确反馈。
- 静态资源使用 ETag 重新校验；兼容 Cloudflare 压缩返回的弱 ETag，以及多项和通配校验条件。
- 预览框架允许父页面填入图片，但始终不允许预览脚本执行。

本地慢网络测试条件：保存 500 ms、读取文章 700 ms、读取全列表 1500 ms。首次切换从旧版 2883 ms 降为 832 ms，缓存切换为 62 ms。数字是本地模拟结果，不是所有用户网络环境的保证。

## 交接时已验证的版本

| 项目 | 记录 |
| --- | --- |
| 初始私人后台提交 | `ee8e15f6176e4185042c8fa01e913d61f47a69c2` |
| 后台体验优化提交 | `13cccbbe8e6564a1e9d87ff4c7a3dee8d233a928` |
| Cloudflare 弱 ETag 修正 | `a0bd1b57f39e19bd9580e6fa71683190bf6865b1` |
| Worker 最终版本 | `97d02712-ff20-42c2-a63d-21d89841d1bd`，100% 流量 |
| Worker 部署时间 | 2026-10-01 22:14:56，Asia/Shanghai |
| Pages 生产部署 | `b87d0e21-8cc6-4022-9665-6834fbc1bcec`，成功，源码为 `a0bd1b57…` |

类型检查、Worker 构建、7 项 Miniflare 集成测试和浏览器回归测试通过。线上 HTML 主体、JavaScript、CSS 和 WASM 与构建一致；预览线程缓存校验返回 304；未登录访问文章、私有图片和内部内容接口均返回 401。HTML 可包含 Cloudflare 自动注入的检测脚本；压缩后的 ETag 可有 `W/` 前缀，因此线上不能机械要求完整 HTML 哈希或强 ETag 格式完全一致。

原聊天因云执行器故障未能提交体验优化；后续已经从其命令记录恢复、验证、提交并上线。该部署任务没有待补交的修改。

## Pages → Workers 迁移（2026-10-01 UTC）

所有者明确授权公开博客迁移 Workers，尚未选定项目新名字，仓库和服务仍使用 `r-blog`。

- 迁移实现提交：`ccc18816ccfaa32624afd9d14bc96f3c88935cb8`；后续配置和文档提交应以 GitHub `master` 为准。
- 私人后台版本：`cd28be5e-cba1-436d-aa4b-6a63d90733b4`，100% 流量；上传前校验本地完整构建 SHA-256，既有 secret、R2、限速和监控绑定均继承。
- 公开 Worker 首次成功版本：`a59b46aa-1930-4ad6-8d83-7100defd8ca4`；Workers Builds 验证构建 `0762ce65-de70-4473-8e0b-adf293bec917` 成功。
- 部署 Hook 实际触发构建 `9d73de69-d44f-482e-a835-d20e9e2807f1`，也成功。只重建现有快照，没有为了测试发布新文章或修改草稿。
- `forimagine.eu.org`、`www.forimagine.eu.org` 已绑定公开 Worker `r-blog`；临时地址 `https://r-blog.rs-imagine.workers.dev`。
- 迁移验收时曾保留旧 Pages 作为回退；随后所有者明确要求删除，Pages 项目和历史部署已删除，`r-blog-2ht.pages.dev` 不再可作回退。
- 验证：构建、类型检查、9 项本地 Miniflare 集成测试、浏览器回归通过。临时地址核对 20 个公开路径、首页和全部 11 篇公开文章正文、样式与搜索索引，发布 ID 与旧站一致。关于页面差异来自域名上的 Cloudflare 邮箱保护；脚本属性和页尾差异来自 Rocket Loader 与自动注入代码。
- 新增凭据 `WORKERS_BUILD_TOKEN`、`WORKERS_DEPLOY_HOOK` 保存在 Cloudflare secret；没有轮换旧 `BUILD_TOKEN`，R2 的原 Pages Hook 保留加密副本。

以上版本和构建 ID 是历史验收记录，下一次维护仍须查询当前部署。

## 构建、测试与部署

公开 Worker `r-blog`：Workers Builds 连接 `master`，仓库根目录 `/`；构建命令 `bash scripts/cloudflare-build.sh`，部署命令 `npm run deploy`，静态输出 `build-work/public`，根目录锁定 Wrangler。构建环境 `BLOG_ADMIN_URL` 和 secret `BLOG_BUILD_TOKEN` 与后台新增的 secret `WORKERS_BUILD_TOKEN` 对应。后台 secret `WORKERS_DEPLOY_HOOK` 触发 Workers Builds，并让 UI 显示已连接；所有者无需再配置链接。

旧 Pages 项目已按所有者要求删除，没有 Pages 回退部署。后台仍保留旧 `BUILD_TOKEN` 与 R2 中加密的旧 Hook 作为兼容遗留配置，当前发布只使用 Workers 凭据。`SETUP_TOKEN` 保留受控初始化用途，不重新初始化账户。发布依旧通过线上 `_release.json` 确认部署完成，而不是仅依赖构建成功。不要输出或记录任何凭据与 Hook。

不要尝试使用旧 Pages Hook 回退；对应项目已删除。后续恢复应使用 Workers 部署历史与 R2 发布快照，保留当前 Workers 发布连接。

后台 Rust 工具链为 1.98.1，目标 `wasm32-unknown-unknown`，wasm-pack 0.15；使用锁文件中的 npm 依赖。完整后台构建：

```bash
npm --prefix cloud-admin ci
bash scripts/build-admin.sh
```

已有匹配的 WASM 时，可直接 `npm --prefix cloud-admin run build` 重新打包 UI 和 Worker。

针对后台变更的验证：

```bash
npm --prefix cloud-admin run check
npm --prefix cloud-admin test
npm --prefix cloud-admin run test:browser
```

修改 Rust 核心时还应运行 `cargo test --workspace`，重新构建 WASM。浏览器测试可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定已安装 Chromium；`COMPARE_BASELINE=1` 会与旧版比较慢网络切换性能。测试使用本地 R2 和测试凭据，不接触生产文章。

部署前检查远端分支和线上当前版本，提交精确源码，并使用其构建上传。保留原有 R2、图片、限速、域名、监控和密钥绑定。平台迁移须由所有者明确授权；本次已授权 Pages → Workers。不要轮换账户密码或改写文章。

## 可复刻部署通用化

所有者选择配置文件、脚本和教程方案；允许新用户先使用 workers.dev，自定义域名可选。每个复刻者仍只有自己的站点作者账号。

- `deployment.example.json` 提供通用配置，个人 `deployment.json` 和生成的 `.deploy/` 默认不提交 Git。
- 支持 `BLOG_DEPLOY_CONFIG_JSON` 构建变量，或 `BLOG_DEPLOY_CONFIG` 指向用户自己的非密钥文件。生成的配置分别管理公开、后台和图片 Worker。
- 根目录和两个 Worker 的 Wrangler 文件改为通用开发模板。正式部署使用生成的配置与 `npm run deploy`、`deploy:admin`、`deploy:images`。
- 当前维护站点的正式配置外置到 Cloudflare Builds 的非密钥 JSON 变量，本地副本被 Git 忽略；原域名、Worker 名、桶、邮箱、页脚和统计账号继续使用原值。`externalImages: true` 防止部署脚本替换独立图片服务。
- 后台前端从 `/api/config` 读取公开地址、图片地址、分支和显示配置，没有固定作者邮箱或旧站链接；该接口不返回密钥或作者邮箱。
- 新站可用 setup 脚本生成并写入随机 secret，初始化空白 R2 快照及 About，再设置唯一作者密码。已有账号和发布版本均拒绝重复初始化，不迁移或覆盖现有文章。
- `cloud-images` 提供可复刻的私有 R2 图片 Worker；仅允许指定博客来源引用、流式响应和条件缓存。现有 `image-hosting` 保持独立。
- 页脚按作者或配置生成，Clarity 默认关闭；维护站点的原统计 ID 通过外置配置继续使用。
- 公开和后台各自的 Workers Builds 可从源码部署；日常文章发布仅触发公开 Worker。构建变量与运行变量分开，secret 不能存入部署 JSON。
- 安装、免费地址、自定义域名、自动构建、验收及现有站点升级说明见 `docs/DEPLOYMENT.md`。不要对现有站点运行新站 setup:secrets。

### 通用化验收记录（2026-10-01 UTC）

- 实现提交 `3a3a2267539c6b50f6d8c4e4882f7e2e7c84c3bf`；初始化与校验完善提交 `c3bdc891eb92fbbec87fc581a675dceda0740ed4`。
- 本地类型检查、Rust 测试、10 项后台集成测试、3 项配置/图片服务测试及浏览器回归通过。浏览器使用不同作者邮箱和域名，验证初始化后退出再登录、旧文章链接及图片预览不依赖维护者地址。
- 公开 Workers Builds `47ba5f76-be50-4c4e-81d0-e9288aac5ec1` 成功，版本 `9f5183c9-763a-445c-8097-4bad67cbd9ca`。
- 后台 Workers Builds `13c5683f-757b-479c-b7e2-92f59b5e570d` 成功，版本 `15ba177c-d19e-42bf-8c06-3a7b79ea6235`。此前一次上传遇到 Cloudflare 10013，后续构建成功，不是仍待修复的后台部署。
- 两个构建均来自 `c3bdc89…`；没有通过新站 setup 重置现有密码或改写文章。线上 API/config 确认实际域名、分支、署名和统计设置来自外置配置；前端脚本与本地构建一致，未登录私有内容接口仍返回 401。

## 本次接续环境的经验

以下是 2026-10-01 会话环境的观察，不能假定未来仍成立：

- 项目位于 `/workspace/r-blog`。
- 工具环境脚本为 `/workspace/.cloud-tools/r-blog-env.sh`；可在该文件存在时加载。
- 默认沙箱禁止本地服务监听，并曾阻止代理连接。相应本地测试和网络命令使用工具支持的权限提升后可运行；不要将沙箱拒绝误判为代码或凭据失效。
- GitHub CLI 在允许网络的环境中可通过已配置身份认证。Cloudflare 连接器可用，但 Wrangler 未登录；这不表示需要所有者重连 Cloudflare 或提供 token。
- 本次通过 Cloudflare 连接器部署经过 SHA-256 校验的精确本地构建，继承既有密钥，并验证新版本和线上文件。以后优先使用实际可用的认证路径。
- 删除旧聊天不应使维护依赖其历史消息；以 GitHub 中的源码、本文、README 和重新核对的线上状态为依据。

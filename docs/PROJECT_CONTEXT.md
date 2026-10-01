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

## 服务与资源

| 资源 | 当前用途 |
| --- | --- |
| GitHub `RS-Imagine/r-blog` | 项目代码，生产分支 `master` |
| `https://forimagine.eu.org`、`www.forimagine.eu.org` | 公开博客 |
| Cloudflare Pages `r-blog` | Rust 静态网站构建与托管 |
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
- `scripts/cloudflare-build.sh`：Pages 从 R2 发布快照读取内容，再运行 Rust。

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

## 构建、测试与部署

Pages 生产代码分支：`master`；仓库根目录构建；命令 `bash scripts/cloudflare-build.sh`；输出 `build-work/public`。生产和预览环境使用 `BLOG_ADMIN_URL` 及 secret `BLOG_BUILD_TOKEN`。Worker 的 `BUILD_TOKEN` 应与 Pages 对应值一致，`SETUP_TOKEN` 用于受控初始化。发布 Hook 已加密保存于私有 R2，不要读取或记录明文。

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

部署前检查远端分支和线上当前版本，提交精确源码，并使用其构建上传。保留原有 R2、图片、限速、域名、监控和密钥绑定。不要为了部署创建另一个站点、迁移平台、轮换账户密码或改写文章。

## 本次接续环境的经验

以下是 2026-10-01 会话环境的观察，不能假定未来仍成立：

- 项目位于 `/workspace/r-blog`。
- 工具环境脚本为 `/workspace/.cloud-tools/r-blog-env.sh`；可在该文件存在时加载。
- 默认沙箱禁止本地服务监听，并曾阻止代理连接。相应本地测试和网络命令使用工具支持的权限提升后可运行；不要将沙箱拒绝误判为代码或凭据失效。
- GitHub CLI 在允许网络的环境中可通过已配置身份认证。Cloudflare 连接器可用，但 Wrangler 未登录；这不表示需要所有者重连 Cloudflare 或提供 token。
- 本次通过 Cloudflare 连接器部署经过 SHA-256 校验的精确本地构建，继承既有密钥，并验证新版本和线上文件。以后优先使用实际可用的认证路径。
- 删除旧聊天不应使维护依赖其历史消息；以 GitHub 中的源码、本文、README 和重新核对的线上状态为依据。

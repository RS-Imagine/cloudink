<div align="center">
  <img src="assets/cloudink.svg" width="88" height="88" alt="CloudInk 云砚图标">
  <h1>CloudInk · 云砚</h1>
  <p>依托 Cloudflare 的个人博客，在浏览器里完成部署、写作和管理。</p>
</div>

CloudInk 使用一个 Worker 和一个私有 R2 存储桶，提供博客、管理后台、图片与文章发布。只需 GitHub 和 Cloudflare 账号，无需本地克隆、编辑 JSON 或安装开发工具；自己的域名可选。

## 三步开始

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/RS-Imagine/cloudink)

1. **点击部署**：授权 GitHub 与 Cloudflare，自动创建 Worker、存储桶和构建连接。
2. **填一个初始化口令**：`SETUP_TOKEN`，自选 16–128 字符，保存为 Cloudflare Secret。
3. **打开 `/admin`**：在首次设置向导填写口令、登录邮箱、登录密码和博客名称。向导创建唯一账号，并生成博客首页。

以后通过后台管理网站设置、文章、图片、账号和备份。邮箱只是登录账号，不需要接入邮件服务。完整步骤与故障处理见 [部署教程](docs/DEPLOYMENT.md)。

## 写作与设置

- Markdown 在线编辑、自动保存、图片拖放与粘贴。普通 `.md` / `.markdown` 可直接导入，不需要头信息；也支持可选的 `+++` TOML 信息。自动补齐标题与日期，每份文件新建草稿并分配新地址，不替换已有文章。
- 导入支持逐文件进度、失败原因和取消后续文件；单文件成功后直接打开编辑器，批量结果可逐篇打开。每批最多 100 份 UTF-8 文件，单份最多 1 MB。
- 图片库支持批量上传、预览、筛选、复制链接和插入文章；上传时自动生成 WebP 多尺寸版本，阅读时按屏幕加载，点击放大查看原图。未引用图片连同压缩版本一起删除。已有图片可在图片库批量优化，支持暂停与续跑，再单独更新已发布页面。
- 文章地址可在编辑器中修改：草稿改址不发布，已发布文章改址沿用发布流程，旧链接自动跳转。
- Rust / WASM 共用排版引擎，支持数学公式、代码高亮、搜索、明暗主题和图片预览。阅读资源按内容加载，公式样式与字体由本站提供；平滑导航失败时保留当前文章并提供重试。
- 草稿保存与发布分开，发布前确认，发布一篇文章不会连带发布其他草稿。
- 标题、副标题、作者、页脚、关于页面和可选 Clarity 统计均在后台配置。
- 主题色支持直接点选六个色块：墨绿、灰蓝、棕褐 Brown、靛蓝、紫藤与玫瑰：保存同步后台与预览，发布同步公开网站；公开网站默认跟随系统，读者可手动切换；后台的明暗偏好独立保存。
- 网站图标支持后台上传 SVG / ICO（最多 256 KB），保存应用到后台、发布同步网页标签页与页头；备份包含图标，未使用的图标可在图片库清理。
- 公开网站采用 V4 三栏布局：固定左侧导航、中间文章、右侧目录及相关内容；点击文章在原内容区阅读，保留独立 URL、搜索和浏览器前进后退。前台不提供后台入口，作者直接访问 `/admin`。
- 首页展示最近 10 篇；“文章”进入独立 `/post/` 页面，每批最多 10 篇，接近底部时继续加载；也可手动加载或在无 JavaScript 时翻页浏览。文章正文地址仍为 `/posts/文章地址/`。列表与发布、撤回同步更新，草稿保持私有。
- 阅读字体提供经典衬线与简洁无衬线两种，默认沿用原衬线字体；导航和后台保持无衬线。保存后用于预览，发布网站信息后更新公开网页。首页插画可选择默认写作插画、自定义图片或关闭。
- 前后台采用统一设计；手机面板支持拖动、点击和键盘操作，尊重系统减少动态效果；前台自动适配视觉效果，后台可切换为简洁模式。
- 登录邮箱、密码在后台修改，更新后其他设备的登录失效。
- 网站备份 ZIP 包含设置、原稿和上传图片；恢复为草稿与待发布设置，检查后再发布。

发布由浏览器生成页面并上传，全部完成后切换线上版本。**发布、首次生成首页或备份恢复期间，请保持后台打开并联网，直到显示完成。** 失败时原稿与上次成功的线上版本保留，可取消未完成的发布后重试。

## 配置放在哪里

| 内容                       | 管理位置                                      |
| -------------------------- | --------------------------------------------- |
| 初始化口令                 | Cloudflare Secret，仅在账户不存在时用于初始化 |
| 博客信息、文章、图片、账户 | 私有 R2，通过网站后台管理                     |
| 默认模板、程序、项目图标   | GitHub 项目代码                               |
| 自定义域名、计费与平台权限 | Cloudflare 控制台                             |

存储桶保持私有，网站通过 Worker 公开已发布页面和允许访问的图片。无需 S3 访问密钥、构建令牌、Deploy Hook 或手动上传初始文章。后台不会要求拥有 Cloudflare 账号管理权限的 API Token。

## 程序更新与数据保留

Cloudflare Workers Builds 连接自己的 GitHub 仓库；提交或合并代码到生产分支后自动更新 Worker。博客设置、账户和文章保存在 R2，正常代码更新不重新初始化或覆盖这些数据。

部署按钮创建的仓库副本不会自动同步上游；Fork 可通过 GitHub Sync fork 更新，独立副本需要合并所需上游变更。后台、样式和公共脚本随部署更新；已发布文章 HTML 需要重新生成。后台工作区顶部始终提供“更新网站排版”，并提示当前排版是否需要更新；点击后只重建已发布内容，保留草稿和待发布的网站设置。更新期间请保持后台打开。

代码回滚与验证方式见 [开发说明](docs/DEVELOPMENT.md)。

## 开发与项目结构

项目由 **Rust/WASM 排版核心、TypeScript 云端接口和原生 JavaScript/CSS 界面**组成。部署时只有一个 Cloudflare Worker，业务数据保存在一个私有 R2 桶中。

```text
cloudink/
├── crates/                         # Rust workspace
│   ├── blog-core/
│   │   ├── src/
│   │   │   ├── models.rs           # 站点、文章和短记的数据模型
│   │   │   ├── content.rs          # 内容读取、解析与保存接口
│   │   │   ├── store.rs            # 原稿读写与格式校验
│   │   │   ├── import.rs           # 普通 Markdown 文件导入
│   │   │   ├── markdown.rs         # Markdown 转换
│   │   │   ├── math.rs             # 数学公式渲染
│   │   │   ├── render.rs           # 首页、文章、归档等 HTML 模板
│   │   │   ├── bundle.rs           # 从发布快照生成完整网页
│   │   │   ├── assets/             # 前台页面样式与阅读交互
│   │   │   └── lib.rs              # Rust 核心入口与原生站点构建
│   │   ├── tests/                 # Rust 内容和渲染测试
│   │   └── build.rs               # 计算模板版本指纹
│   ├── blog-wasm/                 # 浏览器 WASM 接口，复用 blog-core
│   └── sitegen/                   # 构建期命令行工具，生成基础站点资源
├── cloud-web/
│   ├── src/
│   │   ├── index.ts               # 唯一 Worker 入口，分发前后台请求
│   │   └── reader.ts              # 阅读响应、图片加载与搜索引擎元信息
│   └── test/                     # API、存储及浏览器功能测试
├── cloud-admin/
│   ├── src/                      # 认证、文章、短记、图片、备份与发布 API
│   ├── ui/
│   │   ├── index.html            # 后台页面结构
│   │   ├── app.js                # 后台主入口与编辑状态协调
│   │   ├── *.js                  # 图片库、短记、设置、发布等功能模块
│   │   ├── *.worker.js           # 浏览器预览和图片压缩线程
│   │   └── *.css                 # 后台布局与功能样式
│   └── build-ui.mjs              # 打包后台脚本、样式和 WASM 资源
├── assets/                       # 前后台共享主题、动效、图标与默认插画
├── scripts/
│   ├── build-web.sh              # 完整构建流程入口
│   ├── web-assets.mjs            # 构建通用资源、打包前台脚本与字体
│   ├── ensure-rust.sh            # 准备 Rust 工具链
│   ├── types.mjs                 # 生成 Cloudflare 绑定类型
│   ├── commands.mjs              # 构建工具共用的命令调用
│   └── ui-audit.mjs              # 按需检查正式界面并生成截图报告
├── docs/
│   ├── DEPLOYMENT.md             # 部署、配置和故障处理
│   └── DEVELOPMENT.md            # 架构、数据布局与维护说明
├── .github/workflows/checks.yml  # PR 基础检查与手动视觉检查
├── wrangler.jsonc               # 唯一 Worker 与 R2 绑定配置
├── Cargo.toml / Cargo.lock      # Rust workspace 与依赖锁定
├── rust-toolchain.toml          # Rust 工具链版本
├── package.json / package-lock.json
│                                # 项目构建命令与 Node.js 依赖锁定
└── LICENSE                      # MIT 开源协议
```

**构建流程：** `npm run build` 编译 Rust/WASM、打包后台，再通过 `sitegen` 和资源脚本生成通用前台资源。Worker 部署入口始终是 `cloud-web/src/index.ts`；`cloud-admin` 是内部模块，不单独部署。

**写作与发布：** 后台通过 API 保存草稿；预览、Markdown 导入和发布排版调用浏览器线程中的 Rust/WASM。发布页面上传完成后，Worker 切换 R2 中的线上版本指针，读者访问当前已发布内容。浏览器线程不是额外部署的 Cloudflare Worker。

仓库保留产品实现、构建配置、必要测试和使用文档；不保存设计原型、历史审阅包、个人文章、实际部署配置或密钥。`target/`、`build-work/`、后台生成脚本及 WASM 文件由构建产生，不提交源码。

开发命令、存储结构和检查流程见 [开发说明](docs/DEVELOPMENT.md)。PR 自动运行基础检查，合并后不重复执行；完整三浏览器视觉检查按需手动开启。

图片支持 JPEG、PNG、WebP、GIF、AVIF，单张最多 10 MB。发布内容与生成网页各最多 16 MB、最多 750 个生成文件。网页备份支持最多 8 MB 原稿、100 MB 文字及图片数据；更大的站点通过 Cloudflare R2 备份。资源使用超出免费额度时按 Cloudflare 定价计费，详见部署教程。

## 开源协议

CloudInk 的原创代码与项目资源采用 [MIT License](LICENSE) 发布，版权署名为 RS-Imagine 与 CloudInk 贡献者。使用、修改和再分发时请保留版权与许可声明；第三方依赖与资源仍适用各自的许可证。

使用 CloudInk 发布的文章、图片等个人网站内容，其权利由内容作者决定，不因使用本程序而自动适用 MIT。

### 默认节省额度

公开内容使用边缘缓存，日常发布只上传变化页面，新大图默认压缩主图；图片库分页不重复扫描存储桶。每日自动回收过期发布产物，保留当前与最近两个版本，保护原稿、图片、设置和账户。详见[免费额度与自动维护](docs/DEPLOYMENT.md#免费额度与自动维护)。这些措施减少消耗，但不构成 Cloudflare 账号的自动停费上限。

实现位置：`cloud-web/src/cache.ts` 负责公开缓存，`cloud-admin/src/browser-publishing.ts` 负责页面指纹与增量发布，`cloud-admin/src/maintenance.ts` 负责有界回收；仍使用一个 Worker 与一个私有 R2 桶。

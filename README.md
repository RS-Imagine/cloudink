<p align="center">
  <img src="assets/cloudink.svg" width="112" height="112" alt="CloudInk 云砚项目图标">
</p>

# CloudInk · 云砚

**云端存稿，静态成页。**

基于 Cloudflare 的个人博客与云端写作空间。只需 GitHub 和 Cloudflare 两个账号，在网页里部署，再到浏览器后台写作、上传图片和发布文章。

CloudInk — a personal blog and cloud writing space powered by Cloudflare and Rust.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/RS-Imagine/cloudink)

## 三步开始

1. 点击上面的部署按钮，登录 GitHub 和 Cloudflare；按提示启用 R2。
2. 填 `OWNER_EMAIL`（后台邮箱）和 `INITIAL_PASSWORD`（12–128 字符的 Secret）。其他保持默认，点击部署。
3. 打开部署得到的 `workers.dev` 地址，进入 **`/admin`**，用刚填的邮箱和密码登录。设置网站信息，就可以写作和发布了。

Cloudflare 自动复制仓库、创建一个 Worker 和两个私有 R2 桶，并连接代码自动部署。无需本地克隆、编辑 JSON、安装工具、设置构建令牌或 Deploy Hook；自己的域名可选。详细说明见 **[网页部署教程](docs/DEPLOYMENT.md)**，已有三个 Worker 的站点继续使用 [进阶部署与维护教程](docs/ADVANCED_DEPLOYMENT.md)。

## 日常写作

- 只有唯一作者账号，没有公开注册。
- 文章原稿、草稿、历史和发布快照保存到私有 R2，GitHub 只保存项目代码。
- 支持自动保存、Ctrl/Cmd + S、Markdown 导入、图片拖放和粘贴。
- Rust 与浏览器 WASM 共用排版引擎，支持数学公式、代码高亮、搜索和图片预览。
- 保存与发布分开；点击“发布这篇”只更新选中的文章，其他草稿保留。
- 标题、副标题、作者和描述在后台设置。项目名 CloudInk 不限制你的博客名称。

默认单 Worker 模式在浏览器中生成静态页面，上传完整后一次切换线上版本。**发布时保持后台页面打开并联网，直到显示“最新发布已上线”。** 失败或取消时保留原稿及上次成功版本；关闭浏览器后可在后台取消未完成的任务并重新发布。

导出全部原稿可下载 ZIP；图片另外在 R2 中备份。恢复历史版本只保存为草稿，点击发布后才上线。取消发布会保留原稿和历史。

## 配置与代码更新

| 配置 | 位置 |
| --- | --- |
| 作者登录邮箱、可选站点地址 | Cloudflare Worker 普通变量 |
| 初始密码 | Cloudflare Worker Secret |
| 博客标题、作者、文章、草稿、历史 | 私有 R2，通过后台修改 |
| 程序、模板、默认图标 | GitHub 仓库 |

向自己的 GitHub 仓库生产分支提交或合并代码，Workers Builds 自动更新同一个 Worker，运行时变量、Secret 和 R2 内容保留。部署按钮创建的仓库副本不会自动同步上游；Fork 用户可以先用 GitHub Sync fork 合并更新。后台、样式、脚本和图标随部署更新；已有文章 HTML 在下次发布时重新生成，发布一次网站信息即可刷新全部已发布页面。

已有三 Worker 部署的 `BLOG_DEPLOY_CONFIG_JSON` / 私有 `deployment.json` 仍受支持，会选择原有构建和发布流程，保留站点部署参数、账号及内容。代码更新不会自动迁移现有站点。实际个人配置、密钥和本地内容默认不提交 Git；访问统计默认关闭。

## 项目结构

| 目录 | 用途 |
| --- | --- |
| `cloud-web` | 默认单 Worker：博客、`/admin` 后台、图片路由 |
| `crates/blog-core` | Markdown、公式、模板与静态生成 |
| `crates/blog-wasm` | 浏览器预览、导入与完整网站生成 |
| `crates/sitegen` | 原有原生静态构建命令 |
| `cloud-admin` | 登录、在线编辑、私有 R2、上传与发布 API |
| `cloud-images` | 图片响应与来源检查，可独立部署 |
| `scripts` | 构建、类型生成、部署与进阶配置 |
| `crates/admin` | 原有本机 Axum 后台 |
| `assets/cloudink.svg` | 云朵与笔尖留白的单色 SVG 项目图标及 favicon |

## 开发与验证

以下工具仅供开发者使用，网页部署无需安装。需要 Node.js 22+、Rust 1.98.1 和 Chromium；构建脚本会准备 WASM 工具与目标。

```bash
npm ci
npm run build:web
npm run types
npx wrangler deploy --dry-run --outdir cloud-web/dist
npm --prefix cloud-admin run build
npm --prefix cloud-admin run check
npm --prefix cloud-admin test
npm test
cargo test --workspace
npm run test:web:browser
npm --prefix cloud-admin run test:browser
```

测试只使用本地临时 R2，不访问生产文章。可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定现有 Chromium。单 Worker 本地预览：复制根目录 `.dev.vars.example` 为 `.dev.vars`，填写本地测试密码，在 `wrangler.jsonc` 配置测试邮箱后运行 `npx wrangler dev`。

本地文件构建仍可用 `cargo run -p sitegen -- build`，输入默认 `content/`、输出默认 `public/`；也可用 `BLOG_CONTENT_ROOT` / `BLOG_OUTPUT_ROOT` 指定。

## 数据与限制

内容桶和图片桶保持私有；公开路由只读取已完成发布的页面。多窗口通过 R2 ETag 检查版本，发生冲突时先下载原稿。后台预览使用登录保护的图片接口；公开图片的来源检查属于防盗链措施，并非登录权限。

图片支持 JPEG、PNG、WebP、GIF、AVIF，单张最多 10 MB。单页上传最多 8 MB，发布内容与生成网页各最多 16 MB、最多 750 个生成文件。默认模式的公开请求与发布消耗 Worker、R2 额度，费用及故障处理见 [部署教程](docs/DEPLOYMENT.md)。

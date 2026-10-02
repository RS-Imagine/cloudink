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

- Markdown 在线编辑、自动保存、导入原稿、图片拖放与粘贴。
- Rust / WASM 共用排版引擎，支持数学公式、代码高亮、搜索、主题切换和图片预览。
- 草稿保存与发布分开，发布一篇文章不会连带发布其他草稿。
- 标题、副标题、作者、页脚、关于页面和可选 Clarity 统计均在后台配置。
- 登录邮箱、密码在后台修改，更新后其他设备的登录失效。
- 网站备份 ZIP 包含设置、原稿、历史和上传图片；恢复为草稿与待发布设置，检查后再发布。

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

部署按钮创建的仓库副本不会自动同步上游；Fork 可通过 GitHub Sync fork 更新，独立副本需要合并所需上游变更。后台、样式和公共脚本随部署更新；已发布文章 HTML 在下次发布时重新生成，可在后台发布一次网站信息来更新全部已发布页面。

**旧部署不会自动迁移。** 三 Worker 配置与构建流程仍兼容，维护说明见 [进阶文档](docs/ADVANCED_DEPLOYMENT.md)。已有双桶单 Worker 部署需要另行规划存储绑定与账号初始化方式的迁移，不能直接替换为新的单桶根配置。

## 开发与项目结构

| 路径                                    | 用途                                     |
| --------------------------------------- | ---------------------------------------- |
| `cloud-web`                             | 默认单 Worker：博客、后台、图片访问      |
| `cloud-admin/src`                       | 初始化、认证、编辑、设置、备份与发布 API |
| `cloud-admin/ui`                        | 首次设置向导、写作界面与网站设置         |
| `crates/blog-core` / `crates/blog-wasm` | Rust 渲染核心与浏览器 WASM               |
| `cloud-images`                          | 通用图片响应与旧部署兼容服务             |
| `scripts`                               | 构建、类型生成、通用部署与兼容配置       |
| `assets/cloudink.svg`                   | 单色云朵与笔尖项目图标                   |

开发命令、存储结构和检查流程见 [开发说明](docs/DEVELOPMENT.md)。仓库只保存项目代码、通用模板、测试和文档；实际部署配置、个人文章、密钥及构建产物均不提交。

图片支持 JPEG、PNG、WebP、GIF、AVIF，单张最多 10 MB。发布内容与生成网页各最多 16 MB、最多 750 个生成文件。网页备份支持最多 8 MB 原稿与历史、100 MB 文字及图片数据；更大的站点通过 Cloudflare R2 备份。资源使用超出免费额度时按 Cloudflare 定价计费，详见部署教程。

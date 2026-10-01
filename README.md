<p align="center">
  <img src="assets/cloudink.svg" width="112" height="112" alt="CloudInk 云砚项目图标">
</p>

# CloudInk · 云砚

**云端存稿，静态成页。**

基于 Cloudflare 的个人博客与云端写作空间。使用 Rust 生成静态网页，Workers 托管前台与私人 Markdown 写作后台，R2 保存内容，Workers Builds 负责发布。

CloudInk — a personal blog and cloud writing space powered by Cloudflare and Rust.

- 只有站点作者账号，没有公开注册。
- 原稿、草稿、历史和发布快照保存在私有 R2；GitHub 只保存项目代码。
- 草稿与发布分开，点击发布后由 Workers Builds 构建网站。
- Rust 与 WASM 共用排版引擎，支持数学公式、代码高亮、搜索和图片上传。
- 支持免费的 `workers.dev` 地址，也可绑定自己的域名。

复刻并部署自己的博客，请阅读 **[部署教程](docs/DEPLOYMENT.md)**。复制 `deployment.example.json` 为 `deployment.json`，填写自己的资源信息，再由脚本生成 Worker 配置。实际配置、初始化链接和密钥文件默认不提交 Git；访问统计默认关闭。

## 从这里开始

1. [Fork CloudInk](https://github.com/RS-Imagine/cloudink/fork)，准备自己的 Cloudflare 账号并启用 Workers 和 R2。
2. 按部署教程填写配置，部署后台和图片服务，完成首次账号设置。
3. 部署公开博客并连接 Workers Builds，以后在浏览器里写作、保存和发布。

每个站点使用自己的邮箱、资源和配置；不需要先购买域名。项目名是 CloudInk，博客标题和作者由站点所有者自行设置。

## 日常写作

登录自己的后台，新建文章并填写标题、摘要和正文。支持自动保存、Ctrl/Cmd + S、图片上传/拖放/粘贴，以及导入 Markdown 原稿。

点击“发布这篇”后等待“最新发布已上线”。保存其他草稿不会把它们一起发布。恢复历史版本也只保存为草稿，需要再次发布。网站标题、副标题、作者和描述可以在后台修改；页脚及可选统计账号由部署配置管理。

导出全部原稿可下载 ZIP。图片需另从 R2 备份。取消发布会保留原稿和历史。

## 项目结构

| 目录 | 用途 |
| --- | --- |
| `crates/blog-core` | Markdown、公式、模板、静态生成 |
| `crates/sitegen` | 静态构建命令 |
| `crates/blog-wasm` | 浏览器预览与 Markdown 导入 |
| `cloud-admin` | 登录、在线编辑、R2 保存、上传、发布 |
| `cloud-images` | 供新部署使用的 R2 图片服务 |
| `scripts` | 配置生成、初始化、构建与部署 |
| `crates/admin` | 原有本机 Axum 后台 |
| `assets/cloudink.svg` | 项目图标，前台和后台共用的 SVG favicon |

根目录与两个 Worker 目录中的 `wrangler.jsonc` 是通用开发模板。正式部署使用 `npm run configure` 生成的 `.deploy/*.jsonc`；脚本不会自动部署模板中的示例资源。

## 开发与验证

需要 Node.js 22、Rust 1.98.1；后台构建另需 `wasm32-unknown-unknown` 和 wasm-pack。安装步骤见部署教程。

```bash
npm ci
npm --prefix cloud-admin ci
cp cloud-admin/.dev.vars.example cloud-admin/.dev.vars
npm --prefix cloud-admin run types
npx wrangler types cloud-images/worker-configuration.d.ts --config cloud-images/wrangler.jsonc --env-interface ImagesEnv --include-runtime false
bash scripts/build-admin.sh
npm --prefix cloud-admin run check
npm --prefix cloud-admin test
npm test
cargo test --workspace
npm --prefix cloud-admin run test:browser
```

测试只使用本地临时 R2，不访问生产文章。浏览器测试可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定现有 Chromium。

本地文件方式仍可用 `cargo run -p sitegen -- build`，输入默认 `content/`，输出默认 `public/`；也可用 `BLOG_CONTENT_ROOT` / `BLOG_OUTPUT_ROOT` 指定。

## 数据与恢复

发布生成不可变快照，只有线上 `_release.json` 匹配目标发布 ID 才确认上线。失败时保留原稿和上次成功版本。多个编辑窗口通过 R2 ETag 检查版本；发生冲突时先下载原稿。

内容桶和图片桶都保持私有。图片 Worker 允许配置的博客来源引用图片，拒绝直接访问与其他站点引用；这是防盗链措施，不是登录权限。后台预览使用登录保护的图片接口。图片格式支持 JPEG、PNG、WebP、GIF、AVIF，单张最多 10 MB，当前发布快照最多 16 MB。

发布超过 30 分钟时，查看自己公开 Worker 的 Workers Builds 记录。保存失败时先下载原稿。现有站点升级与受控账号恢复见部署教程；不要重新初始化已有 R2 或重置账号。

## 更新项目代码

启用 Workers Builds 后，将代码提交到配置的生产分支即可触发公开博客部署；后台有独立构建连接时，相关代码变更也会自动部署。个人部署参数保存在 Cloudflare Builds 的 `BLOG_DEPLOY_CONFIG_JSON`，更新仓库不会用示例配置替换它。密码和构建凭据继续保存在 Cloudflare Secrets，文章和草稿继续保存在 R2。

使用 Fork 的站点需先将上游更新合并到自己的生产分支，才能触发自己的部署。具体设置与升级说明见 [部署教程](docs/DEPLOYMENT.md)。

## 项目图标

[CloudInk SVG 图标](assets/cloudink.svg) 以云朵与笔尖留白表现云端写作。单色图形使用矢量路径、透明背景，适配浅色与深色系统主题，作为 README 标识及前台、后台的默认浏览器图标。

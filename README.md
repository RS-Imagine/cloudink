# r-blog

Rust 静态博客，Cloudflare Workers Static Assets 托管公开网页，Cloudflare Worker 提供私人写作后台。

文章原稿、草稿、历史版本和发布快照保存在私有 R2 桶 `r-blog-content`。图片上传到现有 `images-blog`，继续使用 `img.forimagine.eu.org`。GitHub 保存项目代码，文章发布不产生 Git 提交。

## 日常写作

打开 `https://admin.forimagine.eu.org`，使用 `imagine@forimagine.eu.org` 和自己设置的密码登录。

- 新建文章，填写标题、摘要和 Markdown。输入后自动保存到 R2，也可以手动保存。
- 预览使用同一套 Rust 排版引擎，支持数学公式和代码。预览在隔离的框架内展示。
- 上传、拖入或粘贴图片，后台会插入图片地址。
- 点击“发布这篇”，等待 Workers 构建完成。保存其他草稿不会把它们一起发布。
- 原有网页会继续保留。导入电脑上的 Markdown 原稿后，可以在线修改。导入不会自动发布。
- 历史版本可以恢复为草稿；“导出全部原稿”下载 ZIP 备份。图片需另从 R2 备份。

首次使用时，通过私人初始化链接设置密码。链接只能使用一次，不需要在聊天里提供密码。后台没有注册入口。

## 发布连接

发布服务由维护者配置，后台显示“发布服务已连接”，可以直接发布文章，无需重新填写部署链接。发布会触发 Worker `r-blog` 的 Workers Builds，读取私有 R2 快照并生成静态网页。

部署链接和构建密钥仅保存在 Cloudflare 的 secret 配置中，不要发送到聊天或提交 Git。密码遗忘时，可通过受控初始化流程恢复账户，后台不开放注册。

## 项目结构

- `crates/blog-core`：Markdown、数学公式、模板和网站生成。
- `crates/sitegen`：静态网站构建命令。
- `crates/blog-wasm`：供浏览器调用的 Rust 预览和原稿解析。
- `cloud-admin`：Worker API、登录、R2 保存和网页编辑器。
- `scripts/cloudflare-build.sh`：Cloudflare 构建时从 R2 拉取发布快照，然后用 Rust 生成网页。
- `crates/admin`：保留原有本地 Axum 后台，适用于本地文件。

`content/`、`public/`、`build-work/`、密钥和编译产物不提交。旧部署分支 `forimagine` 已删除，生产部署统一使用 `master`；日常文章由后台和 R2 管理。

## 部署配置

公开 Worker `r-blog` 使用根目录 `wrangler.jsonc`，私人后台 `r-blog-admin` 使用 `cloud-admin/wrangler.jsonc`。Workers Builds 连接 GitHub 的 `master` 分支，根目录 `/`；构建命令 `bash scripts/cloudflare-build.sh`，部署命令 `npx wrangler deploy --config wrangler.jsonc`，静态输出 `build-work/public`。根目录锁定 Wrangler 依赖，构建环境会安装它们。

Workers Builds 构建环境需要 `BLOG_ADMIN_URL=https://admin.forimagine.eu.org` 和 secret `BLOG_BUILD_TOKEN`，后者与后台 secret `WORKERS_BUILD_TOKEN` 相同。后台 secret `WORKERS_DEPLOY_HOOK` 触发同一 Worker 的 `master` 分支构建。构建凭据只用于构建时读取与状态回报，不放在公开静态 Worker 中。

旧 Pages 项目 `r-blog` 和旧 `BUILD_TOKEN`、加密的 Pages Hook 保留作回退；正式域名由 Workers 接管后，Pages 不再自动部署。不要轮换旧 `BUILD_TOKEN`：R2 中旧 Hook 的加密密钥由它派生。回退应先核对 Pages 版本和内容，再恢复域名、自动构建及后台旧发布连接。

后台的 `BUILD_TOKEN`、`SETUP_TOKEN`、`WORKERS_BUILD_TOKEN`、`WORKERS_DEPLOY_HOOK` 使用 secret 配置，不写进配置文件。后台部署：

```bash
npm --prefix cloud-admin ci
bash scripts/build-admin.sh
cd cloud-admin
npx wrangler deploy
```

构建后台需要 Rust 1.98.1、`wasm32-unknown-unknown` 和 wasm-pack 0.15。日常文章发布只构建静态网站，无需重新构建后台。

## 本地验证

```bash
cargo test --workspace
npm --prefix cloud-admin ci
cp cloud-admin/.dev.vars.example cloud-admin/.dev.vars
cd cloud-admin
npm run types
npm run check
cd ..
bash scripts/build-admin.sh
npm --prefix cloud-admin test
```

Worker 测试使用本地 Miniflare/R2，不访问生产桶。测试覆盖登录和 CSRF、并发编辑、历史记录、单篇发布、失败保留线上版本、图片校验和会话撤销。

本地博客仍可用 `cargo run -p sitegen -- build`。输入默认为 `content/`，输出默认为 `public/`，也可用 `BLOG_CONTENT_ROOT` / `BLOG_OUTPUT_ROOT` 指定。

## 内容安全与恢复

发布生成不可变快照；只有线上 `_release.json` 确認部署成功后才切换已发布版本。构建失败时原稿和上次成功版本保留。两个编辑窗口通过 R2 ETag 检查版本，冲突时先下载原稿，再重新打开文章。

R2 内容桶不开放公开访问。登录使用加盐 PBKDF2 密码哈希、限速、HttpOnly/Secure 会话和 CSRF 校验。原稿导出需要登录。图片上传接受 JPEG、PNG、WebP、GIF、AVIF，单张最多 10 MB。当前发布快照最多 16 MB；它包含文章和迁移时的小型本地图片，新上传图片只保存引用。

如发布超过 30 分钟，请先看 Worker `r-blog` 的 Workers Builds 构建与部署记录。后台保存失败时，请下载当前原稿，避免关闭窗口后丢失尚未保存的修改。

# r-blog

Rust 静态博客，Cloudflare Pages 托管公开网页，Cloudflare Worker 提供私人写作后台。

文章原稿、草稿、历史版本和发布快照保存在私有 R2 桶 `r-blog-content`。图片上传到现有 `images-blog`，继续使用 `img.forimagine.eu.org`。GitHub 保存项目代码，文章发布不产生 Git 提交。

## 日常写作

打开 `https://admin.forimagine.eu.org`，使用 `imagine@forimagine.eu.org` 和自己设置的密码登录。

- 新建文章，填写标题、摘要和 Markdown。输入后自动保存到 R2，也可以手动保存。
- 预览使用同一套 Rust 排版引擎，支持数学公式和代码。预览在隔离的框架内展示。
- 上传、拖入或粘贴图片，后台会插入图片地址。
- 点击“发布这篇”，等待 Pages 构建完成。保存其他草稿不会把它们一起发布。
- 原有网页会继续保留。导入电脑上的 Markdown 原稿后，可以在线修改。导入不会自动发布。
- 历史版本可以恢复为草稿；“导出全部原稿”下载 ZIP 备份。图片需另从 R2 备份。

首次使用时，通过私人初始化链接设置密码。链接只能使用一次，不需要在聊天里提供密码。后台没有注册入口。

## 首次连接发布

Cloudflare 的连接器目前没有创建 Pages Deploy Hook 的接口，需要站点所有者在控制台完成一次：

1. Workers & Pages → `r-blog` → Settings → Builds → Add deploy hook。
2. 名称 `online-admin`，分支 `master`。
3. 复制链接，在后台“网站设置 → 发布连接”中保存。

链接会加密保存在私有 R2，不会显示在文章或 GitHub 中。不要发送到聊天。密码遗忘时，维护者可以通过 Wrangler 轮换初始化密钥并重置账户；不要开放注册来恢复访问。

## 项目结构

- `crates/blog-core`：Markdown、数学公式、模板和网站生成。
- `crates/sitegen`：静态网站构建命令。
- `crates/blog-wasm`：供浏览器调用的 Rust 预览和原稿解析。
- `cloud-admin`：Worker API、登录、R2 保存和网页编辑器。
- `scripts/cloudflare-build.sh`：Pages 从 R2 拉取发布快照，然后用 Rust 生成网页。
- `crates/admin`：保留原有本地 Axum 后台，适用于本地文件。

`content/`、`public/`、`build-work/`、密钥和编译产物不提交。此前的 `forimagine` 分支和 Git 历史保留作迁移备份，日常文章维护不再使用它。

## 部署配置

Pages 生产代码分支：`master`。根目录：仓库根目录。构建命令：`bash scripts/cloudflare-build.sh`。输出：`build-work/public`。

生产和预览环境都需要：

- `BLOG_ADMIN_URL`：`https://admin.forimagine.eu.org`
- `BLOG_BUILD_TOKEN`：与 Worker 的 `BUILD_TOKEN` 相同，配置为 secret。

Worker 的绑定和域名见 `cloud-admin/wrangler.jsonc`。密钥 `BUILD_TOKEN` 和 `SETUP_TOKEN` 使用 `wrangler secret put`，不要写入配置文件。修改 `BUILD_TOKEN` 时，需要同步 Pages，并在后台重新保存发布连接（加密密钥由它派生）。

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

如发布超过 30 分钟，请先看 Pages 部署日志。后台保存失败时，请下载当前原稿，避免关闭窗口后丢失尚未保存的修改。

# 只用 GitHub 和 Cloudflare 部署 CloudInk

无需本地克隆、编辑配置或安装任何工具。准备一个 GitHub 账号和 Cloudflare 账号，即可在网页中完成部署；自己的域名可选。

## 1. 点击部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/RS-Imagine/cloudink)

按 Cloudflare 页面提示登录两个账号并授权仓库连接。Cloudflare 会将项目复制到你的 GitHub 账号，连接 Workers Builds，自动创建一个 Worker 和两个私有 R2 桶。仓库名、Worker 名、桶名可以在部署页面自定义；保持两个桶使用不同名字，不要选已有站点的数据桶。

首次使用 R2 时可能需要先在 Cloudflare 控制台启用 R2 并添加计费信息，以页面提示为准。Worker 和 R2 有免费额度，超额收费按 [Cloudflare 定价](https://developers.cloudflare.com/r2/pricing/)执行。

## 2. 填邮箱和密码

| 字段 | 填什么 | 存在哪里 |
| --- | --- | --- |
| `OWNER_EMAIL` | 你的后台登录邮箱；无需配置邮件服务 | Cloudflare Secret |
| `INITIAL_PASSWORD` | 自选 12–128 字符的初始密码 | Cloudflare 加密 Secret |

保留自动检测的构建命令 `npm run build`、部署命令 `npm run deploy`、项目根目录 `/`，点击部署。首次构建需要下载 Rust 工具链并编译，请等待 Cloudflare 显示成功。

邮箱和密码都通过部署页面保存为 Cloudflare Secrets；不需要编辑仓库配置。密码不要填写到 GitHub 文件、提交记录或普通变量里。`INITIAL_PASSWORD` 是运行时 Secret，不需要添加到构建环境变量。文章、草稿和账号都保存在你的私有 R2，GitHub 仓库只保存项目代码。

## 3. 打开后台开始写作

部署完成后，打开 Cloudflare 显示的 Worker 地址，例如 `https://cloudink.reader.workers.dev`。博客在首页，写作后台在同一地址的 **`/admin`**。

首次使用部署时填写的邮箱和初始密码登录，系统会自动创建唯一作者账号并初始化空博客。进入“设置”修改标题、作者和描述，点击“发布网站信息”；然后新建文章、保存草稿、点击“发布这篇”。不需要构建令牌、Deploy Hook、GitHub Token 或手动上传初始内容。

发布期间请保持后台页面打开并保持联网，等到“最新发布已上线”。网页在浏览器中生成并上传，所有页面上传完整才会切换线上版本；保存草稿不会更新线上网站，也不会发布其他草稿。

## 后续配置和更新

- **域名可选**：在 Worker 的 Settings → Domains & Routes 中添加 Custom Domain 即可；域名需位于这个 Cloudflare 账号。链接自动使用当前访问地址，图片使用相对路径，不需要配置站点 URL。
- **改密码**：登录后台后在“设置 → 修改密码”中操作。账号创建后，修改 `INITIAL_PASSWORD` 不会重置现有密码；保留这一 Secret 供部署校验使用，不影响后续更新，也不会覆盖后台修改后的密码。
- **代码自动部署**：部署按钮已连接 Workers Builds。向你自己的 GitHub 仓库生产分支提交或合并代码后，Cloudflare 会自动构建并更新同一个 Worker。运行时变量通过 `keep_vars` 保留，Secret 和 R2 内容也会保留。
- **采用上游更新**：部署按钮创建的仓库副本不会自动同步本项目。把所需上游变更合并或复制到你的仓库后才会触发部署；如果你的仓库是 Fork，可使用 GitHub 的 Sync fork。已有静态文章的 HTML 在下次发布时重新生成；后台、公共脚本、样式和图标随代码部署更新。可发布一次“网站信息”重新生成全部已发布页面，其他草稿不会跟着上线。
- **备份**：后台“导出全部原稿”下载 ZIP；图片另外在 Cloudflare R2 中备份。不要删除内容桶或图片桶来升级项目。

## 常见问题

**忘记初始密码或第一次无法登录**：在 Cloudflare Worker 的 Variables and Secrets 检查 Secrets `OWNER_EMAIL` 和 `INITIAL_PASSWORD`，密码必须是 12–128 字符，保存并部署。确认访问的是自己的 `/admin`。

**账号创建后忘记密码**：只有 Cloudflare 账号所有者能执行恢复。先备份内容桶，设置一个新的 `INITIAL_PASSWORD` Secret 并保存部署，再从内容桶中仅删除 `auth/account.json`，然后用原登录邮箱及新初始密码登录。系统会重建账号并使旧会话失效，保留原有文章、草稿、历史和线上版本。不要删除桶、`state/`、`releases/`、`public/` 或 `drafts/`；三 Worker 的旧站点按其维护流程恢复。

**发布中关闭了浏览器或断网**：原稿和上次上线版本仍保留。重新进入后台，点击“取消未完成的发布”，再点击发布；超过 30 分钟的未完成任务也会自动标记失败。若页面已成功上线但响应丢失，后台会识别已完成版本。

**构建失败**：在 Cloudflare Worker 的 Builds 中查看记录。确认使用根目录和上述默认命令，两个 R2 绑定分别为 `CONTENT`、`IMAGES`。运行时变量与构建变量不同；此方案无需把密码或内容读写令牌放进构建变量。

**收费与限制**：静态文章从 R2 读取，博客访问、后台 API 和发布会消耗 Worker 请求与 R2 操作额度。单张图片最多 10 MB，单页上传最多 8 MB，发布内容及生成网页各最多 16 MB、最多 750 个生成文件。无需为此购买自定义域名。

## 已经部署了三 Worker 的站点

继续使用 [进阶部署与维护教程](ADVANCED_DEPLOYMENT.md)。现有 `BLOG_DEPLOY_CONFIG_JSON` / 私有 `deployment.json` 会选择原有构建部署流程，保留 Worker 名、域名、R2、账号、构建连接与发布凭据。升级代码不会自动把现有站点切换到单 Worker，也不会覆盖现有文章。

<div align="center">
  <img src="assets/cloudink.svg" width="88" height="88" alt="CloudInk 云砚图标">
  <h1>CloudInk · 云砚</h1>
  <p>用 Rust 构建的个人博客，支持在浏览器里写作、发布和管理。</p>
</div>

CloudInk 运行在一个 Cloudflare Worker 上，使用一个私有 R2 存储桶保存文章、图片、设置和账户。[查看示例站点](https://forimagine.eu.org)

## 部署自己的博客

有 GitHub 和 Cloudflare 账号即可通过网页部署，自定义域名可选。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/RS-Imagine/cloudink)

1. 点击部署按钮，连接 GitHub 仓库并创建 Worker 和 R2 存储桶。
2. 填写 16–128 字符的初始化口令 `SETUP_TOKEN`，以 Cloudflare Secret 保存。
3. 在站点地址后加 `/admin`，按向导创建管理员账户并发布首页。

构建配置、自定义域名和故障处理见 [部署教程](docs/DEPLOYMENT.md)。

## 写作与发布

- 在线编辑 Markdown，支持预览、自动保存、拖放图片和批量导入文章。也可单独写短记。
- 草稿保存在私有 R2 中，明确发布后才对读者可见。发布期间请保持后台打开并联网。
- 文章支持目录、公式、代码高亮和全文搜索。读者可以订阅 RSS，或切换明暗主题。
- 在后台管理图片、图标、主题、阅读字体和关于页面；可下载站点 ZIP，并把备份内容恢复为草稿和待发布设置。

### 更新已部署的博客

Cloudflare Workers Builds 会随生产分支更新代码。内容和账户存放在 R2。若后台提示排版有更新，可用「更新网站排版」重建已发布页面。[上游同步](docs/DEPLOYMENT.md#自定义域名与项目更新) · [部署回滚](docs/DEPLOYMENT.md#回退-worker-版本)

## 本地开发

使用仓库锁定的 Rust 工具链和 Node.js 24。首次开发时将 `.dev.vars.example` 复制为 `.dev.vars`，填写本地初始化口令。启动后访问 `http://localhost:3000/admin`。

```bash
cargo xtask dev
```

`cargo xtask build` 编译 Rust Worker 与浏览器 WASM，并打包前后台资源。开发命令通过 Wrangler 运行同一个 Worker，本地 R2 状态保存在 `.wrangler/state`。

| 目录              | 内容                                       |
| ----------------- | ------------------------------------------ |
| `crates/`         | Rust Worker、排版核心、WASM 接口及构建工具 |
| `cloud-admin/`    | 后台界面、编辑与图片处理                   |
| `assets/`         | 共享样式、脚本和图片                       |
| `cloud-web/test/` | API、存储与浏览器回归测试                  |

构建产物、依赖目录、本地凭据、测试报告和临时实验由 `.gitignore` 管理，临时文件可放在 `scratch/`。工具版本、仓库检查和 R2 数据布局见 [开发说明](docs/DEVELOPMENT.md)。

## 开源协议

CloudInk 的原创代码及项目资源采用 MIT 协议。第三方依赖及资源遵循各自的许可证，博客内容的权利由内容作者决定。[MIT License](LICENSE)

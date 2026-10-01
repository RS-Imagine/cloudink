# 部署自己的 CloudInk · 云砚

每个复刻者使用自己的 Cloudflare 账号、Worker、R2 桶和登录账号。默认可以全部使用 `workers.dev` 地址，不要求购买域名。代码不包含原维护者的密码、文章或部署密钥。

## 1. 准备账号和工具

1. 在 GitHub [Fork CloudInk](https://github.com/RS-Imagine/r-blog/fork)，再将自己的仓库克隆到电脑。
2. 准备 Cloudflare 账号，启用 Workers 和 R2。R2 首次启用可能需要配置计费信息，以控制台要求为准。
3. 在 Cloudflare 的 Workers & Pages 中确认自己的 `workers.dev` 子域，例如 `reader`。
4. 安装 Git、Node.js 22、Rust 1.98.1。命令使用 Bash；Windows 可在 WSL 中操作。

先在自己的 Fork 页面复制 HTTPS 克隆地址，将下面的 `YOUR_FORK_GIT_URL` 换成它。这里将本地目录统一命名为 `cloudink`：

```bash
git clone YOUR_FORK_GIT_URL cloudink
cd cloudink
```

在仓库根目录执行：

```bash
npm ci
npm --prefix cloud-admin ci
npx wrangler login
rustup toolchain install 1.98.1 --profile minimal
rustup target add wasm32-unknown-unknown --toolchain 1.98.1
```

`cloud-admin` 的锁定依赖包含 wasm-pack；构建前把它加入当前终端 PATH：

```bash
export PATH="$PWD/cloud-admin/node_modules/.bin:$PATH"
```

## 2. 填一份自己的配置

```bash
cp deployment.example.json deployment.json
```

编辑 `deployment.json`：

| 字段 | 填什么 |
| --- | --- |
| `accountId` | Cloudflare Account ID；单账号自动识别时可留空，多账号建议填写 |
| `workersSubdomain` | 自己的 workers.dev 子域，不能保留 `YOUR_SUBDOMAIN` |
| `workers` | 公开博客、后台、图片三个 Worker 的不同名字 |
| `buckets` | 内容桶和图片桶的不同名字 |
| `ownerEmail` | 自己登录后台用的邮箱；在首次设置密码前选定 |
| `productionBranch` | 自己仓库的生产分支，如 `main` 或 `master` |
| `urls` | 留空自动生成 workers.dev 地址；自定义域名见后文 |
| `siteAliases` | 公开博客的额外自定义域名，如 www；默认空数组 |
| `externalImages` | 新部署保持 `false`，使用本仓库的图片 Worker |
| `site` | 初次建站的网站信息；页脚和 Clarity 项目 ID 也在这里 |

例如子域 `reader`、公开 Worker 名称 `cloudink`，地址就是 `https://cloudink.reader.workers.dev`。后台和图片地址同样由各自的 Worker 名称生成。这些名字只是新站示例，可以在自己的配置里修改。

`site.clarityId` 为空时不加载统计脚本。`site.footer` 为空时，根据当前作者显示默认页脚。新站的标题、作者等首次写入 R2 后，以后台的网站设置为准；修改配置文件里的初始标题不会覆盖现有 R2 设置。页脚和统计配置由部署配置控制。

```bash
npm run configure
```

这只生成 `.deploy/site.jsonc`、`.deploy/admin.jsonc`、`.deploy/images.jsonc`，不会创建或删除云端资源。邮箱和地址会生成 Worker 变量，桶名会生成绑定，无需手动维护两份。

实际配置默认被 Git 忽略。如果想在自己的仓库里保存非密钥配置，可以另取文件名提交，并在本地/构建环境设置 `BLOG_DEPLOY_CONFIG` 指向它；也可使用 Cloudflare 构建变量 `BLOG_DEPLOY_CONFIG_JSON`。不要在任何部署配置文件里填写 token、密码或部署链接。

## 3. 准备两个私有 R2 桶

在 Cloudflare → R2 创建 `buckets.content` 和 `buckets.images` 对应的两个桶。保持私有，不启用 r2.dev 公共访问或 R2 自定义公共域名。

也可以使用 Wrangler 创建，名称要与自己的配置一致：

```bash
npx wrangler r2 bucket create cloudink-content
npx wrangler r2 bucket create cloudink-images
```

图片通过 Worker 提供访问，后台通过 R2 绑定读取。原稿和草稿不需要 R2 的公开地址。

## 4. 部署后台和图片服务

```bash
bash scripts/build-admin.sh
npm run deploy:admin
npm run deploy:images
```

这些脚本使用刚生成的配置和当前登录的 Cloudflare 账号。打开生成的后台地址，此时尚未设置密码，登录不可用是正常现象。

已有独立图片服务的维护者可设 `externalImages: true`；此时 `deploy:images` 会拒绝替换现有服务。新用户使用默认完整图片 Worker 即可。

## 5. 为新站配置密钥和空白内容

以下两条命令只用于新站，不是升级操作：

```bash
npm run setup:secrets
npm run setup:content
```

第一条生成随机的构建与初始化凭据，通过 Wrangler 的标准输入写入后台 Secrets。它先检查后台是否已设置账号，已有账号会拒绝执行，不会自动重置密码。再次执行只复用本地生成的凭据，不会静默轮换。

第二条初始化空白发布快照及 About 页面。R2 已有发布版本时返回“内容已经存在”，不会覆盖文章、草稿、网站信息或历史。

本地生成两个私人文件：

- `.deploy/secrets.json`：初始化与构建凭据；后续构建变量的 `BLOG_BUILD_TOKEN` 使用其中的 `WORKERS_BUILD_TOKEN`。
- `.deploy/first-login.txt`：打开里面的链接，设置自己的密码。首次设置完成后，初始化入口不能再创建第二个账号。

不要分享这些文件或截图，也不要提交 Git。初始化链接把 token 放在 URL 片段，页面读取后会移除；浏览器不会把 URL 片段发送给服务器。设置密码后可删除 `first-login.txt`，妥善保存构建凭据。

## 6. 第一次部署公开博客

```bash
npm run build
npm run deploy
```

本地构建从私人后台下载已发布快照，使用 Rust 生成 `build-work/public`。此时是空白博客。打开自己的公开地址，确认首页和 About 能访问。

先完成这一步，再连接日常发布；新站初始化本身不会触发自动部署。

## 7. 连接 Workers Builds

在 Cloudflare → Workers & Pages → 自己的公开 Worker → Settings → Builds，连接自己的 GitHub Fork。GitHub 集成需要授权读取自己的仓库。

| 设置 | 值 |
| --- | --- |
| 生产分支 | 配置中的 `productionBranch` |
| 根目录 | 仓库根目录 `/` |
| 构建命令 | `bash scripts/cloudflare-build.sh` |
| 部署命令 | `npm run deploy` |
| 预览构建 | 第一版建议关闭 |

**构建环境变量**不是 Worker 的运行变量，在 Builds 的配置里单独填写：

| 构建变量 | 内容 | 类型 |
| --- | --- | --- |
| `BLOG_DEPLOY_CONFIG_JSON` | 完整的 `deployment.json` 内容 | 普通变量，无密钥 |
| `BLOG_ADMIN_URL` | 自己的后台完整地址 | 普通变量 |
| `BLOG_BUILD_TOKEN` | 本地 secrets 文件中的 `WORKERS_BUILD_TOKEN` | Secret |

如果把自己的非密钥配置提交到了 Fork，可用 `BLOG_DEPLOY_CONFIG=文件名` 替代 `BLOG_DEPLOY_CONFIG_JSON`。JSON 变量优先于文件。不要只填邮箱和地址而遗漏 Worker 名称、桶名、分支等部署信息。

Cloudflare 构建环境会根据根目录锁文件安装 Wrangler。Rust 构建脚本会安装缺少的工具链。日常发布不需要重新编译后台 WASM。

然后为公开 Worker 创建 Deploy Hook，分支选择同一生产分支。用后台“网站设置 → 发布连接”保存链接；它会加密写入私有 R2。

也可以由维护者使用 `wrangler secret put WORKERS_DEPLOY_HOOK --config .deploy/admin.jsonc` 配置托管的发布连接，这样后台显示“已连接”，不再要求作者填写链接。Deploy Hook 和构建 token 都是密钥。

### 可选：后台代码自动更新

也可为自己的后台 Worker 单独连接同一个仓库的 Workers Builds：构建命令 `bash scripts/cloudflare-admin-build.sh`，部署命令 `npm run deploy:admin`，分支和根目录同上，构建环境只需非密钥 `BLOG_DEPLOY_CONFIG_JSON`。后台流水线重新编译 WASM 和 UI；它不读取文章内容，也不需要 `BLOG_BUILD_TOKEN`。

公开 Worker 与后台 Worker 各自使用独立的构建连接，不要在公开 Worker 的构建中顺带部署后台。日常文章发布的 Hook 只连接公开 Worker。

## 8. 验证日常写作

1. 登录后台，新建文章，保存草稿，公开网站不应出现它。
2. 上传一张图片，确认编辑器预览能显示。
3. 点击“发布这篇”，在 Workers Builds 中观察构建，等待后台提示上线。
4. 检查公开页面、搜索和图片。
5. 修改文章但不发布，公开版本应保持不变；可以导出原稿做备份。

以后写文章只操作后台，不需要把文章提交 GitHub。

## 可选：使用自己的域名

域名需要在同一 Cloudflare 账号中管理。修改配置：

```json
"urls": {
  "site": "https://blog.example.com",
  "admin": "https://write.example.com",
  "images": "https://images.example.com"
},
"siteAliases": ["https://www.blog.example.com"]
```

也可只为其中一个服务使用自定义域名，其余保持 workers.dev。三个服务地址必须不同，填写 HTTPS 地址，不带路径、查询参数或账号密码。

重新执行 configure 和相应 deploy 命令，然后更新 Workers Builds 的配置 JSON 与后台地址。Wrangler 使用 Custom Domains 绑定域名；自定义域名模式会关闭相应 Worker 的 workers.dev 入口。已有同名 DNS 记录或其他服务绑定时，先核对归属后在 Cloudflare 处理冲突。

已上传图片的 Markdown 包含原来的图片 URL，换图片域名不会自动改写旧文章。已有网站切换时应保留旧图片地址，或有计划地迁移引用；不要直接删除旧图片服务。更换博客地址也要同步图片服务允许的来源。

## 已有站点升级与恢复

已有 R2 和账号的站点只更新代码及非密钥配置，再部署对应 Worker；**不要运行 setup:secrets，不要删除或重建桶，不要重新设置账号**。既有 Cloudflare Secrets 会由正常部署继承。站点内容以 R2 为准，配置文件中的初始标题不覆盖现有内容。

CloudInk 的项目名、GitHub 仓库名与部署资源名相互独立。已有站点升级时，继续使用原来的 `deployment.json` 或 Builds 配置即可；不要为了与新项目名一致而替换现有 Worker 名称、桶名或域名。默认 SVG 图标与后台项目名称会随代码更新，个人博客标题仍由后台的网站设置管理。

启用 Workers Builds 后，提交或合并代码到连接的生产分支会自动构建部署。后台也需自己的构建连接，才能随后台代码更新；如果配置了构建路径过滤，需包含 `cloud-admin/**`、`crates/**`、`assets/**`、`scripts/**`、`package*.json`、`Cargo.toml`、`Cargo.lock` 和 `rust-toolchain.toml`，以便依赖或工具链变化也触发更新。文章发布仍只触发公开博客构建。

Cloudflare Builds 中的 `BLOG_DEPLOY_CONFIG_JSON` 独立于仓库保存，代码更新不会覆盖它；只有需要改变部署参数时才修改这份变量。它也优先于本地配置文件。本地 `deployment.json` 是被 Git 忽略的副本，请自行备份；不要用 `deployment.example.json` 覆盖现有配置。更换电脑时，可从 Builds 复制非密钥 JSON 恢复本地配置，不需要重新初始化账号或文章。

Fork 不会自动跟随上游更新：先在 GitHub 同步 Fork，或将上游改动合并到自己配置的生产分支，再检查自己公开和后台 Worker 的构建结果。使用独立图片服务的站点，其图片服务代码另行维护。

保留 `BUILD_TOKEN` 的原值：私有 R2 中部署链接的加密密钥由它派生。正常更改服务名、邮箱或桶名不是数据迁移工具；账号建立后更换登录邮箱应做受控账号迁移，不能只改变量。图片桶绑定与图片地址必须指向同一套图片数据。

忘记密码时，目前通过受控维护流程恢复账号；仓库没有公共重置或注册入口。仅轮换 `SETUP_TOKEN` 不能绕过已初始化账号的保护。

发布失败先查看 Workers Builds 记录、构建 Secret、后台地址及 Hook 分支是否匹配。构建成功还需部署成功；后台最终通过公开网站的 `_release.json` 确認目标版本上线。恢复使用 Workers 部署历史和 R2 快照，避免把未发布草稿当作线上版本。

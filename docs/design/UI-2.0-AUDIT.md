# PR-00 · UI 审计与可重复基线

审计基准：master 的 7a155d59c3dceda9253caba61a6f02044d973c5b（PR #8）。
这是源码审计与隔离实验基线，不涉及任何作者的线上站点、账号或生产 R2。
设计与实施约束见 [计划](UI-2.0-PLAN.md) 和 [规范](UI-2.0-SYSTEM.md)。

## 页面、组件与工作流清单

| 区域 | 当前实现与需要保留的行为 | 后续设计阶段 |
| --- | --- | --- |
| 首页/Header/页脚/关于/404 | render.rs 生成完整 HTML，首页文章列表，关于可关闭；正文无 JS 可读 | PR-03/04 |
| 文章页 | article-shell 与 article-body，Rust Markdown/KaTeX；首图 eager，后图 lazy | PR-04 |
| 主题 | 公共 styles.css 与后台 style.css 各有明暗颜色表；共同使用 localStorage 的 theme | PR-01 |
| 页面导航 | client.js 建 Swup；page:view 重建页内功能，cleanupFunctions 清理监听；减少动态效果关闭过渡 | PR-02/04 |
| 搜索 | 自定义 role=dialog + inert，打开聚焦输入，Esc 与焦点循环，异步加载索引 | PR-04 |
| 目录 | 动态标题 ID、IntersectionObserver/滚动跟踪；≤1300px 为可关闭抽屉 | PR-04/07 |
| 图片放大/分享 | 原生 dialog，Esc/关闭按钮、返回触发焦点、背景锁定；链接图片保留作者动作 | PR-04 |
| 代码/表格 | 代码复制与状态文本；pre/table 可键盘横向滚动 | PR-04 |
| 登录 | login-view，邮箱/密码与错误区；async 会话检查，不应动画中闪出已登录工作区 | PR-05 |
| 首次设置 | 两步 fieldset、必填验证、返回、初始化口令；完成后在浏览器生成首页 | PR-05 |
| 后台壳/文章首页 | 左侧文章选择与下方图片/设置/导入导出入口；主区显示文章管理 | PR-05 |
| 编辑器 | 标题/摘要/日期/slug、正文/预览、字数；窄屏切换面板 | PR-06 |
| 自动保存/并发保护 | 1500ms 防抖，ETag 冲突保留输入；dirty/savedVersion、savePromise 与导航版本保护 | PR-06：禁止改业务语义 |
| 预览 | Worker/WASM，350ms 防抖；iframe 无脚本，图片异步解析，主题原地同步 | PR-06 |
| 发布 | 单篇/站点分开、pending 状态、aria-busy、浏览器生成上传与版本提交 | PR-06：禁止改流程 |
| 图片库 | 多图上传、搜索/引用筛选、预览、复制/插入、引用保护、真实删除与分页 | PR-06/07 |
| 网站设置 | 信息/外观/关于/可选统计；保存与发布分开 | PR-06 |
| 账号 | 当前密码验证、修改邮箱或密码、其他会话失效 | PR-06 |
| 备份恢复 | ZIP 下载；恢复草稿，不覆盖线上指针；进度/错误保留 | PR-06 |
| 异步通知/确认 | action() 禁重入、aria-busy、notice 状态；部分危险操作用原生 confirm | PR-02/06 |
| 手机/辅助功能 | 后台 650/760/1099px，前台 720/1300px 等断点；焦点、Esc、减少动态效果已有基础 | PR-01/07/09 |

源码入口：

- [公开模板](../../crates/blog-core/src/render.rs)、[CSS](../../crates/blog-core/src/assets/styles.css)、[交互](../../crates/blog-core/src/assets/client.js)。
- [后台 DOM](../../cloud-admin/ui/index.html)、[CSS](../../cloud-admin/ui/style.css)、[状态逻辑](../../cloud-admin/ui/app.js)。
- [预览](../../cloud-admin/ui/preview.js)、[图片库](../../cloud-admin/ui/images.js)、[备份](../../cloud-admin/ui/backup.js)。
- [构建](../../scripts/build-web.sh)、[公共资源打包](../../scripts/web-assets.mjs)、[后台打包](../../cloud-admin/build-ui.mjs)。

## 现状结论

1. 前后台两套变量名称、颜色表和断点容易漂移；正式共享机制需要同时覆盖
   Rust 原始 CSS、后台打包和 iframe 预览。
2. 样式有后置覆盖；升级应逐阶段替换对应部分，避免追加第三套颜色规则。
3. 新版将用选中容器和表面层次区分操作区，不给每段正文加卡片。
4. 改 DOM 之前必须保留 ID/事件绑定契约，尤其不能重绘编辑区而丢失焦点、
   选区和未保存文本。
5. 图片、搜索和目录已有键盘支持，升级需要回归验证。
6. FlClash 的跨尺寸原生应用方向适合参考；不照搬代理仪表盘、系统权限或数据指标。

## 截图与性能生成方式

~~~sh
npm ci
npm run build
npm run check
npx wrangler deploy --dry-run --outdir cloud-web/dist
cd cloud-admin
npx playwright install --with-deps chromium firefox webkit
cd ..
npm run test:ui:audit
~~~

scripts/ui-audit.mjs：

- 在 127.0.0.1 启动临时 Miniflare + R2，创建通用演示账号与四篇演示文章，
  用真实后台 UI 和 WASM 发布三篇，留一篇草稿；退出时 dispose。
- 正式代码在此阶段未修改，before 就是固定基准的正式 UI。
- Chromium 捕获四个主要画面 × 1440/390/360px × Light/Dark：
  每版本 24 张，before 和 prototype 共 48 张主要截图。
- 另捕获 1440/390px 的登录、初始化、图片库与设置；初始化只模拟 initialized=false，
  其余使用实际后台状态；图片库空状态也是审计对象。
- Firefox/WebKit 补原型 390px 明暗截图和关键交互；Chromium/WebKit 触屏模拟。
  当前正式后台业务回归仍由既有 Chromium 套件负责。
- 检查原型溢出、主要 Token 对比、搜索/图片弹窗 Esc 与返回焦点、
  减少动态效果、编辑保留、快速导航、加载状态，以及无对外网络/API 请求。
- CI 的 ui-design-review artifact 包含报告、PNG 和原型，不提交截图二进制。

输出 build-work/ui-audit 被 .gitignore 排除。
index.html 用于比较截图；report.json 记录浏览器版本、提交、资源及实验指标。
GitHub Actions artifact 需要登录下载；这不是公开预览站点，也没有创建 Cloudflare Worker。

## 资源与性能口径

report.json 记录正式公共 client/styles、后台 app/styles/preview Worker、
WASM 和原型 HTML/CSS/JS 的原始、gzip、Brotli 字节。
PR-00 不引用原型进入生产构建，正式依赖、资源与业务路径不变。
压缩大小用于对比；服务是否采用对应 Content-Encoding 是另一件事。

实验记录 DCL、LCP（支持时）、CLS、长任务（支持时）、资源数/传输字节与 HTML 字节。
每页只有单次样本，引擎、字体、缓存和机器会影响数值。
缓存命中、取消请求或跨源限制可能使 transferSize 为 0，
因此构建文件大小是字节对比的主要口径，不能将 resourceBytes 直接当真实流量。

实验为本地网络、系统字体、CDN 样式 stub；不代表用户 CWV、互联网图片加载、
真实 KaTeX 字体加载或移动耗电。未实测为 null，不填估计值。
源码字节与构建后体积不能混用；后续在同一 CI 和内容下对比。

基准源码 UTF-8 字节（构建值见报告）：

| 文件 | 字节 |
| --- | ---: |
| crates/blog-core/src/assets/styles.css | 19795 |
| crates/blog-core/src/assets/client.js | 25683 |
| cloud-admin/ui/style.css | 22059 |
| cloud-admin/ui/app.js | 34915 |
| cloud-web/theme.js | 550 |
| cloud-admin/ui/admin-theme.js | 1193 |

后续还需多次冷/热加载、4× CPU 限速、真实 iOS Safari/Android Chrome、
5 分钟交互、软键盘、低端设备与 CSS 回退验证。
PR-00 不宣称完成真机验收或全面 AA 合规。

## 人工视觉审查清单

- [ ] 确认四页 1440px Light/Dark。
- [ ] 确认 390px 和 360px 的密度、长标题、正文与工具区。
- [ ] 比较墨绿与中性，选定主方向。
- [ ] 确认圆角、表面、阴影和字体。
- [ ] 检查焦点与系统减少动态效果。
- [ ] 记录设计修改，再进入 PR-01。

自动截图不等于人工审查通过。原型的发布、保存与图片操作是演示，
不能据其判断正式业务已迁移。

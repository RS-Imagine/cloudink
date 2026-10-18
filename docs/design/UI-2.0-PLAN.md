# CloudInk 2.0 UI/UX 升级计划

版本 V1.0 · 方案 C · 2026-10-18。依据项目作者提供的执行计划。
本文件约束后续 UI PR 的范围；具体设计见 [设计规范](UI-2.0-SYSTEM.md)，现状与验证方法见 [审计](UI-2.0-AUDIT.md)。

## 目标与边界

以 Material You 的语义色彩、Apple 式直接反馈与 CloudInk 的阅读、写作特色，
建立统一的明暗主题、排版、组件、响应式布局和可中断动效。
允许重做暖纸色、导航及布局，保留名称、项目标志与现有业务能力。

保持一个 Cloudflare Worker、一个私有 R2、Rust/WASM 发布排版、原生 JavaScript/CSS 与 Swup。
不引入 React、Vue、Flutter Web、数据库、持久化服务或新的必填环境变量。
草稿自动保存和并发保护、发布、认证/会话/CSRF、图片引用保护、存储格式、
版本指针和恢复、Markdown/KaTeX/代码语义均不得因 UI 改造而改变。
测试只使用本地 Miniflare 的临时存储和通用演示内容。

## 独立 PR 与上游

| 阶段  | 分支                           | 范围                                                         | 验收及依赖                                 |
| ----- | ------------------------------ | ------------------------------------------------------------ | ------------------------------------------ |
| PR-00 | design/ui-audit-and-foundation | 现状审计、前后台截图、资源/性能基线、设计规范、四页交互原型  | 人工确认视觉方向后进入 PR-01               |
| PR-01 | feat/design-system             | 单一 Token 来源、明暗主题、基础控件、圆角回退、无闪烁主题    | 基于已合并 PR-00；旧页面仍可用             |
| PR-02 | feat/motion-system             | CSS/JS 动效工具、物理弹簧、速度衔接、中断/取消、减少动态效果 | 基于 PR-01；快速操作状态一致               |
| PR-03 | feat/reader-home-redesign      | Header、首页、文章卡片、页脚、响应式与无脚本导航             | 基于 PR-02；原有 URL/SEO 保留              |
| PR-04 | feat/reader-experience         | 阅读、目录、代码/表格/图片、搜索、分享、Swup 及滚动恢复      | 基于 PR-03；Markdown/数学/高亮回归通过     |
| PR-05 | feat/admin-shell-redesign      | 后台壳、侧边导航、首页、登录和初始化                         | 基于 PR-02；业务事件与状态逻辑保留         |
| PR-06 | feat/admin-workflows-redesign  | 编辑器、保存/发布反馈、图片库、设置/账号/备份                | 基于 PR-05；关键工作流通过                 |
| PR-07 | feat/mobile-interactions       | 手机导航、Bottom Sheet、拖拽/停靠/回弹、安全区与软键盘       | PR-04 与 PR-06 合并后；手势有点击/键盘替代 |
| PR-08 | feat/expressive-surfaces       | 有限区域玻璃/光影、性能对比与不透明降级                      | 基于 PR-07；Shader 仅在有实测收益时采用    |
| PR-09 | chore/ui-release-hardening     | 全面回归、性能对比、CSS 清理、文档、前后对比与发布说明       | 全部上游合并；人工视觉与兼容性验收         |

PR-03、PR-05 可在共同上游稳定后分别进行；每个 PR 写明确切上游 SHA。
不在一个 PR 提前实现后续阶段。M1=PR-00，M2=PR-01/02，
M3=PR-03/04，M4=PR-05/06，M5=PR-07/08，M6=PR-09。
PR-00、PR-01 与 PR-02 已确认并合并（#9、#10、#11）。
当前推进 PR-03：正式首页、文章卡片、全局页眉/页脚与原生手机折叠菜单。
继续复用已完成的共享 Token、主题色与动效；阅读正文/搜索重设计仍在 PR-04，后台布局仍在 PR-05/06。

## 各阶段统一门槛

适用检查：

```sh
npm run format:check
npm run build
npm run check
npx wrangler deploy --dry-run --outdir cloud-web/dist
npm test
cargo test --workspace --locked
npm run test:web:browser
npm run test:ui:audit
```

最后一项是 PR-00 增加的隔离设计检查，需事先安装 Chromium、Firefox、WebKit。
真实 Safari/iOS 与真机触屏还需在对应阶段手动验证；Playwright WebKit 不等于真实 Safari。
截图至少覆盖 1440、390、360px 和明暗主题。减少动态效果、键盘焦点、Escape、
返回焦点、网络/异步错误、编辑器竞争和发布后公开页均按改动范围验证。

每个 PR 提供设计目标、前后截图、Token/动效参数、测试、性能/依赖影响、
兼容性限制和可执行回滚方式。CI、业务回归、人工视觉审查、性能门槛都通过后再合并。
PR-00 原型必须先经项目作者确认，不能将自动测试通过视为视觉确认。

## 动效与视觉约束

小状态变化 120–180ms，内容切换 200–300ms，页面 300–450ms，弹窗 250–450ms，
列表交错 30–60ms，均是初始设计值。
交互弹簧使用质量、阻尼、刚度、实际初速度求解，不以 CSS 回弹曲线冒充物理模拟。
支持中断、反向和系统减少动态效果；优先 transform/opacity，避免连续布局读取。
玻璃限制在少量导航与浮层，保持不透明回退，不覆盖长正文或整个编辑器。

## 回滚与发布

每阶段通过 revert 自己的合并提交回滚，不需要清空、迁移或恢复用户数据。
PR-00 不接入构建产物或 Worker 路由；回滚仅删除原型、规范和审计工具。
后续公开模板变更随 Worker 部署更新后，还需重新发布内容，以更新既有文章 HTML。
代码合并、生产部署与内容重新发布是不同步骤；阶段 PR 不自行操作生产数据。

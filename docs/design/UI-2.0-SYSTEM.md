# CloudInk 2.0 设计规范 · PR-00 提案

状态：等待第一轮人工视觉确认。实现规范将随每个阶段的实测更新。
[四页原型](../../prototypes/ui-2.0/README.md)展示拟采用的比例、层次与交互。
原型与当前正式 UI 并存，未改变正式网站或后台。

## 视觉方向

**墨绿（建议）**：雾白底、墨绿主色、浅青绿选中面、近黑正文。
暖纸色不再承担全部层次；通过表面明度、留白、形状和少量阴影区分区域。
**中性（比较项）**：保留相同布局，以灰蓝替换主色与选中色。
原型底部“墨绿/中性”按钮可即时比较；两种方案均有明暗主题。

前台保持安静的编辑式阅读节奏；后台使用明确的工作区和稳定工具栏。
连续圆角用于容器，较小圆角用于控件，胶囊只用于状态和分段选择。
避免每个区域都浮起、全屏模糊、彩色正文和持续背景动画。
保留原项目 SVG，不复制 FlClash 的图片、字体、Dart 或 GPL-3.0 实现代码。
程序生成的山形插图是本项目原型的装饰性视觉样本，不要求新增封面图配置。

## 信息架构与断点

| 宽度 | 公开网站 | 后台 |
| --- | --- | --- |
| 0–759px | 18–20px 页边距、单列、直接搜索/主题入口，目录收束 | 单列工作区、底部主要入口、写作/预览切换 |
| 760–1099px | 28px 页边距；阅读内容优先，空间足够时显示目录 | 88px 图标导航轨、完整可访问名称，工具栏可换行 |
| ≥1100px | 1160px 内容容器；文章正文上限约 720px、独立目录 | 224px 侧栏；分栏编辑器、稳定顶部操作区 |

断点使用布局可用空间，不按设备品牌判断。实际迁移时以长标题、200% 缩放和
虚拟键盘验证，不将原型的 759/1099 硬编码为不可更改的产品规则。
公开站点原有首页、文章、关于 URL 保留；后台不新增业务路由或数据分类。
原型的分类文案仅为演示排版，后续不能据此新增必填分类、表结构或配置。

公开信息层级：站点身份/导航 → 简介 → 最新文章 → 其他文章 → 页脚。
后台：工作台/文章/图片/设置 → 当前工作区 → 主操作/状态 → 内容。
备份、账号和运行信息属于设置；手机导航仅放高频入口，设置仍需可访问。
编辑器保持标题/摘要/文章属性 → 工具栏 → 正文/预览 → 字数与状态，
保存与发布始终清晰区分，不因动画替换真实服务端状态。

## Token 单一来源方案

本阶段候选值仅定义在 [tokens.css](../../prototypes/ui-2.0/tokens.css)，
供四个原型页面共享。没有将它复制进正式前后台。
PR-01 将确定后的 Token 移到仓库共享的 CSS 源，
Rust render.rs 通过 include_str! 引入该源，后台 build-ui.mjs 拼接同一份源；
公开样式哈希应包含 Token 内容，预览沿用同一套公开样式。
纯 CSS 引用不需要 Node 生成 Rust 文件，也不新增运行时配置。
正式颜色、系统跟随和显式主题覆盖均从这一个源生成/引用，禁止维护两套颜色表。

命名采用 --ci-*；逻辑映射如下：

| 逻辑角色 | CSS 名称 | 起始值/规则 |
| --- | --- | --- |
| color.primary / onPrimary | --ci-primary / --ci-on-primary | Light #24594f / #fff；Dark #a4d3be / #123c30 |
| color.primaryContainer / onContainer | --ci-primary-container / --ci-on-primary-container | 选中/轻操作，保持文本对比 |
| surface / surface.elevated / container | --ci-surface / --ci-elevated / --ci-container | 基础、浮层、嵌套区域 |
| text / text.secondary / outline | --ci-text / --ci-muted / --ci-outline | 正文、次级信息、可交互边界 |
| error / success / warning | --ci-error / --ci-success / --ci-warning | 图标/文字同时解释，不仅靠颜色 |
| type.display / title / body / caption | --ci-type-* | 40–72 / 28–44 / 16 / 13px；正文阅读 17–18px |
| font.ui / reading / mono | --ci-font-* | 系统 UI、系统衬线阅读、系统等宽；不新增远程字体 |
| radius.sm / md / lg / xl | --ci-radius-* | 8 / 14 / 22 / 32px |
| spacing.1…12 | --ci-space-1…12 | 4px 基础栅格，4–48px |
| shadow.soft / floating / overlay | --ci-shadow-* | 卡片、浮动入口、模态；暗色减弱边缘阴影 |
| motion.fast / standard / emphasized | --ci-motion-* | 150 / 250 / 380ms；减少动态效果时归零 |
| layer.base / navigation / modal / toast | --ci-layer-* | 0 / 20 / 60 / 80；原生 dialog 在 top layer |
| state.hover / pressed / selected / disabled | --ci-hover + 对应组件状态 | Hover 色层、按压缩放、选中容器；禁用文字与语义明确 |

PR-01 应补齐统一的 pressed/selected/disabled 状态 Token，而不是继续在组件中散落数值。
圆角先使用 border-radius，再在 @supports (corner-shape: squircle) 内增强；
不支持的浏览器保持普通圆角。原型不会使用 SVG 裁切改变控件命中区域。

## 排版与内容

UI 默认 15–16px，次级说明 12–13px，不将关键状态缩成装饰文字。
中文阅读正文 17–18px，行高约 1.9；英文与长链接使用自然换行和 overflow-wrap。
标题允许断行，不截断读者需要理解的信息。后台文章列表可在不丢失可访问名称时截断。
代码使用独立等宽字体并可键盘横向滚动；数学和表格保留语义与原有渲染管线。
原型预览只做安全的文本/标题/引用示意，不实现新的 Markdown 引擎。

## 组件契约

共通状态：Default、Hover、Pressed、Focus-visible、Selected（适用时）、
Disabled（真实 disabled/aria-disabled 与事件保护）、Loading、Success、Error。
所有提交按钮 loading 时保留尺寸、可理解名称和 aria-busy；结果有就近文字/状态区。

| 组件 | 外观/尺寸 | 行为与可访问性要求 |
| --- | --- | --- |
| Button | 44px 高、14px 圆角，主/轻/中性/危险 | 明确主操作，等待时防重复提交；按压不移动布局 |
| IconButton | 44×44px，20px 线性图标 | aria-label；不只依赖 title；键盘触发 |
| Card | 22–32px 圆角、柔和边框 | 可点击整体卡片使用单一链接，避免嵌套交互控件 |
| Input / Textarea | 持续可见标签、14px 圆角 | 错误描述关联 aria-describedby，不以 placeholder 代替标签 |
| Switch | 拨杆配明确名称与状态 | 原生 checkbox 或 role=switch，Space 操作，禁用不提交 |
| Select | 同输入高度、可见当前值 | 优先原生 select；不为外观损失键盘和手机选择能力 |
| Navigation / Sidebar | 选中容器与图标、稳定位移 | aria-current；图标轨有名称；所有入口可达 |
| Tabs / Segment | 40–44px 命中区域 | 真 tab 用 tablist/方向键；筛选用按钮组与 aria-pressed |
| Dialog | 32px 圆角，明确标题与关闭 | 原生 dialog 优先，Esc、焦点约束、返回触发点、背景锁定 |
| Sheet | 顶部抓手但不作为唯一入口 | PR-07 实现停靠/拖拽；关闭按钮与键盘替代；避免滚动争抢 |
| Dropdown | 表面浮层，8–12px 项间距 | 展开状态/方向键/Esc；菜单外点击；焦点恢复 |
| Toast | 紧凑状态面，不遮挡主操作 | role=status；错误就近保留，不靠短时 Toast 承载唯一信息 |
| Tooltip | 简短辅助解释 | Hover 与焦点都可出现；触屏有可理解名称，不承载必需步骤 |
| Loading | 稳定占位、文字说明 | 不因骨架插入改变正文宽度；减少动态效果时静态 |
| Empty State | 简洁图标/短句/下一步 | 区分无内容、筛选无结果、失败与无权限，不伪造空数据 |
| Feedback | 图标、文字、语义色 | 409 冲突保留输入，发布失败保留上次成功版本与重试入口 |

## 动效契约（正式实现属 PR-02）

固定过渡用于颜色/淡入/非手势位移；prototype 的短 CSS 按压反馈仅展示意图。
真实弹簧需要状态 x、速度 v、目标 target、质量 m、刚度 k、阻尼 c：
m*x'' + c*x' + k*(x-target)=0。
换目标时保留 x/v；pointer release 提供采样初速度；按 dt 求解，长时间间隔要限步。
优先精确解析解或稳定积分，不让大 dt 导致爆炸，不每帧创建对象或测量布局。
初始建议：小控件 m=1、k=420、c=34；Sheet m=1、k=300、c=32，均需实测校准。
退出与进入可取消/反向；完成回调不能覆盖更晚的状态，统一取消句柄。
系统减少动态效果时直接落终态，关闭大位移与交错，保留状态和操作反馈。
前台 Swup 导航、浏览器返回/滚动恢复使用同一清理/取消周期，避免重复监听与弹层残留。

PR-08 再评估玻璃：先比不透明与轻量 backdrop-filter，再决定有无必要使用 Shader。
原型当前使用不透明表面；未实现手势弹簧、真实折射或生产导航过渡。

## 可访问性与性能门槛

正文/按钮文字按 4.5:1，大字与非文本必要边界按 3:1 相关要求审查；
自动化只验证 Token 常用组合，不能代替完整 WCAG 2.2 AA 审计。
项目目标为主要触控入口至少 44px；这高于 WCAG 2.2 AA 2.5.8 的 24px 最低要求，
不能把 44px 写成 AA 强制门槛。焦点不被浮动导航遮挡，200% 缩放与长文本需人工复核。
dialog 的关闭/结果焦点回归需桌面与触屏验证；不制造焦点陷阱。

当前 PR 正式包字节必须不变，因为未接入生产构建。原型资源单列报告。
PR-01/02 的起始预算：共享 Token gzip ≤4KiB，动效工具 gzip ≤4KiB，无新增运行时依赖；
最终数值以构建报告和当前功能对比为准。禁止持续空闲 rAF，
玻璃/弹簧的帧耗时、耗电、软键盘及真机滚动在对应阶段验收。

## 参考资料与原创边界

- [FlClash 项目](https://github.com/chen08209/FlClash)：参考其公开产品方向、跨尺寸布局与原生交互目标；未导入实现或素材。
- [Material 3 颜色角色](https://m3.material.io/styles/color/roles)：角色与表面层次，不复制现成主题。
- [Apple Motion](https://developer.apple.com/design/human-interface-guidelines/motion)：直接反馈、连续性与减少动态效果原则。
- [MDN corner-shape](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/corner-shape)：仍需支持检测和普通圆角回退。
- [WCAG 2.2 目标尺寸](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)：最小尺寸与例外解释。

## 第一轮视觉确认

查看四页的明暗主题与手机截图，比较墨绿/中性。需要确认：
整体色彩与圆角是否合适；前台阅读密度是否舒适；后台工具区是否清晰；
编辑器分栏与手机单栏是否可接受。确认后才将 Token 与布局接入正式产品。
此项应由项目作者明确完成，CI 不会自动勾选。

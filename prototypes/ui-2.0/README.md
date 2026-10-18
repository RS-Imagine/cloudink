# CloudInk 2.0 · PR-00 交互设计原型

四个画面：首页、文章页、后台工作台、编辑器。
共用 tokens.css；Light/Dark 与墨绿/中性方案可即时比较。
原型不接入正式构建、账号、存储、发布或线上站点。
姓名、文章和状态均为通用演示内容，未使用生产数据。

## 查看

从 CI 下载 ui-design-review，解压后打开根目录 index.html 查看截图，
进入 preview/prototypes/ui-2.0/index.html 操作原型。
原型使用普通脚本，解压后可直接用浏览器打开，不需要克隆或安装工具。

开发者也可以在仓库根目录启动静态服务：

```sh
python3 -m http.server 4173 --bind 127.0.0.1
```

打开 http://127.0.0.1:4173/prototypes/ui-2.0/。
导航使用 #home、#article、#dashboard、#editor；浏览器前进/后退可用。
底部浮动条是审阅工具，不是拟上线的产品导航；?capture 可以隐藏它。
?theme=dark 或 ?theme=light 固定主题，?palette=neutral 比较中性方案。

## 可操作内容

- 底部切换四页和配色；页面月亮图标切换明暗。
- 首页/文章导航、目录锚点、搜索结果及空状态。
- 工作台筛选、图片弹窗、Escape 与焦点恢复。
- 编辑标题/摘要/正文、示例格式、写作/分栏/预览切换。
- 保存/发布仅模拟等待与反馈，不写入数据。
- 标签页内切换保留演示文本；刷新不持久化。
- 系统减少动态效果关闭过渡，不需要动画即可操作。

原型预览只是安全文本/标题/引用示意，不替代正式 Rust/WASM。
物理弹簧、手势 Sheet 与玻璃属于 PR-02/07/08，当前未实现。
SVG 标志不变；装饰由原创 CSS 生成，无外部字体、图片或运行时依赖。

## 文档与验证

- [执行计划](../../docs/design/UI-2.0-PLAN.md)
- [设计规范](../../docs/design/UI-2.0-SYSTEM.md)
- [审计及基线](../../docs/design/UI-2.0-AUDIT.md)
- npm run test:ui:audit：生成旧版/原型截图和报告；
  需项目构建与三个 Playwright 浏览器，详见审计文档。

视觉方向由项目作者确认后，进入 PR-01。

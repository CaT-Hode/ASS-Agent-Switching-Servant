# Logo 与图标导出

图形以用户提供的 `docs/assets/ass-reference-flat.png` 为参考，矢量底稿为 `public/ass-logo-reference.svg`。八片花瓣保留各自的曲线，最终图形由 `scripts/brand-geometry.cjs` 生成，使用白色花瓣与橙色中心。

在项目根目录运行 `npx electron scripts/make-icons.cjs`，统一生成：

- `public/ass-logo.svg` 与透明 PNG。
- `public/ass-app-icon.png`，用于界面。
- `assets/ass.ico`，包含 16、24、32、48、64、128、256px，用于 Windows 程序、托盘和开始菜单。
- `design/logo/ass-preview.png` 与几何预览数据，便于调整图形。

修改几何源后统一导出，避免各入口分别调整比例或颜色。参考底稿最初使用 node-potrace 描摹，应用与发布包不包含该工具的代码。

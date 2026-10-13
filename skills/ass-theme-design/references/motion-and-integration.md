# 动效与接入

## 复用边界

`assets/` 是从 ASS 的主题模块抽取的可独立参考实现：

- `theme-control.jsx`：太阳 / 月亮 / 黄昏 SVG、主题状态、指针和键盘入口。
- `theme-control.css`：必要语义 token、胶囊场景、低幅循环与快照样式；不包含 ASS 页面布局、logo 或供应商列表。
- `theme-motion.mjs`：跟手、边缘阻尼、临界阻尼弹簧及停靠点选择。
- `theme-reveal.mjs`：真实点击圆心、整窗快照、在途取消和受限输入恢复。

这些模板需要 React / React DOM，但纯 CSS 与两个 `.mjs` 可用于其他技术栈。不需要 ASS 后端、账户文件或任何网络服务。

## React 接入

将四份模板放在同一组件目录，导入 CSS。在客户端渲染入口提供已保存的 mode 和持久化回调：

```jsx
import { useState } from 'react';
import { ThemeControl } from './theme-control.jsx';
import './theme-control.css';

function ThemeSetting() {
  const [mode, setMode] = useState(() => localStorage.getItem('ass-theme') || 'system');
  return <ThemeControl value={mode} onChange={setMode} />;
}
```

模板沿用 `ass-theme` 作为示例存储键，接入目标应用时统一替换为已有键或现有设置层，不新增第二套互相覆盖的偏好来源。服务端渲染应用把 DOM 初始化放进客户端模块，提前应用保存值避免闪烁。

胶囊可以直接使用。不要给它和内部层叠加目标项目的通用 `transition: all` 或整按钮按压缩放；模板已用同一个呈现值驱动场景。

默认三个停靠点为 `light / system / dark`。需要双色版本时同时调整 `modes`、`themePositions`、`themeAtPoint`、释放投影的停靠点数、键盘边界及可访问状态；删除自动场景，滑块保留两端行程。不能只隐藏中间图标，仍让中间点击进入自动。

## 胶囊和全站切换是两套运动

胶囊是直接操控：临界阻尼弹簧从当前呈现位置与速度开始，按下立即可抓取，释放以短时采样速度投影到最近停靠点。ASS 参考频率为 28、越界阻力较强但不生硬停止。

圆形揭幕是一次性语义转换：使用全站旧 / 新快照，无弹性、无回弹、无过冲。默认 960ms、`cubic-bezier(.4,0,.6,1)`，两端速度为零；中段低峰值，后半程持续减速。不要把装饰循环、胶囊弹簧和整窗揭幕绑成相同节奏。

如果调整时长或曲线，检查实际每帧半径，尤其最后 100–200ms：不能在结束时突然补齐大块区域。普通菜单的短时长不直接套用到整窗蒙版。

## 清晰圆形揭幕

参考 [VitePress appearance toggle](https://vitepress.dev/guide/extending-default-theme#on-appearance-toggle) 与 [Chrome 同文档 View Transitions](https://developer.chrome.com/docs/web-platform/view-transitions/same-document)。不要复制第二套 React 树或整个 DOM 作为遮罩。

1. 在实际用户入口调用 `document.startViewTransition`；不要因为任意状态刷新都触发一次整窗动画。
2. 捕获旧配色后，在更新回调中应用所选主题 / 实际 `color-scheme`，React 需要时在该回调中提交状态。自动模式先固定旧实际配色，再处理系统变化，避免媒体查询抢先把旧快照变成新颜色。
3. 在 `ready` 后，仅动画 `::view-transition-new(root)` 的 `clip-path`，旧快照保持不透明在下层。关闭默认淡化及混合模式，边缘不加 blur、羽化或彩色光圈。
4. 指针圆心使用真实 `clientX / clientY`。键盘、拖拽释放、系统主题事件使用开关中心。任何位置的开关，包括右上角，都用同一几何计算。
5. 先求最远角半径 `D = hypot(max(x, width-x), max(y, height-y))`，最终半径为 `D + clamp(D * .06, 32, 96)`。几何上刚好覆盖不等于收尾安全；不要只多留 1–2px，也不要把半径无限放大导致推进过快。不要用宽度当半径。
6. 末尾重复完整覆盖帧，例如同一最终 clip-path 的 offsets `[0, .99, 1]`。真实画面需要在解除快照之前已完整换色，不能依赖清理动作把剩余角落补上。

两个方向都从小圆扩张，让圆内显示新主题；不在浅→深时换成“旧主题收缩”的另一套规则。

## 状态和清理

- 分开保存 `mode = light / dark / system` 与 `resolved = light / dark`。只有实际配色变化才播放揭幕。
- 只允许一套在途快照。连续切换取消旧快照并直接提交最新选择，优先响应，不排队等待 960ms。
- `skipTransition()` 仍可能执行更新回调；使用代际标识和 `applyOnce`，被替代的选择不能稍后重新写回。
- 结束、取消、失败均清除 `fill:both` 的 WAAPI 动画，否则后续过渡可能复活旧蒙版。缩放或隐藏窗口也清理。
- 不支持 API、隐藏或系统 `prefers-reduced-motion: reduce` 时直接应用主题，不改变持久化语义。
- 某些 Chromium 快照会把命中测试交给根节点。模板只在过渡期间向已存在、实际命中的主题控件交还输入；弹窗挡住主题按钮时不能穿透。不要转发到任意页面选择器。

## Electron 窗口区域（仅目标项目需要时）

Windows 原生 caption overlay 不在浏览器快照中。先明确需求：保留原生窗口按钮，接受它们不参加圆形遮罩；或者改成页面内绘制，加入快照，但需要实现窗口控制、状态订阅和原生能力取舍。

页面内按钮仅通过固定白名单 IPC 操作自己的窗口：最小化、最大化 / 还原、既有关闭行为。不要把“关闭到托盘”改成结束路由，不操作其他 harness。窗口状态使用顺序号抵御异步旧回复。

原生 modal 的 inert / backdrop 不应挡住 caption：遮罩从顶栏下方开始，必要时只向三颗固定窗口按钮恢复命中输入，不顺带关闭弹窗。浏览器中不需要这套特殊处理。仅绘制按钮不等于拥有 Windows 11 原生悬停贴靠菜单，需如实说明。

## 一轮验证

先完成相关编辑，再一起检查真实界面：浅→深、深→浅、连续反向、拖拽中抓取、自动系统切换、键盘中心圆心、弹窗下的窗口按钮、缩放 / 隐藏、减少动态效果。采样 25% / 50% / 75% / 接近结束的蒙版，确认后半段减速及最后一帧无大块跳变。

截图只能证明形态；运动速度需要真实动画的计算进度 / 连续帧证据。不要用静态 build 成功代替交互验证，不调用目标项目之外的账户或服务。

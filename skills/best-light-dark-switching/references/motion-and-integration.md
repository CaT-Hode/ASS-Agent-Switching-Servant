# 运动与接入

## 模块与状态

- `theme-control.jsx`：所选模式、系统实际配色、图形、持久化与指针 / 键盘接入。
- `theme-motion.mjs`：停靠点映射、边缘阻力和闭式临界阻尼弹簧。
- `theme-reveal.mjs`：整窗圆形蒙版、代际取消、同色回声保护与过渡中的命中输入恢复。
- `theme-control.css`：语义色、场景、装饰暂停和快照层。此文件不包含业务页面与账户逻辑。

React 最小接入：

```jsx
import { useState } from 'react';
import { ThemeControl } from './theme-control.jsx';
import './theme-control.css';

function Appearance() {
  const [mode, setMode] = useState(() => localStorage.getItem('ass-theme') || 'system');
  return <ThemeControl value={mode} onChange={setMode} />;
}
```

已有设置层时改用该层提供的 mode / 回调，不照示例新增竞争状态。其他框架复用机制，无需引入 React。

## 两套独立运动

胶囊属于直接操控。当前停靠点为 0 / .5 / 1；点击按实际位置映射，拖拽从当前呈现位置抓取，释放速度来自短时采样。参考弹簧频率 28，重定向保留位置与速度。不要另加 `transition: all` 或整个按钮的按压缩放。

全屏圆形揭幕属于语义换色，不用弹簧。旧 root 图像在下，新 root 在上，仅为新 root 的 clip-path 做扩张。

### 不让滑块被旧截图遮住

当前实现仅在揭幕期间给胶囊 `view-transition-name: ass-theme-control`，隐藏该命名层的旧图，显示实时新视图，并关闭该层默认交叉淡化与几何动画。root 的圆形动画不受影响。

名字是参考实现的内部标识，可成套替换；单页多个入口需要各自唯一名称。不要给命名胶囊层套用 root 的全窗尺寸或 `transform: none`，否则它会跑到错误位置。弹窗遮挡时不提升主题按钮，也不恢复其穿透输入。

## 圆形轨迹和坐标

当前实现参考 [Chrome 同文档 View Transitions](https://developer.chrome.com/docs/web-platform/view-transitions/same-document) 和 [VitePress appearance toggle](https://vitepress.dev/guide/extending-default-theme#on-appearance-toggle)。

1. 在真实选择入口发起 startViewTransition；捕获旧配色后提交新 mode 和 resolved 配色。
2. 根快照及 root 图像组显式铺满可视窗口，关闭默认淡化、混合和位移。
3. 圆心取触发按钮 getBoundingClientRect 的中心，换算为窗口百分比坐标；不使用内部任意点击点，不固定左下角。
4. 当前目标半径为 `hypot(width, height) * 2 + 96`，大于完整窗口对角线。半径与直径、CSS 像素与设备像素不能混用。
5. 当前总时长 2000ms，offsets 为 `[0, .98, 1]`。从零到完整半径只用一次 `cubic-bezier(.2,0,.55,1)`，最后 2% 保持。外层 timing 为 linear，不叠加两次缓动。

这些是可复现的参考值。调整时保持整个距离的连续单峰速度、末速归零和完整覆盖，不在约 80% 后追加快扩张。分别观察时间进度、半径进度和实际窗口覆盖面积。

## 取消与兼容

- mode 与 resolved 分开；自动档只在实际配色变化时揭幕。
- 新输入取消在途快照并采用最后选择，不锁控件、不排旧选择队列。
- skipTransition 仍可能触发更新回调；代际标识和 applyOnce 阻止旧选择迟到写回。
- 已提交后的同色回声不取消在途圆形动画；重复或微小尺寸通知也不提前结束。
- 结束、失败、取消都清理 fill:both 动画；真实尺寸变化或隐藏走清理路径。
- 无 API / 隐藏 / 减少动态效果时直接应用主题，不改变持久化语义。
- 部分 Chromium 过渡命中根节点；只向真实命中的既有主题按钮恢复输入。弹窗仍阻止主题按钮，不能把事件转发给任意页面元素。

## 真实验证

先完成相关编辑，再一起验证：

- 浅→深、深→浅、同色自动档和系统配色变化；
- 运动中反向、拖拽抓取 / 释放、方向键 / Home / End；
- 胶囊、日轮、海浪在运动 / 隐藏时的暂停与恢复；
- 弹窗遮挡、窗口缩放和减少动态效果。

`node scripts/check-reveal.mjs [compatible-module]` 用生成的真实 keyframes 检查单峰速度、完整半径和尾速，输出 80%→99% 半径耗时。它不检查浏览器绘制。

运动证据用不暂停、不 seek 的连续播放。原生像素采样要考虑设备缩放和截图可能比最新 DOM 慢一帧；允许上一呈现帧，不允许静止旧截图持续落后。静态截图只证明外观，不证明滑动连续。

Electron 原生 caption 不属于网页快照。当前项目用了页面内窗口按钮；其他产品可保留原生 caption 并说明限制，无需为了复用该主题改变系统窗口行为。

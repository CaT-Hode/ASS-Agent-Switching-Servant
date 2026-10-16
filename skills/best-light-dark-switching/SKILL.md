---
name: best-light-dark-switching
description: Build or refine light/dark theme switching with a draggable sun/moon control, optional sunset automatic mode, coordinated palettes, and a crisp circular reveal. Use for this theme system and its motion, not unrelated UI redesigns.
---

# Best Light Dark Switching

本 skill 从项目当前已经实现、实际验证的深浅模式提炼而来。源码和用户的新要求是实现依据；不要反过来要求项目服从这份快照。复用到其他产品时，保留其内容、品牌、布局和设置体系。

## 取用范围

- 完整配色或单独的太阳 / 月亮 / 落日胶囊：阅读[配色与场景](references/design-system.md)。
- 点击、拖拽、圆形过渡或跳变修复：阅读[运动与接入](references/motion-and-integration.md)。
- React 实现可取用四份自包含资源：`assets/theme-control.jsx`、`theme-control.css`、`theme-motion.mjs`、`theme-reveal.mjs`。其他框架沿用机制，不为复用强行引入 React。
- 自动模式和海边落日是可选场景，不代表第三种全站配色。下文参数是当前实现的参考值，不是所有产品的固定标准。

## 从现有项目提炼或接入

1. 先定位项目实际的主题状态、语义色、控件、过渡和持久化代码。已有实现与模板不一致时，先判断用户当前希望保留的行为，不整套覆盖。
2. 区分所选 `mode` 与实际 `resolved` 配色。接入既有偏好层；模板中的 `ass-theme` 仅为默认存储键，可以统一改名，不新增第二套互相竞争的状态来源。
3. 调整配色、场景和运动时分别处理，保持下列交互不变量。同步可复用模板时只提取主题部分，不带入账户、路由、IPC 或项目路径。
4. 如果任务是“把当前功能写成 skill”，先完成实际功能，再依据最终源码更新资源、参考说明和验证；不要用旧 skill 的文字推断当前源码已经具备某项行为。

## 需要保留的交互机制

- 点击位置决定档位；拖拽从当前呈现位置接手，释放保留速度。不要让装饰动画占用滑块外层的 transform。
- 胶囊使用独立的实时命名过渡层，旧图隐藏；否则整窗旧截图会遮住移动中的滑块。弹窗遮挡时不要把按钮提升到其上方。
- 圆内始终是新主题，圆外是旧主题。圆心取实际触发按钮的中心，快照盒与坐标使用同一窗口参照。
- 最终半径严格大于完整窗口对角线，整个半径变化用一条连续的单峰速度曲线，不在末尾补一次快速扩张。
- 快速反向以最后选择为准；旧回调不能改回旧主题。同色回声和微小重复尺寸事件不应提前结束正在进行的揭幕。
- 月亮保持正向，自动档的日轮 / 水波只移动各自内部层。非当前场景、拖拽、滑动、隐藏时暂停，系统减少动态效果时直接切换。
- 保留可访问名称、方向键 / Home / End 和焦点状态。不支持 View Transitions 时保留正常换色与持久化。

## 验证与交付

完成一轮相关编辑后一起验证实际交互：双向换色、同色自动档、连续反向、拖拽、系统变化、弹窗和减少动态效果。只检查最终状态不足以发现滑块被快照遮住的问题；自然播放时同时检查实际绘制与呈现位置。

`node scripts/check-reveal.mjs` 检查资源中的完整半径曲线，也可传入同接口的实际模块。它只证明数学轨迹，不证明实际绘制。截图、暂停或 seek 采样与自然播放的证据应分开。

本 skill 不授予结束应用、替换安装包、发布或修改其他产品配置的权限；沿用任务已有授权。

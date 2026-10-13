---
name: ass-theme-design
description: Design or reproduce ASS-style light and dark interfaces with quiet gray surfaces, restrained sage accents, a draggable sun/moon capsule, optional dusk automatic mode, and sharp circular theme reveals. Use for this theme system or its reusable components, not unrelated branding or a general interface redesign.
---

# ASS 深浅主题设计

实现一套安静、完整、可打断的深浅主题。主题变化发生在清晰圆形蒙版内，开关本身是一段可拖拽的小型日夜场景。保留目标项目的内容、布局、品牌与原有账户 / 配置逻辑。

## 选择范围

- 先确认是在复制完整主题、只做主题胶囊，还是只增加圆形切换；只改用户要求的部分。
- ASS 风格默认用于横版桌面界面。目标项目明确要求其他设备时再适配，不擅自重排桌面页面。
- 基本模式为浅色 / 深色。黄昏代表可选的自动档，不是第三套全站配色；已有自动模式则保留，没有要求时不强行增加。
- 颜色与时长是这套风格的默认值，可以针对目标界面微调；不把 ASS 的具体尺寸、版本或存储路径写死在其他项目里。

## 设计入口

1. 配色与表面层次：阅读 [配色与按钮设计](references/design-system.md)。使用语义 token，检查真实浅色和深色页面，不只换背景。
2. 圆形切换与交互：阅读 [动效与接入](references/motion-and-integration.md)。保留点击圆心、拖拽弹簧、末段减速及在途清理。
3. React 实现可以复用 `assets/theme-control.jsx`、`assets/theme-control.css`、`assets/theme-motion.mjs`、`assets/theme-reveal.mjs`。这些文件自包含，不导入 ASS 的账户或路由模块。按第二份参考接入状态、持久化与 CSS 作用域。

其他技术栈沿用相同语义与交互，不为复用模板而引入 React、动画框架或 Electron。

## 不可丢失的体验

- 大面积灰黑 / 柔白，绿色只作为极低饱和的辅助；靠细微表面明度差分区，不靠亮描边。数据图表的天蓝 / 紫色不扩散到普通 UI。
- 太阳、月亮各有稳定的形态；月亮不整体旋转，自动档使用落日 / 地平线。只有当前场景的轻微背景运动运行，拖拽、隐藏或系统减少动态效果时停下。
- 点击位置决定档位，不用每次点击循环到下一档。拖拽从当前呈现位置开始，释放衔接速度，键盘和辅助技术能辨认各档。
- 圆内始终是新主题、圆外是旧主题，两个方向使用同一规则。默认 960ms、`cubic-bezier(.4,0,.6,1)`；后半程持续减速。终点明显越过四角，并先保留完整覆盖帧再清理，不靠最后一帧补齐；无默认淡化、模糊边缘或装饰光圈。
- 快速反向操作以最后选择为准，不排队、不锁住控件；清理快照与 `fill:both` 效果，旧回调不能覆盖新选择。

## 交付检查

完成一轮相关修改后一起验证：深浅双向、自动档（启用时）、连续点击、拖拽反向、键盘、窗口缩放、弹窗及减少动态效果。检查文字 / logo / 表单 / 图表、右上角窗口区域和动画最后一帧，不能只看静态终态。

不要因使用此 skill 自动发布、替换安装包、结束应用或修改系统注册表。这些操作按当前任务的授权处理。说明实际验证的平台，以及原生 caption 是否能参加快照的限制。

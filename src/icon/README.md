# 青鸟图标资源

按提供的设计图制作，共 16 个 PNG，覆盖 macOS / Windows、浅色 / 深色、代理关闭 / 开启四种状态。

## 目录

```text
青鸟/
├── macOS/
│   ├── app-light-off.png
│   ├── app-light-on.png
│   ├── app-dark-off.png
│   ├── app-dark-on.png
│   ├── menu-light-off.png
│   ├── menu-light-on.png
│   ├── menu-dark-off.png
│   └── menu-dark-on.png
├── Windows/
│   ├── app-light-off.png
│   ├── app-light-on.png
│   ├── app-dark-off.png
│   ├── app-dark-on.png
│   ├── tray-light-off.png
│   ├── tray-light-on.png
│   ├── tray-dark-off.png
│   └── tray-dark-on.png
└── README.md
```

## 文件规格

| 文件 | 尺寸 | 外形 |
| --- | --- | --- |
| macOS/app-*.png | 1024 × 1024 px | 大圆角方形底板 |
| macOS/menu-*.png | 256 × 256 px | 圆形底板 |
| Windows/app-*.png | 1024 × 1024 px | 圆角方形底板 |
| Windows/tray-*.png | 256 × 256 px | 圆角方形底板 |

所有图标均为 RGBA PNG，底板外为真实透明背景；底板本身保留设计图中的浅色或深色填充。图标居中，四周约有 5% 透明留白，无标题、说明文字或水印。

## 命名与状态

- `app`：应用图标。
- `menu`：macOS 菜单栏图标，保留参考图中的彩色圆形样式。
- `tray`：Windows 系统托盘图标。
- `light`：浅色外观。
- `dark`：深色外观。
- `off`：代理关闭，无绿色状态标记。
- `on`：代理开启，轨迹右下方带绿色圆环状态标记。

菜单栏／托盘文件是高分辨率资源，实际显示大小由应用设置。请保持宽高比进行缩放。

## 制作说明

使用内置 imagegen 工具参照用户提供的设计图逐张高清重制，再进行尺寸统一、透明边缘整理和 PNG 导出。保留蓝鸟、经纬线地球、椭圆轨迹、主题配色与绿色开启标记；这些文件是参考图的高清重制资源。

最终提示词规格：从参考图中单独提取并高清复原对应图标，保持向右飞翔的蓝鸟及翅膀轮廓、深蓝色眼睛和高光、浅青色胸部、蓝色鸟喙、后方经纬线地球和下方青蓝色椭圆轨迹。保持对应平台的底板形状及浅深配色；仅开启状态带右下方绿色圆环。每次输出一个图标，底板外透明，不包含文字、标签、平台标志或其他图标。

| 提示词变体 | 参考图位置 | 底板与状态要求 |
| --- | --- | --- |
| macOS/app-light-off | 第 1 行第 1 个 | 大圆角浅色底板，关闭 |
| macOS/app-light-on | 第 1 行第 2 个 | 大圆角浅色底板，开启 |
| macOS/app-dark-off | 第 1 行第 3 个 | 大圆角午夜蓝底板，关闭 |
| macOS/app-dark-on | 第 1 行第 4 个 | 大圆角午夜蓝底板，开启 |
| macOS/menu-light-off | 第 2 行第 1 个 | 浅色圆形底板，关闭 |
| macOS/menu-light-on | 第 2 行第 2 个 | 浅色圆形底板，开启 |
| macOS/menu-dark-off | 第 2 行第 3 个 | 午夜蓝圆形底板，关闭 |
| macOS/menu-dark-on | 第 2 行第 4 个 | 午夜蓝圆形底板，开启 |
| Windows/app-light-off | 第 3 行第 1 个 | 浅色圆角方形底板，关闭 |
| Windows/app-light-on | 第 3 行第 2 个 | 浅色圆角方形底板，开启 |
| Windows/app-dark-off | 第 3 行第 3 个 | 宝蓝到深蓝圆角方形底板，关闭 |
| Windows/app-dark-on | 第 3 行第 4 个 | 宝蓝到深蓝圆角方形底板，开启 |
| Windows/tray-light-off | 第 4 行第 1 个 | 浅色圆角方形底板，关闭 |
| Windows/tray-light-on | 第 4 行第 2 个 | 浅色圆角方形底板，开启 |
| Windows/tray-dark-off | 第 4 行第 3 个 | 宝蓝到深蓝圆角方形底板，关闭 |
| Windows/tray-dark-on | 第 4 行第 4 个 | 宝蓝到深蓝圆角方形底板，开启 |

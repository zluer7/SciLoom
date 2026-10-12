# SciLoom 科研舱

SciLoom 是面向科研人员的 AI 辅助桌面科研管理工作台，以本地科研工作流为中心。

本源码候选版本为 **1.1.0**，对应第二个公开版本。安装包发布状态请以 [GitHub Releases](https://github.com/zluer7/SciLoom/releases) 为准；此说明不表示 1.1.0 已发布。本次目标为 Windows x64，历史版本及其他平台资产保留在既有 Release 中。

## 主要能力

- 组织课题、路线、任务、实验、文献、复盘和成果，串联日常科研工作。
- 利用相关科研背景辅助 AI 交流与内容整理。
- AI 建议和草稿经预览及用户显式确认后写入；AI 服务需由用户自行配置。
- 使用本地工作区保存资料，提供项目导入、导出及手稿管理。

使用说明见 [快速开始](docs/QUICK_START.md)。升级或安装前请备份自己的工作区。

## 从源码构建 Windows 版本

准备 Node.js/npm、Rust stable（MSVC 工具链）、Visual Studio C++ Build Tools、Windows SDK 和 WebView2。Tauri 2 的 Windows 前提条件见 [官方文档](https://v2.tauri.app/start/prerequisites/#windows)。

```powershell
npm ci
npm run build
npm run tauri:build -- --bundles nsis
```

默认 Rust target 下安装包位于 `src-tauri/target/release/bundle/nsis/`；若设置了 `CARGO_TARGET_DIR`，输出位于该目录。开发模式使用 `npm run tauri:dev`，开发数据默认放在本克隆的 `.tmp/dev-runtime/`。无需私有开发环境目录。回归入口为 `npm run test:release`，不属于安装步骤。

`labpod` 包名和 `local.labpod.desktop` 应用身份用于保持既有数据兼容。生产版本使用系统标准应用数据目录，不使用开发数据隔离变量。

## 开源许可与署名

本项目基于 [BSD-3-Clause License](LICENSE) 开源。SciLoom（科研舱）由争流儿发起并创建。

SciLoom、科研舱及相关标识的权利独立于本项目的软件开源许可。

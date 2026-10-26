# SciLoom 科研舱

SciLoom 是面向科研人员的 AI 辅助桌面科研管理软件，致力解决科研中的实际问题。本项目开源、开放，持续维护，欢迎大家体验、测试、反馈、加入我们...

本源码候选版本为 **1.1.1**。安装包发布状态以 [GitHub Releases](https://github.com/zluer7/SciLoom/releases) 为准；本文件本身不表示已发布。

## 主要能力

- 组织课题、路线、任务、实验、文献、复盘和成果，串联日常科研工作。
- 共享结构化纲要，对科研数据标准记录、管理。
- 使用本地工作区保存资料，提供项目导入、导出及手稿管理。
- 内置合成示例用于体验近期计划、日历和同父实验 Run 的比较视图；示例日期固定，展示会随当前日期变化。
- AI 建议和草稿经预览及用户显式确认后写入；AI 服务需由用户自行配置。

使用说明见 [快速开始](docs/QUICK_START.md)。安装前备份科研工作区。本版 Publisher 元数据为 zluer；未提供代码签名证书，Publisher 字符串不代表已签名身份。旧 1.1.0 原位升级兼容未经承诺，请保护已有数据。

## 从源码构建 Windows 版本

准备 Node.js/npm、Rust stable（MSVC 工具链）、Visual Studio C++ Build Tools、Windows SDK 和 WebView2。Windows 前提条件见 [Tauri 官方文档](https://v2.tauri.app/start/prerequisites/#windows)。

```powershell
npm ci
npm run build
npm run tauri:build -- --bundles nsis
```

默认安装包位于 `src-tauri/target/release/bundle/nsis/`；设置 `CARGO_TARGET_DIR` 时位于相应目录。开发入口为 `npm run tauri:dev`，回归入口为 `npm run test:release`。构建不需要私有 Records 或固定开发目录。

`labpod` 包名和 `local.labpod.desktop` 应用身份保持不变。生产版本使用系统标准应用数据目录，不使用开发隔离变量。请保留 Demo JSON 的原始 LF 字节；其资源 SHA256/字节数由 Rust 与前端共同校验。

## 开源许可与署名

本项目基于 [BSD-3-Clause License](LICENSE) 开源。
SciLoom（科研舱）由争流儿发起并创建。



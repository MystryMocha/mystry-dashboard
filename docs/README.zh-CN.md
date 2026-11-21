# 项目文档

[English](README.md) · **简体中文**

Mystry Dashboard 是自托管的游戏服务器面板，现已支持 Minecraft Java 版，可在所在机器上管理多个服务端实例。

## 按目标阅读

| 你想做什么 | 从这里开始 | 后续参考 |
|---|---|---|
| 安装并启动面板 | [快速开始](getting-started.zh-CN.md) | [便携版下载、校验与升级](portable-release.zh-CN.md) |
| 创建首个管理员或处理登录问题 | [初始化管理员](getting-started.zh-CN.md#初始化管理员) | [启动与认证排查](getting-started.zh-CN.md#故障排查) |
| 运行第一个服务端 | [分步教程](tutorials.zh-CN.md) | [使用指南](user-guide.zh-CN.md) |
| 导入、配置或管理实例 | [使用指南](user-guide.zh-CN.md) | [备份与迁移](tutorials.zh-CN.md#教程-8备份与迁移) |
| 让好友加入服务器 | [联机](user-guide.zh-CN.md#联机) | [安全政策](../SECURITY.zh-CN.md) |
| 修改监听地址、密钥或资源限制 | [配置说明](configuration.zh-CN.md) | [安全政策](../SECURITY.zh-CN.md) |
| 修改代码或提交 PR | [开发指南](development.zh-CN.md) | [贡献指南](../CONTRIBUTING.zh-CN.md)、[验证矩阵](ai/verification.md) |
| 接入接口或理解实现 | [API 参考](api.zh-CN.md) | [架构设计](architecture.zh-CN.md) |
| 设计界面或撰写界面文案 | [设计系统](design-system.md) | [多语言规范](localization.md) |
| 使用 AI 协助开发 | [项目开发规则](../CLAUDE.md) | [AI 项目知识库](ai/README.md) |

首次使用，建议依次阅读：快速开始 → 分步教程 → 使用指南。

## 文档分工

- 根 [README](../README.zh-CN.md)：项目定位、能力边界与运行方式。
- 本目录的专题文档：用户操作、配置、接口与开发流程的权威来源。
- [AI 知识库](ai/README.md)：可追溯的实现事实、架构决策、禁区与检查方法。
- 历史记录：保留当时的结论与证据，不作为当前缺陷或发布状态的清单。

## 历史与社区资料

| 文档 | 用途 |
|---|---|
| [变更日志](../CHANGELOG.zh-CN.md) | 版本历史 |
| [贡献指南](../CONTRIBUTING.zh-CN.md) | Issue、PR 和文档维护约定 |
| [安全政策](../SECURITY.zh-CN.md) | 漏洞私下披露 |
| [行为准则](../CODE_OF_CONDUCT.zh-CN.md) | 社区参与规范 |
| [许可证](../LICENSE) | MIT |

## 维护与校验

修改功能说明前，先核对相关源码、共享契约、前端入口与测试。配置、路由、脚本或 AI 入口变化时，须同步 [机器事实](ai/project-facts.json)；文档改动流程见 [变更手册](ai/change-playbooks.md#文档与知识库)。

在仓库根目录执行：

```powershell
npm.cmd run knowledge:check
npm.cmd run knowledge:test
```

Linux/macOS 脚本名相同，将 `npm.cmd` 换为 `npm` 即可。检查器校验机器事实与本地 Markdown 链接目标是否存在，不校验标题锚点、外部链接可用性或真实用户流程。提交前还须按 [验证矩阵](ai/verification.md) 运行 `npm.cmd run verify`。

# Himuro 冰室 ❄

本地自托管的 AI 角色扮演 / 陪伴创作平台 —— 按「AI风月」（aifengy.cc）的功能架构自建的开源复刻版，代码 100% 自有，可自由迭代。

> 名字取自「氷室」（ひむろ）：藏冰之所。设定、记忆与剧情都收纳在这间屋子里。

## 核心功能（对应风月拆解）

| 风月功能 | Himuro 实现 |
|---|---|
| 角色卡五件套（身份/说话方式/价值观/禁忌边界/称呼习惯）+ 关系 + 开场白 + 3–5 组示例对话 | 角色编辑器全量支持，支持 Himuro 卡 JSON 导入导出、模板角色中心 |
| 世界书（人物/地点/事件/规则条目，关键词+权重触发，版本回滚） | 世界书管理页：条目 CRUD、命中预览、每次变更自动快照、一键回滚 |
| 长会话记忆 | 三层：滚动摘要（轻量模型自动压缩）+ 世界书关键词注入 + 可选向量检索 |
| 日常聊天 / 连载剧情双模式 | 日常：情绪目标快捷 chips（安慰/斗嘴/并肩作战…）；连载：章节号、章末「下一章钩子」、一键提炼状态回写世界书 |
| 模型轻量/高质量两档 | 会话级切换，三组 OpenAI 兼容配置（轻量/高质量/Embedding） |
| 语音（基底音色+参数微调+试听+批量导出） | 三供应商：浏览器内置（离线）/ **GPT-SoVITS api_v2**（自部署）/ OpenAI 兼容；服务端代理 /api/tts；**支持按角色配参考音频（=专属音色）与语速覆盖，未配置回退全局**；**导出配音**可导全部角色回复或仅星标句。本机默认预填 WSL 里的忍野扇音色 |
| 对话导出复盘 + 回写角色卡 | 导出 TXT/JSON；消息星标；「存为示例」把满意对话写回角色卡 |
| —— v1.1 新增 —— | |
| 消息重Roll / 编辑重发 / 删除 | 回复不满意一键重抽；编辑用户消息后截断并重新生成 |
| SillyTavern 角色卡导入 | 拖入 PNG 卡或 V1/V2/V3 JSON 卡即入库（宏替换 + 五件套映射） |
| —— v1.2 新增 —— | |
| 多角色群聊 | 2–N 个角色同场：谁被@谁答 / 依次发言 / 全员发言三种策略，成员可中途加减，同轮发言按顺序互相可见，各角色独立世界书命中 |

## 快速开始

```bash
npm install
npm run dev        # 开发模式，http://localhost:3000
# 或
npm run build && npm start   # 生产模式
```

> 仓库根有 `.npmrc` 设了 `ignore-scripts=true`：依赖（better-sqlite3 等）自带预编译产物，不需要安装期脚本，而 better-sqlite3 包内有 `binding.gyp` 会触发 node-gyp 编译，在没有 Visual Studio 的机器上直接装不上。将来引入需要编译期脚本的依赖时，用 `npm rebuild <包名> --foreground-scripts` 单独放行。

**无需任何配置即可运行**：默认使用内置「演示模型」（离线角色扮演假回复），用来熟悉流程和测试功能。

### 接入真实模型

1. 打开 `http://localhost:3000/settings`
2. 分别为「轻量档」「高质量档」填入 OpenAI 兼容接口：
   - GLM：`https://open.bigmodel.cn/api/paas/v4`，模型如 `glm-4-flash` / `glm-4-plus`
   - DeepSeek：`https://api.deepseek.com`，模型 `deepseek-chat`
   - OpenAI：`https://api.openai.com/v1`
   - 本地模型：Ollama `http://localhost:11434/v1` / LM Studio `http://localhost:1234/v1`
3. 点「测试连接」确认，保存。已有会话直接切换档位即生效。
4. （可选）配置 Embedding 模型启用第三层向量记忆；不配置不影响其余功能。

## 数据与隐私

- 所有数据存本机 `data/himuro.db`（SQLite），API Key 存本机数据库，不出本机。
- 删除 `data/` 目录即恢复出厂（重新启动会自动重建库 + 三个模板角色）。

## 文档（迭代前必读）

- [docs/FEATURE-SPEC.md](docs/FEATURE-SPEC.md) —— 风月功能规格 → Himuro 实现对照表 + Phase 2 路线图
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 数据模型、模块划分、Prompt 组装与记忆层设计
- [docs/DEV-GUIDE.md](docs/DEV-GUIDE.md) —— 怎么加字段/加页面/换 TTS 供应商等迭代指南

## 技术栈

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · SQLite (better-sqlite3 + Drizzle ORM) · OpenAI 兼容 API 直连（无 SDK 依赖）

## 许可

MIT，见 [LICENSE](LICENSE)。代码全部自有；角色卡/世界书/记忆等功能形态参考「AI风月」的公开文档与教程，未使用其任何代码。

# Telegram Air

把 Telegram 变成可搜索、可总结、可追问的 AI 聊天知识库。

![Telegram Air 界面预览](public/screenshot.jpg)

## 比 Telegram 多什么

- **AI 读聊天**：基于聊天上下文回答，不只给通用答案。
- **一键总结**：长群聊整理成结论、分歧、决定和下一步。
- **智能检索**：按人、关键词、时间范围、最近 N 条消息找历史。
- **回复草稿**：根据当前聊天生成更贴合语境的回复，但不会自动发送。
- **待办提取**：从讨论里提取任务、负责人、截止时间和状态。
- **选中消息追问**：框选几条消息后直接让 AI 总结、解释或改写。
- **本地优先**：聊天历史可同步到本地索引，便于反复搜索和追问。

## 快速开始

1. 安装依赖：

```sh
mv .env.example .env
npm i
```

2. 启动桌面端：

```sh
npm run tauri:dev
```

只跑 Web 端：

```sh
npm run dev
```

3. 打开 Telegram Air 后进入 **Settings → AI**，填写：

- `Model ID`
- `API Key`
- `Base URL`，可选，适合 OpenAI 兼容接口或本地模型网关

4. 进入群组或频道，打开右侧 **AI Assistant**：

- 先同步聊天历史
- 输入“总结今天讨论”
- 或搜索“某个人上周说了什么”
- 或选中几条消息后点击 AI 追问

> 日常开发通常不用单独配置 Telegram API。只有登录报 API 配置错误，或准备公开发布自己的 fork 时，再填 `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`。

## 截图

### AI Assistant

右侧 AI 面板可基于已同步聊天记录总结、检索、整理待办和生成回复。

![Telegram Air 界面预览](public/screenshot.jpg)

### 历史同步

按日期查看已同步聊天记录，支持继续同步、暂停同步和本地关键词搜索。

![Telegram Air 界面预览](public/screenshot.jpg)

## 适合谁

- 群聊很多、消息太密的人
- 用 Telegram 做工作协作的人
- 想把聊天记录当知识库搜索的人
- 经常需要总结、复盘、写回复的人

## 本地历史同步

Telegram Air 支持把群组和频道历史同步到本地：

AI 会优先基于已同步记录回答；如果同步范围不足，会明确提示。

## 构建

```sh
npm run build:production
npm run tauri:build
```

## 上游

Telegram Air 基于 [Telegram Web A](https://web.telegram.org/a)。上游项目曾获得 [Telegram Lightweight Client Contest](https://contest.com/javascript-web-3) 一等奖，使用 [Teact](https://github.com/Ajaxy/teact) 和定制 [GramJS](https://github.com/gram-js/gramjs)。

如果是 Telegram Web A 上游问题，可以使用 Telegram 的 [Suggestions Platform](https://bugs.telegram.org/c/4002) 反馈。

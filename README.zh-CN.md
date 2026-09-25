<div align="center">

<img src="assets/icon.png" alt="Star CLI" width="320" />

**用 TypeScript 编写的 AI 代理命令行界面**

多模型 LLM 接入 · 流式终端 UI · 工具调用 · 权限控制 · 会话持久化

[![CI](https://github.com/cryer/star-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/cryer/star-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@cryer/star-cli?color=crimson&logo=npm)](https://www.npmjs.com/package/@cryer/star-cli)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#环境要求)

**[English](README.md)** | 简体中文

</div>

功能特性：带斜杠命令（+ 自动补全）的流式 REPL · OpenAI / Anthropic / OpenAI 兼容服务商，配交互式 `/connect` 接入向导 · 内置 fs / bash / web 工具，带权限门禁 · git 集成（`/commit` 起草 Conventional Commits 提交信息，`/diff` 显示彩色工作区 diff，仓库状态注入系统提示词）· 计划模式：只读调研 + 计划批准 · 带暗色推理预览的思考动画 · 写入/编辑批准时的 diff 预览 · `@file` 引用 · `!cmd` shell 直通 · 用 Markdown 文件自定义斜杠命令 · 对话压缩（`/compact`）· 会话持久化与恢复，自动生成标题（`/resume`、`star -r`）· 子代理委派，处理专注的子任务 · 生命周期钩子（来自配置的 `PreToolUse`/`PostToolUse`/`Stop` shell 命令）· 文件写入快照 `/undo` 与检查点回滚 `/rewind` · TODO 任务跟踪 · 状态栏可见的后台 shell 任务（`/tasks`）· 长回合与后台任务完成时的终端响铃 · Markdown 会话导出（`/export`）· `/init` + `/doctor` 项目脚手架与环境检查 · 成本估算 · 更新提醒 · 便于脚本化的 `--json` NDJSON 输出。

## 环境要求

- Node.js >= 20
- pnpm

## 安装

```bash
npm install -g @cryer/star-cli
star                  # interactive REPL
star -p "hi"          # non-interactive print mode
```

## 快速上手（从源码构建）

```bash
pnpm install
pnpm build
npm link                 # one-time: registers the `star` command globally
star                     # interactive REPL
star -p "hi"             # non-interactive print mode
```

不执行 `npm link` 也可以直接运行打包产物：`node dist/main.js`（代码改动后需重新运行 `pnpm build`；link 之后的 `star` 始终指向 `dist/`）。

## 配置

配置文件：`~/.star-cli/config.toml`（项目级覆盖：当前目录下的 `.star/config.toml`；CLI 参数优先于两者）。

```toml
defaultModel = "gpt"
permissionMode = "ask"   # ask | auto | readonly | yolo | plan
contextMaxTokens = 100000
contextCompaction = "summary"   # summary | truncate — how over-budget history is compacted
# Seconds with no stream output before a stalled response is ended gracefully
# (some relays never close the stream). The first token gets a fixed 120s allowance.
streamIdleTimeoutSec = 20
# sessionBudgetUsd = 5          # optional per-session cost cap in USD; unset = no cap
notifyBell = true              # ring the terminal bell when a long turn finishes (REPL only)
notifyBellThresholdSec = 10    # turns shorter than this stay silent

[permissions]
# persistent allow-rules, written automatically when you pick "a" (always) on a permission prompt
allow = ["bash(npm test)", "read_file"]   # <tool> or <tool(<pattern>)>, * is a glob wildcard
# persistent deny-rules — checked after the hard safety rules; they beat auto mode
# and allow-rules (yolo still bypasses everything)
deny = ["bash(rm -rf *)"]

[[providers]]
name = "openai"
protocol = "openai-compatible"
baseURL = "https://api.openai.com/v1"
apiKeyEnv = "OPENAI_API_KEY"
# protocol = "openai-responses"  # for relays exposing only /v1/responses

[[models]]
name = "gpt"
provider = "openai"
model = "gpt-4o"
# optional per-model context window — overrides the top-level contextMaxTokens
# for compaction and the ctx % in the status bar
# contextMaxTokens = 272000
# optional per-model pricing in USD per 1M tokens — enables the $ estimate in
# /cost and /usage. promptPrice prices input tokens (system prompt, history,
# @file contents, tool results — resent every turn, so the bulk of usage);
# completionPrice prices output tokens (the model's replies and tool calls —
# less volume, usually the pricier rate). BOTH fields are required together.
promptPrice = 2.5
completionPrice = 10

[[providers]]
name = "claude"
protocol = "anthropic"
baseURL = "https://api.anthropic.com"
apiKeyEnv = "ANTHROPIC_API_KEY"

[[models]]
name = "sonnet"
provider = "claude"
model = "claude-sonnet-4-20250514"

[[hooks]]
event = "PostToolUse"                  # PreToolUse | PostToolUse | Stop
matcher = "edit_file|write_file"       # optional regex on the tool name; matches all tools when omitted
command = "biome check --write ."
# timeoutSec = 30                      # optional per-hook timeout
```

API 密钥优先从环境变量解析（`apiKeyEnv`），其次是配置文件中的 `apiKey` 字段。启动时 Star CLI 还会把 `~/.star-cli/.env`（dotenv 风格的 `KEY=VALUE` 行）加载进环境变量，且不会覆盖已存在的变量——`/connect` 收集的密钥就存放在这里，因此 `config.toml` 只引用变量名，永远不会包含密钥本身。

配置服务商最快的方式是 REPL 内的 `/connect` 向导：选择预设（OpenAI、Anthropic、Kimi/Moonshot、DeepSeek）或自定义端点，粘贴 API 密钥（输入时掩码显示），命名一个模型，它会把 `[[providers]]`/`[[models]]` 块追加到 `config.toml`（保留已有内容与注释），把密钥写入 `~/.star-cli/.env`（以 `STAR_API_KEY_<NAME>` 为名，在支持的平台上文件权限为 600），并可选择将新模型设为默认——全程无需重启。


## CLI 参数

```
star                          start the interactive REPL
star -p "prompt"              non-interactive print mode (pipe-friendly)
star -p "prompt" --image x.png  attach an image (png/jpg/jpeg/gif/webp, max 5MB; repeatable; anything past 2000px on the longest side is downsampled)
star -p "prompt" --json       NDJSON event stream on stdout (text/tool/usage/error lines)
star -m gpt                   pick a model
star --permission-mode auto   ask | auto | readonly | yolo | plan
star -r <sessionId>           resume a previous session (full or short id)
star -r                       list sessions for the current directory
star -c                       continue the most recent session for the current directory
star --clear-sessions         delete stored sessions for the current directory
star --clear-sessions all     delete every stored session
```

## 斜杠命令（REPL）

| 命令 | 说明 |
|---|---|
| `/help` | 列出命令，按类别分组 |
| `/model [name]` | 切换模型——无参数时打开交互式选择器（上下文窗口、定价、当前标记） |
| `/resume [id\|--all]` | 按 id 恢复会话——无参数时打开最近会话的交互式选择器（消息数、相对时间、首条消息预览；`--all`：涵盖所有目录，并显示各自的 cwd） |
| `/fork` | 将当前会话分叉为一个副本并切换过去——在保留原会话的同时探索另一个方向 |
| `/search <query>` | 对所有已存会话做全文搜索（消息、工具调用及其结果），带摘要片段——用 `/resume <id>` 恢复命中的会话 |
| `/new` | 以干净的上下文开始新会话（旧会话保留在磁盘上） |
| `/clear-sessions [--all]` | 删除已存会话：默认删除当前目录的，`--all` 删除所有会话（当前会话保留） |
| `/todo` | 显示 TODO 列表 |
| `/tasks` | 列出后台任务（id、状态、运行时长、退出码） |
| `/cost` | 显示 API token 用量与估算的美元成本（需要在配置中为模型设置定价） |
| `/usage` | 跨所有会话的 token 用量面板：总计、按日柱状图、按模型细分及美元估算 |
| `/config` | 显示解析后的配置 |
| `/permission [mode]` | 设置权限模式——无参数时打开交互式选择器；`ask` / `auto` / `readonly` / `yolo` 会保存到配置，`plan` 仅保留在会话内 |
| `/connect` | 交互式服务商接入向导：选择预设或自定义端点，粘贴 API 密钥（掩码显示），命名模型——把 `[[providers]]`/`[[models]]` 追加到配置，密钥存入 `~/.star-cli/.env`（绝不写入 `config.toml`），还可将新模型设为默认并立即切换 |
| `/plan` | 切换计划模式：先只读调研，再批准生成的计划后才执行（仅会话内有效） |
| `/memory [add <text>]` | 查看长期记忆文件（`~/.star-cli/MEMORY.md`，注入每个会话的系统提示词），或向其中追加一行——见[长期记忆](#长期记忆) |
| `/compact` | 压缩对话历史以释放上下文 |
| `/export [path]` | 将当前会话导出为 Markdown 文件 |
| `/undo` | 撤销上一轮对话：还原其文件改动（write_file/edit_file）并撤回其消息——更早的回合不受影响（先预览消息数量与逐文件还原 diff，再要求确认） |
| `/rewind [n]` | 列出文件改动检查点，或回滚到检查点 `n` 之前：还原此后改动的所有文件并撤回对应的对话消息（先要求确认） |
| `/init [force]` | 扫描项目并生成 AGENTS.md（有可用模型时经 LLM 润色） |
| `/doctor` | 环境自检（Node、shell、配置、API 密钥状态、会话目录可写性） |
| `/skills` | 列出可用技能（项目作用域覆盖用户作用域） |
| `/commit [instructions]` | 分析未提交的改动，让代理以 Conventional Commits 信息暂存并提交（git add/commit 走正常的权限门禁） |
| `/diff` | 在客户端展示未提交改动：`git status --short` 加彩色的已暂存/未暂存 diff（不调用模型；超大 diff 截断到 2000 行） |
| `/copy [all]` | 将最后一条助手回复复制到剪贴板（`all`：整个对话的纯文本） |
| `/clear` | 清屏 |
| `/exit` | 退出 |
| `/q` | 退出（`/exit` 的别名） |

按键：`ESC` / `Ctrl+C` 中断当前流——已生成的部分回复保留在屏幕上（以及会话历史中），并带暗色 `[interrupted]` 标记；在权限提示上：`y` 允许，`n` 拒绝，`a` 始终允许——生成的 allow 规则（如 `bash(npm test)`）会保存到配置文件的 `permissions.allow` 中，重启后依然有效。写入/编辑提示包含待变更内容的彩色 diff 预览。`Shift+Tab` 在会话内循环切换权限模式（`ask` → `auto` → `readonly` → `plan`；不保存到配置）。输入编辑：方向键移动光标，`Ctrl+A`/`Ctrl+E` 跳到行首/行尾，`Ctrl+U`/`Ctrl+K` 删除光标前/后的内容，`Ctrl+W` 删除前一个单词，上/下键回忆历史（跨会话持久化到 `~/.star-cli/history`，上限 50 条，连续重复自动折叠，斜杠命令与按键重复的垃圾输入从不记录）；当回忆出的条目未被修改时，上/下键继续在条目间切换，而一旦你编辑了文本——或正在输入自己的多行内容——上/下键改为在行之间移动光标。`Ctrl+R` 启动反向历史搜索：输入以过滤（不区分大小写，最新匹配优先），`Ctrl+R`/`↑` 找更早的匹配，`↓` 找更新的，`Enter` 将匹配接进输入框，`ESC`/`Ctrl+C`/`Ctrl+G` 取消并恢复你原有的内容。多行输入：使用 `Ctrl+J`（或 `Alt+Enter`），或以 `\` 结尾再按 `Enter`——粘贴的多行文本会原样保留。一次性粘贴大块内容（10+ 行或 500+ 字符）会折叠成暗色占位符 `[pasted #N: L lines]`，让输入框保持紧凑；完整文本会在提交时还原，`Backspace` 可将占位符整体删除。终端分多个块送达的超长粘贴会被重新组装（在支持的终端上通过 bracketed paste），并仍然折叠为单个占位符。输入 `/` 会显示斜杠命令建议及其用法——前缀匹配优先，然后是模糊子序列匹配；`↑`/`↓` 高亮，`Tab`（或在输入末尾按 `→`）补全，`ESC` 关闭，未知命令名会给出 `Did you mean: …` 提示。输入 `@` 会以同样的按键补全相对工作目录的文件路径；目录以 `/` 结尾以便用 `Tab` 下钻，`node_modules`、`.git`、`dist` 和 `.starignore` 条目会被跳过。`Alt+V` 把剪贴板中的图片作为附件粘贴（每张图片在输入框上方显示为 `[image attached: clipboard.png]`；Windows 上使用 PowerShell，macOS 上使用 pngpaste/osascript，Linux 上使用 xclip）。最长边超过 2000px 的图片会自动缩放以符合限制（保持宽高比，使用平台原生工具——Windows/macOS 无需额外安装；Linux 上使用 ImageMagick 或 ffmpeg）；无法缩放时保留原图并显示警告。在终端透传的地方 `Ctrl+V` 也可用——Windows Terminal 把 Ctrl+V 绑定为自己的粘贴，请在那里使用 `Alt+V`。回合流式输出期间你可以继续输入：提交的提示（和 `!` bang）会以暗色条目排队，回合结束后按序自动发送；回合中按 `ESC` 会中止该回合并清空队列（部分回复保留，标记为 `[interrupted]`）。空闲时半秒内连按两次 `ESC` 会撤回你上一条提示，并把原文恢复进输入框供编辑。

模型工作时，加载动画（`- \ | /`）显示 `star is thinking…`；推理模型还会以暗色流式展示其思维尾部（最后约 200 字符），回答开始后折叠为一行摘要。流式回复、推理内容、工具输出和 todo 标题在显示前都会做净化处理（制表符展开为两个空格，剥离控制字节和原始转义序列），因此经中转的模型输出无法破坏终端或留下堆积的残留帧；长 todo 列表折叠为围绕活动任务的 10 行窗口，长预输入队列只显示前 5 条，让实时区域远低于终端高度。

状态栏显示工作目录（宽终端上显示完整路径）、git 分支、模型、权限模式、上下文用量占模型上下文窗口的百分比（模型自身设置了 `contextMaxTokens` 时用它，否则用顶层值）、服务商上报缓存用量时的会话提示词缓存命中率（`cache: 42%`，从不上报时显示 `cache: Not provided`）、模型配置了定价时的会话成本，以及 token 总数。

## !shell 直通

以 `!` 为输入前缀即可在本地运行命令，无需模型参与：

```
!git status
```

输出渲染为工具卡片并注入对话，模型之后也能看到。危险命令仍会被阻止，`ESC` / `Ctrl+C` 中止执行。

## 后台任务

模型可以通过 `bash` 加 `run_in_background: true` 在后台运行耗时 shell 命令（与前台命令同一道权限门禁）。有任务在后台运行时，状态栏显示 `bg: N`；任务完成、失败、超时或被停止时，系统消息会报告结果。`/tasks` 列出每个任务的状态、运行时长和退出码，模型也可以用 `task_list` / `task_output` / `task_kill` 工具查看或停止任务。REPL 退出时剩余任务会被终止。

## 终端响铃

REPL 会响终端铃（BEL），这样代理工作时你可以切到别的窗口：回合耗时超过 `notifyBellThresholdSec`（默认 10s）而结束时响一次，后台任务完成时响一次——正是你最不可能盯着屏幕的时刻。它只在 TTY 上响铃，被中断（ESC / Ctrl+C）的回合不响，print 模式（`-p`）下也绝不响。可在配置中设 `notifyBell = false` 或在环境中设 `STAR_NO_NOTIFY=1` 禁用。

## 会话预算

在配置中设置 `sessionBudgetUsd` 可为每个 REPL 会话设置花费上限（活动模型需要配置 `promptPrice`/`completionPrice` 才能计算成本）。已完成的回合使会话成本超过上限的 80% 时，会出现一次性警告；超过 100% 时，后续提示会被阻止并报错，斜杠命令仍可用——在配置中提高限额，或用 `/new` 重新开始。

## 计划模式

计划模式（`/plan`、`Shift+Tab` 循环或 `--permission-mode plan`）让代理在改动任何东西之前先做只读调研：模型只能看到读取级工具（`read_file` / `glob` / `grep` / `web_*` / `todo` …），写入/执行工具完全隐藏，系统提示词指示它以具体的逐步计划收尾。计划就绪后出现审批提示——`y` 恢复之前的权限模式并让代理执行计划，`n` / `ESC` 留在计划模式以便继续打磨。计划模式仅限会话作用域，绝不写入配置文件；再次输入 `/plan` 切回。

## 钩子

配置中的 `[[hooks]]` 条目在代理生命周期节点运行你自己的 shell 命令（Claude Code 钩子的简化版）：

```toml
[[hooks]]
event = "PreToolUse"              # before a tool runs
matcher = "edit_file|write_file"  # optional regex on the tool name; omit to match every tool
command = "node scripts/check.js"

[[hooks]]
event = "Stop"                    # once per finished turn
command = "notify-send 'turn done'"
```

- **PreToolUse** 在工具执行前运行。退出码 `0` 放行；退出码 `2` 阻止该工具，钩子的 stderr 作为工具结果返回给模型；其他任何非零退出让工具运行并把 stderr 显示为警告（REPL 中为系统消息，print 模式下输出到 stderr 的 `[hook] …`）。
- **PostToolUse** 在工具成功后运行（错误结果后不运行）。非零退出只产生警告——不会阻止任何东西。典型用途：格式化工具和 lint 自动修复（`biome check --write .`）。
- **Stop** 在回合结束时运行一次（在最终助手回复之后）。这里没有工具，`matcher` 被忽略；失败仅警告。

钩子进程在工作目录中运行，带超时（默认 30s，可用每个钩子的 `timeoutSec` 设置），并收到 `STAR_HOOK_EVENT`、`STAR_CWD`、`STAR_SESSION_ID`，工具事件还会收到 `STAR_TOOL_NAME` 和 `STAR_TOOL_INPUT`（工具参数的 JSON）。超时钩子按失败处理——对 PreToolUse 来说意味着带警告放行，因此卡住的钩子永远无法锁死代理。

安全性：钩子是**你**配置的命令，因此它们在任何权限模式下都运行，且**不**经过权限门禁——请把配置文件当作可信代码。钩子只在事件真实发生时触发：在 `readonly`/`plan` 模式下写入/执行工具从不运行，它们的 PreToolUse/PostToolUse 钩子也从不触发。失败的钩子永远无法让代理崩溃。

## Git 集成

在 git 仓库内，代理的系统提示词自动携带一段简短的 git 上下文块——当前分支、未提交文件数和最近 3 条提交——每个回合开始时刷新（REPL 与 print 模式一致；任何 git 失败都被静默忽略）。

两个斜杠命令建立在其上：

- `/commit [instructions]` 收集 `git status`、已暂存 + 未暂存的 diff（截断到 2000 行）和最近 5 条提交，然后让代理起草一条符合仓库历史的 Conventional Commits 信息，并通过 bash 工具运行 `git add` / `git commit`——因此常规的权限提示依然适用。不在仓库内或工作区干净时，它只说明情况而不调用模型。
- `/diff` 完全在客户端完成：以与写入/编辑审批预览相同的配色渲染 `git status --short` 和已暂存/未暂存的 diff，超过 2000 行时截断。

## 自定义斜杠命令

把 Markdown 文件放进 `.star/commands/<name>.md`（项目级）或 `~/.star-cli/commands/<name>.md`（全局）即可定义自己的命令——`/review src/` 会把文件内容（`$ARGUMENTS` 已替换为你的参数）作为提示发送给模型。可选的首行 `<!-- description: does a thing -->` 设置在 `/help` 和自动补全中显示的描述。名称必须匹配 `[a-z0-9-]+`；冲突时内置命令优先。

```markdown
<!-- description: review code for issues -->
Review the following code and list concrete issues: $ARGUMENTS
```

REPL 启动时还会检查 npm 上是否有新版本（异步、非阻塞；用 `STAR_NO_UPDATE_CHECK=1` 禁用）。

## 技能

技能是代理按需加载的可复用指令包。把 `SKILL.md` 放进 `.star/skills/<name>/`（项目）或 `~/.star-cli/skills/<name>/`（用户）；同名时项目技能覆盖用户技能。每个 `SKILL.md` 以 frontmatter 开头（`name` 可选，默认为目录名；`description` 必填），随后是指令正文：

```markdown
---
description: Review code for common issues
---
Check error handling, naming, and test coverage. Report concrete findings with file:line references.
```

可用技能列在系统提示词中（只有名称 + 描述，所以在被用到前几乎不耗 token）。当请求匹配某个技能时，代理调用读取级的 `skill` 工具加载完整正文——`SKILL.md` 旁边的支持文件（脚本、模板、示例）相对技能目录解析。会话中途添加的技能在下一回合生效；`/skills` 列出当前可见的技能。正文上限 32KB。

## 长期记忆

`~/.star-cli/MEMORY.md` 是用户维护的长期记忆，每个回合开始时注入系统提示词（紧邻项目 `AGENTS.md`，上限 32KB），让偏好与约定跨会话、跨项目保留。它只在你明确要求时才会被写入：`/memory add <text>` 追加一条要点，代理的 `remember` 工具（写权限级别，因此在 `ask` 模式下经过权限门禁）在约定上仅限于明确的“记住这个”请求——不会自主记录任何内容。无参数的 `/memory` 显示当前内容与路径；直接编辑文件也可以，改动在下一回合生效。

## @file 引用

在任何提示中给路径加上 `@` 前缀即可附加其内容（REPL 与 print 模式一致）：

```
star -p "summarize @README.md and @src/main.tsx"
```

图片文件（`@screenshot.png` —— png、jpg、jpeg、gif、webp，最大 5MB）会作为图像输入发送给模型，而非内联文本，REPL 与 print 模式皆然；最长边超过 2000px 的会先缩放。print 模式下也可以用可重复的 `--image <path>` 参数附加图片：

```
star -p "what's wrong in this UI?" --image screenshot.png --image mockup.jpg
```

无效的 `--image` 路径（不支持的类型、不存在、不可读或超大）会让 print 模式以非零退出码中止。

如果服务商仍因图片过大而拒绝请求，代理会自动从对话中移除超大图片（替换为 `[image removed: too large for the model]` 占位符，存储的会话中同样替换）并重试请求一次，UI 中会有提示。

目录引用（`@src/agent/`，末尾斜杠可有可无）内联的是该目录的缩进树，而非文件内容——方便把项目结构交给模型而无需粘贴 `tree` 输出。列表遵循 `.starignore` 并跳过敏感文件，上限 200 条 / 10 层深度，超出时显示 `... (truncated, N more entries)` 标记。

缺失、二进制、超大（文本 >100KB，图片 >5MB）或敏感文件（`.env`、私钥）会被跳过并附说明。聊天历史保留你原始的 `@path` 文本，因此恢复的会话不会携带注入的大段内容。

## .starignore

工作目录中的 `.starignore` 文件可对代理隐藏路径：`glob` 和 `grep` 工具跳过匹配的文件（被忽略的目录整体剪除），`@file` 补全也会过滤它们。语法镜像 `.gitignore` 的基础——每行一个模式，`#` 注释，裸模式匹配文件名（`*.log`），带 `/` 的模式匹配相对路径（`build/**`），末尾 `/` 表示仅目录（`private/`）。不支持取反（`!`），显式请求的文件（如 `grep` 指定精确 `path`）仍会被读取。改动立即生效。

## 内置工具

`read_file`、`write_file`、`edit_file`、`glob`、`grep`、`bash`、`web_fetch`、`web_search`（DuckDuckGo，无需 API 密钥）、`todo_read`、`todo_write`、`task_list`、`task_output`、`task_kill`、`subagent`、`skill`、`remember`——每个都声明一个权限级别（`read` / `write` / `exec`），由权限门禁强制执行。硬性安全规则（危险 shell 命令、工作目录之外的路径、`.env` / 私钥等机密文件）在 `ask` / `auto` / `readonly` 下被拒绝，且无法被 allow 规则覆盖。

`subagent` 工具（`exec` 级别，因此在计划模式下隐藏，在 readonly 下被拒绝）派生一个带相同内置工具的子代理循环，处理专注、自包含的子任务——调研、探索或一处孤立的改动——并把子代理的最终报告作为工具结果返回。子代理只运行一层（子代理不能再派生子代理），共享父代理的权限模式与确认提示，其对话不持久化到会话。

权限模式：`ask`（读放行，写/执行询问）· `auto`（除上述硬性拒绝规则外全部放行）· `readonly`（只读）· `yolo`（放行一切，从不询问——**所有安全检查关闭**，风险自负）· `plan`（只读调研加计划审批流程，见上文——仅会话内）。运行时用 `/permission` 切换（持久化到配置文件），会话内用 `/plan` 或 `Shift+Tab`，启动时用 `--permission-mode`。在模式之上，`[permissions]` 配置块持有持久的 `allow` 和 `deny` 规则列表（同样的 `bash(npm test *)` 语法）；deny 规则在硬性安全规则之后评估，胜过 `auto` 模式和 allow 规则，而 `yolo` 绕过一切。

每次成功的 `write_file` / `edit_file` 会先快照文件的旧内容（内存中，每会话保留最近 50 次写入）；`/undo` 还原上一回合的快照——恢复旧内容，或删除该回合创建的文件——但只在展示撤回预览与逐文件还原 diff 并获得 `y`/`n` 确认之后。

## 检查点与 /rewind

每个快照同时也是一个带编号的**检查点**：`/rewind` 列出会话的每次文件改动（id、时间、工具、文件），`/rewind <n>` 把会话回滚到检查点 `n` 之前——此后改动的每个文件按相反顺序还原（期间创建的文件被删除），对话撤回到做出该改动的回合，撤销栈丢弃被回滚的条目。由于这是破坏性操作，命令会先显示受影响的文件改动与消息数量，并要求 `y`/`n` 确认。

检查点持久化在 `~/.star-cli/sessions/<id>/checkpoints/` 下（一个 `index.json` 加每个检查点一个内容文件，首次文件写入时才懒创建），因此用 `/resume` 或 `star -r` 恢复会话后回滚仍然可用。`/undo` 仍是细粒度的对应物：它只触碰上一个回合。

## 会话

会话持久化在 `~/.star-cli/sessions/<id>/` 下（消息为 JSONL + `meta.json`）。无参数的 `/resume` 打开当前目录会话的交互式选择器（最近活跃优先、消息数、相对时间、首条消息预览、当前会话带 `current` 标记；`/resume --all` 涵盖所有目录并显示各会话的 cwd），`/resume <id>` 和 `star -r <id>` 直接跳转到指定会话——两者都接受列表中显示的短 id。`/fork` 分叉当前会话：所有消息复制到一个标题为 `Fork of …` 的新会话并使之成为活动会话，因此你可以探索不同方向而原会话保持完好（检查点与回滚历史不随带）。`/search <query>` 对所有已存会话做全文搜索——消息文本加工具调用参数与结果——并列出带摘要片段的匹配会话，可直接 `/resume <id>`。`star -c`（`--continue`）直接回到当前目录最近活跃的会话，REPL 与 print 模式一致；目录没有会话时它会说明并开始新会话。`-r` 与 `-c` 互斥，裸 `star -r` 打印会话列表而不报错。会话是懒创建的——打开 REPL 不聊天就退出不会在磁盘留下任何东西，print 模式（`-p`）除非用 `-r` 或 `-c` 恢复，否则不创建会话。token 用量累积在 `meta.json` 中，因此 `/cost` 也反映恢复的历史。`/usage` 是 `/cost` 的全局对应物（`/cost` 保持会话作用域）：它聚合所有目录下每个会话的 `meta.json` 成一张面板——总计、最近 14 天有用量日期的按日柱状图，以及按模型细分并为配置了定价的模型给出美元估算（未配置定价的模型会列出但不计入总额）。按日数字来自此后记录的 `usageByDay` 桶映射；该字段出现之前记录的用量只有总计，显示为单独一行“earlier usage”（更早用量）。`/new` 丢弃内存中的对话并挂载一个全新的懒会话存储（旧会话保留在磁盘上）；删除是单独的显式操作——`/clear-sessions` 删除当前目录记录的会话，`/clear-sessions --all` 清空所有会话目录（包括 `meta.json` 不可读的），两者都保留当前活动会话；`star --clear-sessions [all]` 以非交互方式做同样的事并退出。

会话首个回合完成后（第一条用户消息得到第一条助手回复），一个轻量后台 LLM 请求——同一模型，上限 20 个输出 token——把第一条用户消息总结为短标题（≤50 字符，与消息语言一致）并存入 `meta.json`，`/resume` 列表从中读取。标题生成是即发即忘的：它从不阻塞 REPL 或 print 模式输出，只在会话尚无标题时运行（恢复的会话保留已有标题；无标题的旧会话在下一回合后获得标题），请求失败时标题保持为空——无标题会话在列表中显示为 `(无标题)`。进程退出时未完成的请求被放弃。只要挂载着会话它就适用，包括用 `-r`/`-c` 恢复的 print 模式。

## 开发

```bash
pnpm build           # tsup bundle to dist/
pnpm test            # vitest unit tests (no network)
pnpm typecheck       # tsc --noEmit
pnpm lint            # biome
pnpm test:pipeline   # layered pipeline incl. optional live LLM smoke (needs an API key)
```

CI 在 Ubuntu + Windows 上、Node 20/22 下运行 lint、typecheck、测试和构建（`.github/workflows/ci.yml`）。

架构：`src/cli`（Ink UI）、`src/agent`（主循环）、`src/llm`（Vercel AI SDK 服务商层）、`src/tools`、`src/context`（token 预算 + 压缩）、`src/permissions`、`src/session`、`src/config`。

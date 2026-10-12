# DSH 模型能力管理器（dsh-model-manager）

给 DSH 的 provider 模型手动调整**多模态（图片）输入**和**思考级别**的本地小工具。
零依赖安装：只用 Node 内置模块 + 本地 `js-yaml` 做校验。

## 快速开始

```
双击 start.cmd
```

或者：

```
node src/server.js                # 自动定位 ~/.dsh/profiles/desktop/cordis.patch.yml
node src/server.js <配置文件路径>  # 指定其它 profile / 文件
node src/server.js --port=8791
```

启动后访问 http://127.0.0.1:8791

## 关闭服务

任选一种：

| 方式 | 说明 |
| --- | --- |
| 界面右下角「**关闭服务**」按钮 | 最省事；有未保存改动时会先提醒 |
| 服务窗口按 **Ctrl+C** | 前台运行时可用，会打印「正在关闭服务…」 |
| 双击 **stop.cmd** | 按端口找到进程并结束；默认 8791，也可 `stop.cmd 8792` |
| 直接关掉那个黑色命令行窗口 | 同样有效（`start.cmd` 启动的就是前台进程） |

- 服务只监听 `127.0.0.1`，不对外网开放。
- 关闭服务只是停止这个本地网页程序：**已保存到配置文件的改动不受影响**，也不会碰 DSH 本体。
- 提示端口被占用时，说明已经有一个实例在运行（通常直接访问 http://127.0.0.1:8791 即可），或换端口：`node src/server.js --port=8792`。

## 界面怎么用

1. 左侧选 provider，右侧列出该 provider 的所有模型。
2. **图片输入**：`继承默认（纯文本）` / `仅文本` / `文本 + 图片`。
   - DSH 只会把图片送给声明了 `input: [text, image]` 的模型，未声明的一律按纯文本处理。
3. **思考**：
   - `继承默认（不声明）`：不改动。
   - `自定义档位`：勾选档位并填线上取值（`off` 可留空 → 写成 `null`，其余档位必须填值）。
   - `显式关闭`：写成 `reasoningEfforts: false`。
4. 批量按钮：整组开关图片、整组套用标准四档（`off/low/medium/high`）。
5. `按模型名智能建议`：按模型名猜测能力并填入表单，**只是启发式建议**，需要你逐条确认。
6. `预览差异` → 看清 unified diff → `写入配置`。写入前自动备份。

## 安全机制（为什么它可以放心用）

| 机制 | 说明 |
| --- | --- |
| 定点编辑 | 只重写 `input` / `reasoningEfforts` / `compat.supportsReasoningEffort` 这几种字段的行区间，其余内容（注释、键顺序、引号风格、空行）逐字节保留 |
| 预镜像校验 | 编辑区间之外的行必须与原文件完全一致，否则拒绝写入 |
| 语义校验 | 写入前重新解析 YAML，并与独立计算的期望结构逐字段比对，不一致就中止 |
| 协议自动修正 | `openai-completions` 声明档位时自动补 `compat.supportsReasoningEffort: true`；`openai-responses` 等协议下自动移除该开关（并给出提醒） |
| 自动备份 | 每次写入前把当前文件复制到 `backups/`（文件名含毫秒并自动去重），可一键恢复 |
| 外部改动保护 | 读取时记录文件指纹；若期间被 DSH 界面改过，提交会返回冲突，要求先重新读取，避免互相覆盖 |
| 原子写入 | 先写临时文件再替换，进程中断不会留下半截配置 |

> 生效方式：改完需要重启 DSH Desktop（或重新加载该 profile）。

## 字段语义速查

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      x666:
        api: openai-responses        # 协议决定思考字段走哪套格式
        compat:
          supportsReasoningEffort: true   # 仅 openai-completions 用；Responses 不要加
        models:
          - id: qwen3.8-27b-262k
            input:
              - text
              - image               # 声明后才允许发图片
            reasoningEfforts:
              off: null             # off 可以为空（null）
              low: low              # 其余档位是发给上游的线上取值
              medium: medium
              high: high
```

- 未声明 `input` → 按 `["text"]` 处理，多模态模型也无法识图。
- 未声明 `reasoningEfforts` 的自定义 provider → DSH 认为该模型不支持思考，界面不显示档位。
- `off` 之外的档位若留空，DSH 会把它视为“不支持”，因此本工具要求必须填值。

## 目录结构

```
dsh-model-manager/
├─ src/server.js     HTTP 服务 + 读取/预览/保存/备份/恢复
├─ src/editor.js     YAML 定点编辑器（扫描 → 生成编辑操作 → 期望结构）
├─ src/diff.js       unified diff（保存前预览）
├─ src/verify.js     预镜像校验 + 结构差异描述
├─ src/util.js       深度比较 / 标量渲染
├─ web/              界面（原生 HTML/CSS/JS）
├─ tools/            自检脚本（非运行必需）
├─ vendor/js-yaml.js js-yaml UMD 构建（MIT，见 vendor/js-yaml.LICENSE）
├─ test/             node:test 单元测试
└─ backups/          自动备份（首次保存时创建）
```

## 自检脚本

```
node --test                    # 13 项单元测试（含对真实配置的只读用例）
node tools/e2e-check.js        # 端到端：在临时副本上跑 保存→校验→恢复 全闭环
node tools/ui-check.js         # 界面自检：无头 Chrome 渲染 + 交互 + 截图
```

- `e2e-check.js` **只读取**真实配置，写入发生在临时副本上，跑完即删除。
- `ui-check.js` 需要本机 Chrome；会输出 `ui-check.png` 并可检查控制台是否有报错。

## 已知局限

- 模型视觉能力无法自动确定：名称启发式会误判，最终以你的确认和实测为准。
- `modelOverrides` 里的模型没有可编辑的 YAML 节点，界面会标注为不可编辑。
- 只处理 `llm-pi-ai` 这一个 loader 条目的 `providers`；其它 loader 条目不受影响。

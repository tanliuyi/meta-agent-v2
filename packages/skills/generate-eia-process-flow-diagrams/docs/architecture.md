# 环评流程图编辑器架构方案

## 目标

本项目生成和编辑环评风格的工艺流程及产污节点图。CLI 是主要操作入口，前端用于用户可视化查看和修改；两者可以同时操作同一个流程图。

系统需要支持：

- 工艺节点、产污节点、治理设施、储运设施和去向终点。
- 物料流、污染物流、回用流、公用工程流和边界关系。
- 节点、连线及环评工程分析字段的编辑。
- 用户与自动化操作同时修改时的实时同步。
- JSON、SVG、PNG、CSV、Mermaid 和 HTML 等输出。
- 流程拓扑、污染源、治理路径和最终去向的校验。

## 总体架构

```text
CLI ───────────────┐
                    ▼
React + Vite + React Flow ──┤
                    ▼
           Node API / 协同服务
                    ↕
          Y.Doc 流程图数据
                    ↕
        持久化适配器 / diagram.json

```

前端和 CLI 通过 Node API 操作流程图。协同服务负责服务端的数据合并和持久化；前端可以使用 Yjs provider 订阅实时变化，但 CLI 不作为在线协同客户端，不维护 Awareness 状态。

## 项目目录

```text
generate-eia-process-flow-diagrams/
├─ SKILL.md
├─ docs/
│  └─ architecture.md
├─ apps/
│  ├─ web/                         # React + Vite + React Flow
│  ├─ collaboration/               # Hocuspocus 协同服务
│  └─ server/                      # Node API 和静态资源服务
├─ packages/
│  ├─ diagram-model/               # 共享数据模型和业务校验
│  ├─ diagram-sync/                # React Flow 与 Y.Doc 同步适配层
│  └─ diagram-cli/                 # 主要自动化操作 CLI
├─ data/
│  ├─ diagram.json
│  └─ examples/
├─ references/
└─ scripts/
```

## 模块职责

### React + Vite 前端

前端面向用户，负责：

- 使用 React Flow 渲染流程图。
- 提供左上角菜单、画布和右侧属性检查器。
- 支持节点、连线、文字、坐标、尺寸、样式和环评字段编辑。
- 将用户操作写入 Y.Doc。
- 订阅 Y.Doc 更新并增量更新对应节点或连线。
- 显示其他用户或自动化操作的在线状态、选中对象和修改状态。
- 提供人工触发的导出入口。

React Flow 不作为协同数据源。React Flow 是受控视图和交互层，Y.Doc 是并行编辑状态的唯一来源。

### Hocuspocus 协同服务

协同服务负责：

- 为每个流程图提供独立的 Yjs 房间。
- 转发和持久化 Yjs 更新。
- 管理连接、重连和同步状态。
- 提供 Awareness 状态。
- 标识用户和自动化操作的 `actorId`、`actorType` 和 `operationId`。

推荐使用 `yjs`、`@hocuspocus/server` 和对应的 WebSocket provider。

### Node API

Node API 负责不需要实时协同的操作：

- 流程图导入和导出。
- `diagram.json` 转换为 Y.Doc 或从 Y.Doc 导出 JSON。
- 数据模型和环评业务规则校验。
- CSV、Mermaid 和报告数据导出。
- 静态资源服务。
- 协同房间鉴权和项目元数据管理。

Node API 与协同服务共同维护 Y.Doc 的一致状态。CLI 通过 Node API 提交原子操作；前端通过协同服务接收实时变化。API 也负责导入、导出、查询和校验。

CLI 面向自动化操作，是流程图的主要操作入口，负责：

- 根据工程资料创建流程图。
- 新增、修改和删除节点。
- 新增、修改和删除连线。
- 查询污染源、治理设施和最终去向。
- 执行拓扑和环评字段校验。
- 导出 JSON、CSV 和 Mermaid。
- 为每次修改通过 Node API 提交原子操作和操作元数据。
- 不直接管理 WebSocket 房间、在线状态、光标或 Awareness。

### 共享数据模型

`diagram-model` 定义：

- 节点字段。
- 连线字段。
- 污染源、治理设施和去向关系。
- 环评字段约束。
- ID、端点和拓扑校验。
- JSON 与 Y.Doc 之间的转换规则。

前端、CLI、Node API 和协同服务使用同一套数据模型，不在各模块中重复定义校验规则。

## Yjs 数据结构

```text
Y.Doc
├─ metadata: Y.Map
├─ nodes: Y.Map<nodeId, Y.Map>
├─ edges: Y.Map<edgeId, Y.Map>
├─ pollutionSources: Y.Map
├─ treatments: Y.Map
└─ awareness
```

节点和连线以 ID 为 key，字段以 Y.Map 属性保存。不要把整个画布 JSON 作为单个字符串同步。

节点示例：

```json
{
  "id": "N10",
  "label": "尾气冷凝器",
  "type": "treatment",
  "x": 400,
  "y": 220,
  "width": 180,
  "height": 56,
  "sourceCode": "G3-1",
  "pollutants": ["氯化氢"],
  "control": "冷凝回收",
  "route": "达标排放"
}
```

## React Flow 与 Y.Doc 同步

用户操作：

```text
React Flow 拖拽、编辑或删除
        ↓
同步适配层
        ↓
Y.Doc transaction
        ↓
Hocuspocus 广播
```

远程操作：

```text
Hocuspocus Y.Doc 更新
        ↓
同步适配层
        ↓
增量更新对应 React Flow 节点或连线
```

同步适配层必须防止双向更新形成循环触发。节点拖动期间只更新本地受控状态，在 `onNodeDragStop` 中提交坐标字段；远程变化按 ID 更新对应节点或连线，禁止替换整个画布。

## 并行修改

Yjs 负责服务端并行修改的合并。前端通过协同服务接收变化；CLI 通过 Node API 提交操作，不直接参与在线协同状态。

每个操作记录：

```json
{
  "actorId": "agent-01",
  "actorType": "agent",
  "operationId": "op-20260901-001",
  "changedAt": "2026-09-01T04:00:00Z"
}
```

处理原则：

- 不同节点的修改自动合并。
- 同一节点不同字段的修改自动合并。
- 同一字段的并发修改保留确定性结果，并记录修改来源。
- 删除节点与修改该节点同时发生时，删除优先，同时记录待确认事项。
- 删除节点必须同时删除关联连线。
- 新增节点使用稳定且唯一的 ID。
- 污染源编号、治理措施和最终去向发生并发冲突时，必须提示核对，不能静默丢弃信息。

## 持久化

协同状态和交付数据分层处理：

```text
Y.Doc 更新记录
      ↓
协同服务持久化
      ↓
按需或定期导出 diagram.json
```

`diagram.json` 用于：

- 初始化协同房间。
- CLI 和前端之间的数据交换。
- 离线导入和导出。
- 报告编制和审查。
- 最终交付。

Yjs 更新记录用于：

- 实时协同。
- 重连恢复。
- 修改历史和审计。

并行编辑时不能让前端和 CLI 各自直接写 `diagram.json`。

## API 与 CLI 边界

实时修改：前端使用 Yjs / Hocuspocus；CLI 通过 Node API 提交原子操作。
查询校验：Node API 或 CLI
导入导出：Node API 或 CLI

CLI 命令示例：

```bash
node scripts/eia-flow.mjs diagram get
node scripts/eia-flow.mjs node add --file node.json
node scripts/eia-flow.mjs node update N10 --file patch.json
node scripts/eia-flow.mjs edge add --file edge.json
node scripts/eia-flow.mjs diagram validate
node scripts/eia-flow.mjs export csv --output pollution.csv
```

## 图件样式

图件采用固定的环评报告图样式：

- 黑白线稿。
- 宋体或同类衬线中文字体。
- 白底黑色细边框矩形工艺框。
- 黑色实线和实心三角箭头。
- 回用、循环、公用工程、污染物和排放关系通过标签、线型或虚线边界区分。
- 污染源编号、污染物、排放口、外排、回用和处置去向标注在对应位置。
- 工艺区域或循环区域可使用虚线边界。
- 图题和图号置于图件底部。
- 布局根据工艺拓扑、回流关系和文字可读性确定，不固定横向或纵向方向。

## 构建边界

源码项目包含前端、后端、协同服务、主要操作 CLI 和共享模型。发布构建只复制运行所需的前端静态资源、Node 服务、协同服务、CLI、数据、引用文档和 `SKILL.md`。

发布构建不改变 `SKILL.md` 的职责。`SKILL.md` 只描述流程图任务的执行规则，不描述本架构的实现细节。

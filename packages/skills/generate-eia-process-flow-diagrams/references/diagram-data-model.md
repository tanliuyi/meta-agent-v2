# Diagram Data Model

```json
{
  "metadata": { "title": "工艺流程及产污节点图", "figure": "图 2.3-1" },
  "nodes": [
    { "id": "N1", "label": "流化床反应器", "type": "process", "x": 300, "y": 180 },
    { "id": "G1", "label": "G3-1 合成尾气", "type": "pollution", "x": 650, "y": 180 }
  ],
  "edges": [
    { "id": "E1", "from": "N1", "to": "G1", "kind": "material", "label": "尾气" }
  ]
}
```

`nodes` 中的 `type` 可使用 `process`、`pollution`、`treatment` 或 `terminal`。`x` 和 `y` 是 SVG 画布坐标。`edges.from` 和 `edges.to` 必须引用已有节点 ID。删除节点时，服务端会自动删除其关联连线。

扩展字段可用于记录污染物、去向、工艺参数、源编号和治理设施，但必须保持 JSON 可序列化，并在图中有对应的可读标注。

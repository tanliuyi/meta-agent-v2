export const validateDiagram = (diagram) => {
  if (!diagram || !Array.isArray(diagram.nodes) || !Array.isArray(diagram.edges)) throw new Error("diagram.nodes 和 diagram.edges 必须是数组");
  const nodeIds = new Set();
  for (const node of diagram.nodes) {
    if (!node.id || nodeIds.has(node.id)) throw new Error("节点 ID 必须唯一且非空");
    if (typeof node.label !== "string" || !node.label.trim()) throw new Error("节点 label 必须是非空字符串");
    nodeIds.add(node.id);
  }
  const edgeIds = new Set();
  for (const edge of diagram.edges) {
    if (!edge.id || edgeIds.has(edge.id)) throw new Error("连线 ID 必须唯一且非空");
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new Error("连线端点必须引用现有节点");
    edgeIds.add(edge.id);
  }
  return diagram;
};

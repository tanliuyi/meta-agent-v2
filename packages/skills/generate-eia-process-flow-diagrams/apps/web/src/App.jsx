import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  BaseEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  reconnectEdge,
  ViewportPortal,
} from "@xyflow/react";
import * as Y from "yjs";
import "@xyflow/react/dist/style.css";
import "./styles.css";

const USER_ORIGIN = "user";
const Icon = ({ name }) => {
  const paths = {
    undo: "M9 7 4 12l5 5M5 12h8a6 6 0 0 1 6 6",
    redo: "m15 7 5 5-5 5M19 12h-8a6 6 0 0 0-6 6",
    plus: "M12 5v14M5 12h14",
    trash: "M5 7h14M10 11v6M14 11v6M8 7l1-2h6l1 2m-9 0 1 13h10l1-13",
    edit: "M4 20h4L19 9l-4-4L4 16v4M13 6l4 4",
    route: "M5 5h.01M19 19h.01M5 19 19 5",
    group: "M8 8h8v8H8zM4 4h4M16 4h4M4 20h4M16 20h4",
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name] ?? paths.edit} /></svg>;
};

const objectFromMap = (value) => value instanceof Y.Map ? Object.fromEntries(value.entries()) : value;

const patchMap = (map, value) => {
  for (const [key, field] of Object.entries(value)) map.set(key, field);
};
const diagramFromDoc = (doc) => ({
  metadata: objectFromMap(doc.getMap("metadata")),
  nodes: [...doc.getMap("nodes").values()].map(objectFromMap),
  edges: [...doc.getMap("edges").values()].map(objectFromMap),
  pollutionSources: doc.getMap("collections").get("pollutionSources") ?? [],
  treatments: doc.getMap("collections").get("treatments") ?? [],
  legend: doc.getMap("collections").get("legend") ?? [],
});
const toFlowNode = (node) => {
  const width = node.width ?? 180;
  const height = node.height ?? 56;
  return {
    id: node.id,
    type: node.type === "boundary" ? "boundary" : "process",
    // React Flow snaps the node origin. Use the visual center so unequal widths align correctly.
    position: { x: (node.x ?? 80) + width / 2, y: (node.y ?? 80) + height / 2 },
    width,
    height,
    data: node,
    initialWidth: width,
    initialHeight: height,
    style: { width, height },
  };
};
const getNodeSize = (node) => ({
  width: node.measured?.width ?? node.width ?? 180,
  height: node.measured?.height ?? node.height ?? 56,
});
const snapNodePosition = (node, currentNodes) => {
  const size = getNodeSize(node);
  const grid = 10;
  const threshold = 12;
  const others = currentNodes.filter((candidate) => candidate.id !== node.id);
  const candidates = { x: [], y: [] };
  const addTarget = (axis, value, guide) => candidates[axis].push({ value, guide });
  for (const other of others) {
    const otherSize = getNodeSize(other);
    addTarget("x", other.position.x, other.position.x);
    addTarget("x", other.position.x - otherSize.width / 2 + size.width / 2, other.position.x - otherSize.width / 2);
    addTarget("x", other.position.x + otherSize.width / 2 - size.width / 2, other.position.x + otherSize.width / 2);
    addTarget("y", other.position.y, other.position.y);
    addTarget("y", other.position.y - otherSize.height / 2 + size.height / 2, other.position.y - otherSize.height / 2);
    addTarget("y", other.position.y + otherSize.height / 2 - size.height / 2, other.position.y + otherSize.height / 2);
  }
  const choose = (axis) => {
    const nearestAlignment = candidates[axis].reduce((best, candidate) => !best || Math.abs(candidate.value - node.position[axis]) < Math.abs(best.value - node.position[axis]) ? candidate : best, null);
    if (nearestAlignment && Math.abs(nearestAlignment.value - node.position[axis]) <= threshold) return nearestAlignment;
    return { value: Math.round(node.position[axis] / grid) * grid, guide: null };
  };
  const x = choose("x");
  const y = choose("y");
  return {
    position: { x: Math.abs(x.value - node.position.x) <= threshold ? x.value : node.position.x, y: Math.abs(y.value - node.position.y) <= threshold ? y.value : node.position.y },
    guides: [
      ...(x.guide === null || Math.abs(x.value - node.position.x) > threshold ? [] : [{ axis: "x", value: x.guide }]),
      ...(y.guide === null || Math.abs(y.value - node.position.y) > threshold ? [] : [{ axis: "y", value: y.guide }]),
    ],
  };
};
const toFlowEdge = (edge, nodeLookup, onWaypointsChange, screenToFlowPosition) => {
  const source = nodeLookup?.get(edge.from);
  const target = nodeLookup?.get(edge.to);
  const horizontal = source && target && Math.abs((target.x ?? 0) - (source.x ?? 0)) >= Math.abs((target.y ?? 0) - (source.y ?? 0));
  const forward = horizontal ? (target?.x ?? 0) >= (source?.x ?? 0) : (target?.y ?? 0) >= (source?.y ?? 0);
  const sourceHandlePosition = horizontal ? (forward ? "right" : "left") : (forward ? "bottom" : "top");
  const targetHandlePosition = horizontal ? (forward ? "left" : "right") : (forward ? "top" : "bottom");
  const sourceHandle = edge.sourceHandle?.startsWith("source-") ? edge.sourceHandle : `source-${edge.sourceHandle ?? sourceHandlePosition}`;
  const targetHandle = edge.targetHandle?.startsWith("target-") ? edge.targetHandle : `target-${edge.targetHandle ?? targetHandlePosition}`;
  const arrow = edge.arrow ?? "closed";
  const stroke = edge.stroke ?? "#222222";
  return {
    id: edge.id,
    source: edge.from,
    target: edge.to,
    sourceHandle,
    targetHandle,
    label: edge.label ?? "",
    type: edge.waypoints?.length ? "routed" : (edge.route ?? "smoothstep"),
    markerEnd: arrow === "none" ? undefined : { type: arrow === "open" ? MarkerType.Arrow : MarkerType.ArrowClosed, width: 18, height: 18, color: stroke },
    style: {
      stroke,
      strokeWidth: edge.strokeWidth ?? 1.4,
      strokeDasharray: edge.lineStyle === "dashed" ? "7 5" : undefined,
    },
    data: { ...edge, onWaypointsChange, screenToFlowPosition },
  };
};

const handleId = (type, position) => `${type}-${position}`;
const ProcessNode = memo(function ProcessNode({ data, selected }) {
  return <div className={`process-node ${data.type ?? "process"}${selected ? " selected" : ""}`} style={{ fontSize: data.fontSize, fontWeight: data.fontWeight }}>
    <NodeResizer isVisible={selected} minWidth={80} minHeight={28} color="#2c66b8" />
    {[Position.Top, Position.Right, Position.Bottom, Position.Left].map((position) => <Handle key={`target-${position}`} type="target" position={position} id={handleId("target", position)} />)}
    <div className="process-node-label">{data.label}</div>
    {[Position.Top, Position.Right, Position.Bottom, Position.Left].map((position) => <Handle key={`source-${position}`} type="source" position={position} id={handleId("source", position)} />)}
  </div>;
});
const RoutedEdge = memo(function RoutedEdge({ sourceX, sourceY, targetX, targetY, data, markerEnd, style, selected }) {
  const waypoints = Array.isArray(data?.waypoints) ? data.waypoints : [];
  const [draftWaypoints, setDraftWaypoints] = useState(null);
  const [draggingIndex, setDraggingIndex] = useState(null);
  const dragRef = useRef(null);
  const editableWaypoints = draftWaypoints ?? waypoints;
  useEffect(() => {
    if (draggingIndex === null) return undefined;
    const onMove = (event) => {
      const next = data.screenToFlowPosition?.({ x: event.clientX, y: event.clientY });
      if (!next || !dragRef.current) return;
      dragRef.current.waypoints = dragRef.current.waypoints.map((point, index) => index === draggingIndex ? { x: next.x, y: next.y } : point);
      setDraftWaypoints(dragRef.current.waypoints);
    };
    const onUp = () => {
      const drag = dragRef.current;
      if (drag) data.onWaypointsChange?.(data.id, draggingIndex, drag.waypoints[draggingIndex]);
      dragRef.current = null;
      setDraggingIndex(null);
      setDraftWaypoints(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [data, draggingIndex]);
  const path = [`M ${sourceX} ${sourceY}`, ...editableWaypoints.map((point) => `L ${point.x} ${point.y}`), `L ${targetX} ${targetY}`].join(" ");
  return <>
    <BaseEdge path={path} markerEnd={markerEnd} style={style} />
    {selected ? <g className="edge-waypoint-controls">
      {editableWaypoints.map((point, index) => <circle key={`${index}-${point.x}-${point.y}`} cx={point.x} cy={point.y} r={6} onPointerDown={(event) => {
        event.stopPropagation();
        dragRef.current = { waypoints: waypoints.map((waypoint) => ({ ...waypoint })) };
        setDraftWaypoints(dragRef.current.waypoints);
        setDraggingIndex(index);
      }} />)}
    </g> : null}
  </>; });
const BoundaryNode = memo(function BoundaryNode({ data, selected }) {
  return <div className={`process-node boundary${selected ? " selected" : ""}`} style={{ fontSize: data.fontSize, fontWeight: data.fontWeight }}>
    <div className="boundary-label">{data.label}</div>
  </div>;
});

const HistoryActions = memo(function HistoryActions({ canUndo, canRedo, onUndo, onRedo }) {
  return <div className="history-actions">
    <button className="icon-button" title="撤销" aria-label="撤销" disabled={!canUndo} onClick={onUndo}><Icon name="undo" /></button>
    <button className="icon-button" title="重做" aria-label="重做" disabled={!canRedo} onClick={onRedo}><Icon name="redo" /></button>
  </div>;
});

const AppHeader = memo(function AppHeader({ menu, onToggleMenu, onExport, canUndo, canRedo, onUndo, onRedo }) {
  return <header className="topbar">
    <HistoryActions canUndo={canUndo} canRedo={canRedo} onUndo={onUndo} onRedo={onRedo} />
    <button className="menu-trigger" onClick={onToggleMenu}>
      <span className="mark"><svg viewBox="0 0 24 24"><path d="M7 5h10M7 12h10M7 19h10M5 5h.01M5 12h.01M5 19h.01" /></svg></span>
      <b>Untitled</b>
      <svg className="chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {menu ? <nav className="menu"><button onClick={onExport}>导出 JSON</button></nav> : null}
  </header>;
});

const ContextMenu = memo(function ContextMenu({ contextMenu, onClose, onAction }) {
  if (!contextMenu) return null;
  return <nav className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
    {contextMenu.target.kind === "pane" ? <>
      <button onClick={() => onAction("add-process")}><Icon name="plus" />新增工序节点</button>
      <button onClick={() => onAction("add-pollution")}><Icon name="plus" />新增产污节点</button>
    </> : <>
      <button onClick={onClose}><Icon name="edit" />编辑属性</button>
      {contextMenu.target.kind === "edge" ? <button onClick={() => onAction("waypoints")}><Icon name="route" />编辑拐点</button> : null}
      <button onClick={() => onAction("delete")}><Icon name="trash" />删除</button>
    </>}
  </nav>;
});

const nodeTypes = { process: ProcessNode, boundary: BoundaryNode };
const edgeTypes = { routed: RoutedEdge };
const defaultEdgeOptions = { type: "smoothstep" };
const fitViewOptions = { padding: 0.2 };
const snapGrid = [10, 10];
const edgeKindOptions = [
  ["material", "物料"],
  ["waste-gas", "废气"],
  ["waste-water", "废水"],
  ["solid-waste", "固废"],
  ["reuse", "回用"],
  ["utility", "公用工程"],
];
const edgeRouteOptions = [
  ["smoothstep", "圆角折线"],
  ["step", "直角折线"],
  ["straight", "直线"],
  ["bezier", "曲线"],
];

export default function App() {
  const ydocRef = useRef(null);
  const providerRef = useRef(null);
  const reactFlowRef = useRef(null);
  const selectedRef = useRef(null);
  const selectedNodesRef = useRef([]);
  const waypointChangeRef = useRef(null);
  const fitViewPending = useRef(true);
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draftValues, setDraftValues] = useState({});
  const pendingUpdatesRef = useRef(new Map());
  const [selectedNodeIds, setSelectedNodeIds] = useState([]);
  const [status, setStatus] = useState("连接中…");
  const [menu, setMenu] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [alignmentGuides, setAlignmentGuides] = useState([]);
  const undoManagerRef = useRef(null);

  useEffect(() => {
    setDraftValues({});
    for (const timer of pendingUpdatesRef.current.values()) clearTimeout(timer);
    pendingUpdatesRef.current.clear();
  }, [selected]);

  const select = useCallback((value) => {
    selectedRef.current = value;
    selectedNodesRef.current = value?.kind === "node" ? [value.id] : [];
    setSelectedNodeIds(value?.kind === "node" ? [value.id] : []);
    setSelected(value);
    setNodes((current) => current.map((node) => {
      const nextSelected = value?.kind === "node" && node.id === value.id;
      return node.selected === nextSelected ? node : { ...node, selected: nextSelected };
    }));
    setEdges((current) => current.map((edge) => {
      const nextSelected = value?.kind === "edge" && edge.id === value.id;
      return edge.selected === nextSelected ? edge : { ...edge, selected: nextSelected };
    }));
  }, []);

  const selectNodes = useCallback((ids) => {
    const uniqueIds = [...new Set(ids)];
    selectedNodesRef.current = uniqueIds;
    selectedRef.current = uniqueIds.length === 1 ? { kind: "node", id: uniqueIds[0] } : null;
    setSelectedNodeIds(uniqueIds);
    setSelected(uniqueIds.length === 1 ? { kind: "node", id: uniqueIds[0] } : null);
    setNodes((current) => current.map((node) => {
      const nextSelected = uniqueIds.includes(node.id);
      return node.selected === nextSelected ? node : { ...node, selected: nextSelected };
    }));
    setEdges((current) => current.map((edge) => edge.selected ? { ...edge, selected: false } : edge));
  }, []);

  const refreshFromDoc = useCallback(() => {
    const doc = ydocRef.current;
    if (!doc) return;
    const nextNodes = [...doc.getMap("nodes").values()].map(objectFromMap);
    const nextEdges = [...doc.getMap("edges").values()].map(objectFromMap);
    const nodeLookup = new Map(nextNodes.map((node) => [node.id, node]));
    const currentSelection = selectedRef.current;
    const currentNodeIds = new Set(selectedNodesRef.current);
    setNodes(nextNodes.map((node) => ({ ...toFlowNode(node), selected: currentNodeIds.has(node.id) })));
    setEdges(nextEdges.map((edge) => ({ ...toFlowEdge(edge, nodeLookup, waypointChangeRef.current, (point) => reactFlowRef.current?.screenToFlowPosition(point)), selected: currentSelection?.kind === "edge" && currentSelection.id === edge.id })));
    setStatus(`已同步 ${nextNodes.length} 个节点、${nextEdges.length} 条连线`);
    if (fitViewPending.current && nextNodes.length) {
      fitViewPending.current = false;
      requestAnimationFrame(() => reactFlowRef.current?.fitView({ padding: 0.2 }));
    }
  }, []);

  useEffect(() => {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: import.meta.env.VITE_COLLAB_URL ?? "ws://127.0.0.1:1234",
      name: "diagram",
      document: doc,
      onSynced: refreshFromDoc,
      onStatus: ({ status: nextStatus }) => setStatus(nextStatus === "connected" ? "正在同步…" : "连接已断开"),
    });
    ydocRef.current = doc;
    providerRef.current = provider;
    const nodesMap = doc.getMap("nodes");
    const edgesMap = doc.getMap("edges");
    const undoManager = new Y.UndoManager([nodesMap, edgesMap], { trackedOrigins: new Set([USER_ORIGIN]) });
    const updateHistory = () => setHistoryVersion((version) => version + 1);
    undoManager.on("stack-item-added", updateHistory);
    undoManager.on("stack-item-popped", updateHistory);
    undoManagerRef.current = undoManager;
    nodesMap.observeDeep(refreshFromDoc);
    edgesMap.observeDeep(refreshFromDoc);
    return () => {
      undoManager.off("stack-item-added", updateHistory);
      undoManager.off("stack-item-popped", updateHistory);
      undoManager.destroy();
      undoManagerRef.current = null;
      nodesMap.unobserveDeep(refreshFromDoc);
      edgesMap.unobserveDeep(refreshFromDoc);
      provider.destroy();
      doc.destroy();
      providerRef.current = null;
      ydocRef.current = null;
    };
  }, [refreshFromDoc]);

  const transact = useCallback((run) => {
    const doc = ydocRef.current;
    if (!doc) return;
    doc.transact(run, USER_ORIGIN);
  }, []);

  const undo = useCallback(() => {
    undoManagerRef.current?.undo();
  }, []);
  const redo = useCallback(() => {
    undoManagerRef.current?.redo();
  }, []);

  const updateEdgeWaypoints = useCallback((edgeId, index, point) => {
    transact(() => {
      const map = ydocRef.current.getMap("edges").get(edgeId);
      const current = Array.isArray(map?.get("waypoints")) ? map.get("waypoints") : [];
      if (!map || !current[index]) return;
      map.set("waypoints", current.map((waypoint, waypointIndex) => waypointIndex === index ? { x: Math.round(point.x), y: Math.round(point.y) } : waypoint));
    });
  }, [transact]);
  waypointChangeRef.current = updateEdgeWaypoints;

  const onNodesChange = useCallback((changes) => {
    setNodes((current) => {
      let next = applyNodeChanges(changes, current);
      const moved = changes.filter((change) => change.type === "position" && change.position);
      let guides = [];
      for (const change of moved) {
        const node = next.find((candidate) => candidate.id === change.id);
        if (!node) continue;
        const result = snapNodePosition(node, next);
        next = next.map((candidate) => candidate.id === node.id ? { ...candidate, position: result.position } : candidate);
        guides = result.guides;
      }
      setAlignmentGuides(guides);
      const resized = changes.filter((change) => change.type === "dimensions" && change.dimensions && change.resizing === false);
      if (resized.length) {
        transact(() => {
          const nodesMap = ydocRef.current.getMap("nodes");
          for (const change of resized) {
            const node = next.find((candidate) => candidate.id === change.id);
            const map = nodesMap.get(change.id);
            if (node && map) {
              const size = getNodeSize(node);
              patchMap(map, { width: size.width, height: size.height, x: node.position.x - size.width / 2, y: node.position.y - size.height / 2 });
            }
          }
        });
      }
      return next;
    });
  }, [transact]);

  const onNodeDragStop = useCallback((_event, node) => {
    const size = getNodeSize(node);
    const position = snapNodePosition(node, nodes).position;
    setAlignmentGuides([]);
    transact(() => {
      const nodesMap = ydocRef.current.getMap("nodes");
      const persisted = nodesMap.get(node.id);
      const oldX = (persisted?.get("x") ?? node.position.x - size.width / 2) + size.width / 2;
      const oldY = (persisted?.get("y") ?? node.position.y - size.height / 2) + size.height / 2;
      const deltaX = position.x - oldX;
      const deltaY = position.y - oldY;
      const groupId = persisted?.get("groupId");
      for (const [id, map] of nodesMap.entries()) {
        if (id === node.id || !groupId || map.get("groupId") !== groupId) continue;
        patchMap(map, { x: (map.get("x") ?? 80) + deltaX, y: (map.get("y") ?? 80) + deltaY });
      }
      if (persisted) patchMap(persisted, { x: position.x - size.width / 2, y: position.y - size.height / 2 });
    });
  }, [nodes, transact]);

  const onNodesDelete = useCallback((deletedNodes) => {
    const deletedIds = new Set(deletedNodes.map((node) => node.id));
    transact(() => {
      const nodesMap = ydocRef.current.getMap("nodes");
      const edgesMap = ydocRef.current.getMap("edges");
      for (const id of deletedIds) nodesMap.delete(id);
      for (const [edgeId, edge] of edgesMap.entries()) if (deletedIds.has(edge.get("from")) || deletedIds.has(edge.get("to"))) edgesMap.delete(edgeId);
    });
    select(null);
  }, [select, transact]);

  const onEdgesChange = useCallback((changes) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const onEdgesDelete = useCallback((deletedEdges) => {
    transact(() => {
      const edgesMap = ydocRef.current.getMap("edges");
      for (const edge of deletedEdges) edgesMap.delete(edge.id);
    });
    select(null);
  }, [select, transact]);

  const onConnect = useCallback((connection) => {
    const id = crypto.randomUUID();
    const value = {
      id,
      from: connection.source,
      to: connection.target,
      sourceHandle: connection.sourceHandle ?? null,
      targetHandle: connection.targetHandle ?? null,
      kind: "material",
      label: "",
      route: "smoothstep",
      lineStyle: "solid",
      stroke: "#222222",
      strokeWidth: 1.4,
      arrow: "closed",
    };
    setEdges((current) => addEdge(toFlowEdge(value, null, waypointChangeRef.current), current));
    transact(() => {
      const map = new Y.Map();
      patchMap(map, value);
      ydocRef.current.getMap("edges").set(id, map);
    });
  }, [transact]);

  const onReconnect = useCallback((oldEdge, connection) => {
    setEdges((current) => reconnectEdge(oldEdge, connection, current));
    transact(() => {
      const map = ydocRef.current.getMap("edges").get(oldEdge.id);
      if (map) patchMap(map, { from: connection.source, to: connection.target, sourceHandle: connection.sourceHandle ?? null, targetHandle: connection.targetHandle ?? null });
    });
  }, [transact]);

  const isValidConnection = useCallback((connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return false;
    return !edges.some((edge) => edge.source === connection.source && edge.target === connection.target && edge.sourceHandle === connection.sourceHandle && edge.targetHandle === connection.targetHandle);
  }, [edges]);

  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }) => {
    if (selectedNodes.length && selectedEdges.length === 0) selectNodes(selectedNodes.map((node) => node.id));
    else if (selectedEdges.length === 1 && selectedNodes.length === 0) select({ kind: "edge", id: selectedEdges[0].id });
    else if (selectedNodes.length === 0 && selectedEdges.length === 0) select(null);
  }, [select, selectNodes]);

  const onInit = useCallback((instance) => { reactFlowRef.current = instance; }, []);

  const addNode = useCallback((type, centerPosition = { x: 210, y: 128 }) => {
    const id = `N${Date.now()}`;
    const width = 180;
    const height = 56;
    const value = { id, label: type === "pollution" ? "待编号产污节点" : "新工艺节点", type, x: centerPosition.x - width / 2, y: centerPosition.y - height / 2, width, height };
    transact(() => {
      const map = new Y.Map();
      patchMap(map, value);
      ydocRef.current.getMap("nodes").set(id, map);
    });
    select({ kind: "node", id });
  }, [select, transact]);

  const deleteSelected = useCallback(() => {
    const nodeIds = new Set(selectedNodeIds);
    if (selected?.kind === "node") nodeIds.add(selected.id);
    if (!nodeIds.size && selected?.kind !== "edge") return;
    transact(() => {
      const nodesMap = ydocRef.current.getMap("nodes");
      const edgesMap = ydocRef.current.getMap("edges");
      if (selected?.kind === "edge") edgesMap.delete(selected.id);
      for (const id of nodeIds) nodesMap.delete(id);
      for (const [edgeId, edge] of edgesMap.entries()) if (nodeIds.has(edge.get("from")) || nodeIds.has(edge.get("to"))) edgesMap.delete(edgeId);
    });
    select(null);
  }, [selected, selectedNodeIds, select, transact]);

  const selectedValue = useMemo(() => {
    if (!selected) return null;
    const doc = ydocRef.current;
    const map = doc?.getMap(selected.kind === "node" ? "nodes" : "edges").get(selected.id);
    return map ? objectFromMap(map) : null;
  }, [selected, nodes, edges]);

  const updateSelected = useCallback((field, value) => {
    if (!selected) return;
    setDraftValues((current) => ({ ...current, [field]: value }));
    const key = `${selected.kind}:${selected.id}:${field}`;
    const pending = pendingUpdatesRef.current.get(key);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      pendingUpdatesRef.current.delete(key);
      transact(() => {
        const map = ydocRef.current.getMap(selected.kind === "node" ? "nodes" : "edges").get(selected.id);
        if (map) map.set(field, value);
      });
    }, 120);
    pendingUpdatesRef.current.set(key, timer);
  }, [selected, transact]);

  const enableWaypointEditing = useCallback(() => {
    if (selected?.kind !== "edge") return;
    const edge = edges.find((candidate) => candidate.id === selected.id);
    if (!edge || edge.data?.waypoints?.length) return;
    const source = nodes.find((node) => node.id === edge.source);
    const target = nodes.find((node) => node.id === edge.target);
    if (!source || !target) return;
    transact(() => {
      const map = ydocRef.current.getMap("edges").get(edge.id);
      if (map) map.set("waypoints", [{ x: source.position.x, y: target.position.y }]);
    });
  }, [edges, nodes, selected, transact]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const openContextMenu = useCallback((event, target) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, target });
    if (target.kind === "node") select({ kind: "node", id: target.id });
    if (target.kind === "edge") select({ kind: "edge", id: target.id });
  }, [select]);

  const onPaneContextMenu = useCallback((event) => openContextMenu(event, { kind: "pane" }), [openContextMenu]);

  const onContextAction = useCallback((action) => {
    const target = contextMenu?.target;
    if (!target) return;
    if (action === "delete") deleteSelected();
    if (action === "waypoints") enableWaypointEditing();
    if (action === "add-process") addNode("process", reactFlowRef.current?.screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y }));
    if (action === "add-pollution") addNode("pollution", reactFlowRef.current?.screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y }));
    closeContextMenu();
  }, [addNode, closeContextMenu, contextMenu, deleteSelected, enableWaypointEditing]);

  const selectedNodeValues = useMemo(() => {
    if (!selectedNodeIds.length || !ydocRef.current) return [];
    const map = ydocRef.current.getMap("nodes");
    return selectedNodeIds.map((id) => map.get(id)).filter(Boolean).map(objectFromMap);
  }, [selectedNodeIds, nodes]);

  const nodeFieldValue = (field) => {
    const values = selectedNodeValues.map((node) => node[field]);
    return values.length && values.every((value) => value === values[0]) ? values[0] : undefined;
  };

  const updateManyNodes = useCallback((field, value) => {
    if (!selectedNodeIds.length) return;
    transact(() => {
      const map = ydocRef.current.getMap("nodes");
      for (const id of selectedNodeIds) {
        const node = map.get(id);
        if (node) node.set(field, value);
      }
    });
  }, [selectedNodeIds, transact]);

  const updateNodeLayout = useCallback((layout) => {
    if (!selectedNodeIds.length) return;
    transact(() => {
      const map = ydocRef.current.getMap("nodes");
      for (const [id, patch] of Object.entries(layout)) {
        const node = map.get(id);
        if (node) patchMap(node, patch);
      }
    });
  }, [selectedNodeIds, transact]);

  const alignNodes = useCallback((mode) => {
    const selectedNodes = nodes.filter((node) => selectedNodeIds.includes(node.id));
    if (selectedNodes.length < 2) return;
    const sizes = new Map(selectedNodes.map((node) => [node.id, getNodeSize(node)]));
    const values = selectedNodes.map((node) => {
      const size = sizes.get(node.id);
      return { node, size, left: node.position.x - size.width / 2, right: node.position.x + size.width / 2, top: node.position.y - size.height / 2, bottom: node.position.y + size.height / 2 };
    });
    const layout = {};
    if (mode === "left" || mode === "right" || mode === "center-x") {
      const target = mode === "left" ? Math.min(...values.map((value) => value.left)) : mode === "right" ? Math.max(...values.map((value) => value.right)) : (Math.min(...values.map((value) => value.left)) + Math.max(...values.map((value) => value.right))) / 2;
      for (const value of values) layout[value.node.id] = { x: target + (mode === "left" ? value.size.width / 2 : mode === "right" ? -value.size.width / 2 : 0) };
    } else {
      const target = mode === "top" ? Math.min(...values.map((value) => value.top)) : mode === "bottom" ? Math.max(...values.map((value) => value.bottom)) : (Math.min(...values.map((value) => value.top)) + Math.max(...values.map((value) => value.bottom))) / 2;
      for (const value of values) layout[value.node.id] = { y: target + (mode === "top" ? value.size.height / 2 : mode === "bottom" ? -value.size.height / 2 : 0) };
    }
    for (const value of values) {
      const patch = layout[value.node.id];
      patch.x = patch.x === undefined ? value.node.position.x - value.size.width / 2 : patch.x - value.size.width / 2;
      patch.y = patch.y === undefined ? value.node.position.y - value.size.height / 2 : patch.y - value.size.height / 2;
    }
    updateNodeLayout(layout);
  }, [nodes, selectedNodeIds, updateNodeLayout]);

  const distributeNodes = useCallback((axis) => {
    const selectedNodes = nodes.filter((node) => selectedNodeIds.includes(node.id));
    if (selectedNodes.length < 3) return;
    const sizeKey = axis === "x" ? "width" : "height";
    const values = selectedNodes.map((node) => ({ node, size: getNodeSize(node) })).sort((a, b) => a.node.position[axis] - b.node.position[axis]);
    const firstEdge = values[0].node.position[axis] - values[0].size[sizeKey] / 2;
    const lastEdge = values.at(-1).node.position[axis] + values.at(-1).size[sizeKey] / 2;
    const gap = (lastEdge - firstEdge - values.reduce((sum, value) => sum + value.size[sizeKey], 0)) / (values.length - 1);
    let cursor = firstEdge;
    const layout = {};
    for (const value of values) {
      layout[value.node.id] = { x: value.node.position.x - value.size.width / 2, y: value.node.position.y - value.size.height / 2 };
      layout[value.node.id][axis] = cursor;
      cursor += value.size[sizeKey] + gap;
    }
    updateNodeLayout(layout);
  }, [nodes, selectedNodeIds, updateNodeLayout]);

  const groupSelected = useCallback(() => {
    if (selectedNodeIds.length < 2) return;
    updateManyNodes("groupId", `G${Date.now()}`);
  }, [selectedNodeIds, updateManyNodes]);

  const ungroupSelected = useCallback(() => {
    if (!selectedNodeIds.length) return;
    transact(() => {
      const map = ydocRef.current.getMap("nodes");
      for (const id of selectedNodeIds) map.get(id)?.delete("groupId");
    });
  }, [selectedNodeIds, transact]);
  const exportFile = useCallback((name, content, type) => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([content], { type }));
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }, []);

  const toggleMenu = useCallback((event) => {
    event.stopPropagation();
    setMenu((open) => !open);
  }, []);

  const exportJson = useCallback(() => {
    exportFile("diagram.json", JSON.stringify(diagramFromDoc(ydocRef.current), null, 2), "application/json");
  }, [exportFile]);

  return <div className="app" onClick={() => { if (menu) setMenu(false); if (contextMenu) closeContextMenu(); }}>
    <main>
      <AppHeader
        menu={menu}
        onToggleMenu={toggleMenu}
        onExport={exportJson}
        canUndo={Boolean(undoManagerRef.current?.undoStack.length)}
        canRedo={Boolean(undoManagerRef.current?.redoStack.length)}
        onUndo={undo}
        onRedo={redo}
      />
      <div className="canvas">
        <div className="canvas-title">工艺流程及产污节点图 <span>React Flow</span></div>
        <div className="graph">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            nodeOrigin={[0.5, 0.5]}
            onEdgesChange={onEdgesChange}
            onEdgesDelete={onEdgesDelete}
            onConnect={onConnect}
            onReconnect={onReconnect}
            isValidConnection={isValidConnection}
            onSelectionChange={onSelectionChange}
            onInit={onInit}
            onNodeClick={(_event, node) => select({ kind: "node", id: node.id })}
            onEdgeClick={(_event, edge) => select({ kind: "edge", id: edge.id })}
            onPaneClick={() => select(null)}
            onNodeContextMenu={(event, node) => openContextMenu(event, { kind: "node", id: node.id })}
            onEdgeContextMenu={(event, edge) => openContextMenu(event, { kind: "edge", id: edge.id })}
            onPaneContextMenu={onPaneContextMenu}
            fitView
            fitViewOptions={fitViewOptions}
            snapToGrid
            snapGrid={snapGrid}
            selectionOnDrag
            selectionMode="partial"
            panOnDrag={[1, 2]}
            deleteKeyCode={["Backspace", "Delete"]}
            edgesReconnectable
            minZoom={0.2}
            maxZoom={2}
            defaultEdgeOptions={defaultEdgeOptions}
          >
            <ViewportPortal>
              <svg className="alignment-guides" aria-hidden="true">
                {alignmentGuides.map((guide) => guide.axis === "x"
                  ? <line key={`x-${guide.value}`} x1={guide.value} x2={guide.value} y1={-10000} y2={10000} />
                  : <line key={`y-${guide.value}`} x1={-10000} x2={10000} y1={guide.value} y2={guide.value} />)}
              </svg>
            </ViewportPortal>
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#d8d8d8" />
            <MiniMap pannable zoomable nodeColor="#fff" nodeStrokeColor="#555" maskColor="rgba(240,240,240,.72)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
    </main>
    <ContextMenu contextMenu={contextMenu} onClose={closeContextMenu} onAction={onContextAction} />
    <aside>
      <div className="inspector-title"><span>属性</span><small>{status}</small></div>
      {selectedNodeIds.length > 1 ? <section>
        <div className="object-line"><b>多个节点</b><code>{selectedNodeIds.length} 个</code></div>
        <label>文字<input placeholder="混合值" value={nodeFieldValue("label") ?? ""} onChange={(event) => updateManyNodes("label", event.target.value)} /></label>
        <label>类型<input placeholder="混合值" value={nodeFieldValue("type") ?? ""} onChange={(event) => updateManyNodes("type", event.target.value)} /></label>
        <label>宽度<input type="number" min="80" value={nodeFieldValue("width") ?? ""} placeholder="混合值" onChange={(event) => updateManyNodes("width", Number(event.target.value))} /></label>
        <label>高度<input type="number" min="28" value={nodeFieldValue("height") ?? ""} placeholder="混合值" onChange={(event) => updateManyNodes("height", Number(event.target.value))} /></label>
        <label>字号<input type="number" min="8" max="72" value={nodeFieldValue("fontSize") ?? ""} placeholder="混合值" onChange={(event) => updateManyNodes("fontSize", Number(event.target.value))} /></label>
        <label>字重<select value={nodeFieldValue("fontWeight") ?? "mixed"} onChange={(event) => event.target.value !== "mixed" && updateManyNodes("fontWeight", Number(event.target.value))}>
          <option value="mixed">混合值</option><option value="400">常规</option><option value="600">半粗</option><option value="700">粗体</option>
        </select></label>
        <div className="property-actions"><button onClick={() => alignNodes("left")}><Icon name="route" />左对齐</button><button onClick={() => alignNodes("center-x")}><Icon name="route" />水平居中</button><button onClick={() => alignNodes("right")}><Icon name="route" />右对齐</button><button onClick={() => alignNodes("top")}><Icon name="route" />顶端对齐</button><button onClick={() => alignNodes("center-y")}><Icon name="route" />垂直居中</button><button onClick={() => alignNodes("bottom")}><Icon name="route" />底端对齐</button><button disabled={selectedNodeIds.length < 3} onClick={() => distributeNodes("x")}><Icon name="route" />水平分布</button><button disabled={selectedNodeIds.length < 3} onClick={() => distributeNodes("y")}><Icon name="route" />垂直分布</button></div>
        <div className="property-actions"><button onClick={groupSelected}><Icon name="group" />编组</button><button onClick={ungroupSelected}><Icon name="group" />取消编组</button><button onClick={deleteSelected}><Icon name="trash" />删除选中</button></div>
      </section> : selectedValue ? <section>
        <div className="object-line"><b>{selected.kind === "edge" ? "连线" : "节点"}</b><code>{selected.id}</code></div>
        <label>文字<input value={draftValues.label ?? selectedValue.label ?? ""} onChange={(event) => updateSelected("label", event.target.value)} /></label>
        {selected.kind === "node" ? <>
          <label>类型<input value={draftValues.type ?? selectedValue.type ?? ""} onChange={(event) => updateSelected("type", event.target.value)} /></label>
          <label>宽度<input type="number" min="80" value={draftValues.width ?? selectedValue.width ?? ""} onChange={(event) => updateSelected("width", Number(event.target.value))} /></label>
          <label>高度<input type="number" min="28" value={draftValues.height ?? selectedValue.height ?? ""} onChange={(event) => updateSelected("height", Number(event.target.value))} /></label>
          <label>字号<input type="number" min="8" max="72" value={draftValues.fontSize ?? selectedValue.fontSize ?? ""} onChange={(event) => updateSelected("fontSize", Number(event.target.value))} /></label>
          <label>字重<select value={draftValues.fontWeight ?? selectedValue.fontWeight ?? 400} onChange={(event) => updateSelected("fontWeight", Number(event.target.value))}><option value="400">常规</option><option value="600">半粗</option><option value="700">粗体</option></select></label>
        </> : <>
          <label>流类型<select value={draftValues.kind ?? selectedValue.kind ?? "material"} onChange={(event) => updateSelected("kind", event.target.value)}>
            {edgeKindOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>路由方式<select value={draftValues.route ?? selectedValue.route ?? "smoothstep"} onChange={(event) => updateSelected("route", event.target.value)}>
            {edgeRouteOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>线型<select value={draftValues.lineStyle ?? selectedValue.lineStyle ?? "solid"} onChange={(event) => updateSelected("lineStyle", event.target.value)}>
            <option value="solid">实线</option>
            <option value="dashed">虚线</option>
          </select></label>
          <label>颜色<span className="color-field"><input type="color" value={draftValues.stroke ?? selectedValue.stroke ?? "#222222"} onChange={(event) => updateSelected("stroke", event.target.value)} /><code>{selectedValue.stroke ?? "#222222"}</code></span></label>
          <label>粗细<input type="number" min="0.5" max="8" step="0.1" value={draftValues.strokeWidth ?? selectedValue.strokeWidth ?? 1.4} onChange={(event) => updateSelected("strokeWidth", Number(event.target.value))} /></label>
          <label>箭头<select value={draftValues.arrow ?? selectedValue.arrow ?? "closed"} onChange={(event) => updateSelected("arrow", event.target.value)}>
            <option value="closed">实心箭头</option>
            <option value="open">空心箭头</option>
            <option value="none">无箭头</option>
          </select></label>
          <div className="property-actions"><button onClick={enableWaypointEditing}><Icon name="route" />{selectedValue.waypoints?.length ? "继续编辑拐点" : "转为可编辑路径"}</button></div>
        </>}
      </section> : <div className="empty">选择节点或连线</div>}
    </aside>
  </div>;
}

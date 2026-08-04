import type { IDecoration, IDecorationOptions, IMarker, Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import {
  createCommandDecorationManager,
  MAX_PENDING_COMMANDS,
  MAX_TRACKED_DECORATIONS,
  parseOsc633Data,
} from "../src/renderer/src/components/panel/terminal/terminal-command-decorations.ts";

describe("parseOsc633Data", () => {
  it('"1" 识别为 prompt 开始', () => {
    expect(parseOsc633Data("1")).toEqual({ kind: "prompt" });
  });

  it('"2" 识别为命令开始', () => {
    expect(parseOsc633Data("2")).toEqual({ kind: "command" });
  });

  it('"A;0" 识别为退出码 0', () => {
    expect(parseOsc633Data("A;0")).toEqual({ kind: "exit", exitCode: 0 });
  });

  it('"A;255" 识别为退出码 255', () => {
    expect(parseOsc633Data("A;255")).toEqual({ kind: "exit", exitCode: 255 });
  });

  it("乱数据返回 null", () => {
    for (const data of ["", "3", "A", "A;", "A;abc", "A;1.5", "A;0;1", "B;0", "a;0", "12"]) {
      expect(parseOsc633Data(data)).toBeNull();
    }
  });
});

describe("createCommandDecorationManager", () => {
  it('注入 "2" 后 "A;0" 产生 success 装饰', () => {
    const harness = createTerminalHarness();
    const manager = createCommandDecorationManager(harness.terminal);

    expect(harness.emit("2")).toBe(true);
    expect(harness.emit("A;0")).toBe(true);
    expect(harness.decorationStubs).toHaveLength(1);
    const element = harness.decorationStubs[0].render();
    expect(element.classList.contains("terminal-command-decoration")).toBe(true);
    expect(element.dataset.exit).toBe("success");
    expect(element.classList.contains("xterm-decoration")).toBe(false);

    manager.dispose();
  });

  it('注入 "2" 后 "A;1" 产生 error 装饰', () => {
    const harness = createTerminalHarness();
    const manager = createCommandDecorationManager(harness.terminal);

    harness.emit("2");
    harness.emit("A;1");
    expect(harness.decorationStubs).toHaveLength(1);
    const element = harness.decorationStubs[0].render();
    expect(element.classList.contains("terminal-command-decoration")).toBe(true);
    expect(element.dataset.exit).toBe("error");

    manager.dispose();
  });

  it("装饰选项使用左缘 2 格宽、top 层的锚定配置", () => {
    const harness = createTerminalHarness();
    const manager = createCommandDecorationManager(harness.terminal);

    harness.emit("2");
    harness.emit("A;0");
    expect(harness.decorationOptions[0]).toEqual(
      expect.objectContaining({ x: 0, width: 2, anchor: "left", layer: "top" }),
    );

    manager.dispose();
  });

  it("元素已渲染时直接应用类名（onRender 路径同样生效）", () => {
    const harness = createTerminalHarness({ preRenderedElements: true });
    const manager = createCommandDecorationManager(harness.terminal);

    harness.emit("2");
    harness.emit("A;0");
    expect(harness.decorationStubs).toHaveLength(1);
    expect(harness.decorationStubs[0].decoration.element).toBeDefined();
    const element = harness.decorationStubs[0].decoration.element as unknown as FakeElement;
    expect(element.classList.contains("terminal-command-decoration")).toBe(true);
    expect(element.dataset.exit).toBe("success");

    manager.dispose();
  });

  it("无 pending 命令时的 exit 直接忽略", () => {
    const harness = createTerminalHarness();
    const manager = createCommandDecorationManager(harness.terminal);

    expect(harness.emit("A;0")).toBe(true);
    expect(harness.decorationStubs).toHaveLength(0);

    // 一条命令只装饰一次：第二个 exit 不产生新装饰。
    harness.emit("2");
    harness.emit("A;0");
    harness.emit("A;127");
    expect(harness.decorationStubs).toHaveLength(1);

    manager.dispose();
  });

  it("marker 已 dispose（buffer 滚动）时跳过装饰", () => {
    const harness = createTerminalHarness();
    const manager = createCommandDecorationManager(harness.terminal);

    harness.emit("2");
    harness.disposeLastMarker();
    harness.emit("A;0");
    expect(harness.registerDecorationCalls).toBe(0);
    expect(harness.decorationStubs).toHaveLength(0);

    manager.dispose();
  });

  it("registerDecoration 返回 undefined（alt buffer 等）时容错", () => {
    const harness = createTerminalHarness({ registerDecorationUndefined: true });
    const manager = createCommandDecorationManager(harness.terminal);

    expect(() => {
      harness.emit("2");
      harness.emit("A;0");
    }).not.toThrow();
    expect(harness.registerDecorationCalls).toBe(1);
    expect(harness.decorationStubs).toHaveLength(0);

    manager.dispose();
  });

  it("prompt 序列清空残留 pending（边界防御）", () => {
    const harness = createTerminalHarness();
    const manager = createCommandDecorationManager(harness.terminal);

    harness.emit("2");
    harness.emit("1");
    harness.emit("A;0");
    expect(harness.decorationStubs).toHaveLength(0);
    expect(harness.markers).toHaveLength(1);

    manager.dispose();
  });

  it("pending 超过上限时丢弃最旧 marker，其命令不再装饰", () => {
    const harness = createTerminalHarness();
    const manager = createCommandDecorationManager(harness.terminal);

    for (let index = 0; index < MAX_PENDING_COMMANDS + 1; index += 1) harness.emit("2");
    expect(harness.markers).toHaveLength(MAX_PENDING_COMMANDS + 1);
    for (let index = 0; index < MAX_PENDING_COMMANDS + 1; index += 1) harness.emit("A;0");
    // 最旧的 1 条命令被丢弃，只有 MAX_PENDING_COMMANDS 条获得装饰。
    expect(harness.registerDecorationCalls).toBe(MAX_PENDING_COMMANDS);
    expect(harness.decorationStubs).toHaveLength(MAX_PENDING_COMMANDS);

    manager.dispose();
  });

  it("装饰数量超过上限时丢弃最旧装饰并释放", () => {
    const harness = createTerminalHarness();
    const manager = createCommandDecorationManager(harness.terminal);

    for (let index = 0; index < MAX_TRACKED_DECORATIONS + 5; index += 1) {
      harness.emit("2");
      harness.emit("A;0");
    }
    expect(harness.decorationStubs).toHaveLength(MAX_TRACKED_DECORATIONS + 5);
    for (let index = 0; index < 5; index += 1) {
      expect(harness.decorationStubs[index].disposed).toBe(true);
    }
    expect(harness.decorationStubs[5].disposed).toBe(false);

    manager.dispose();
  });

  it("dispose 注销 OSC handler、清空 pending 并释放装饰；重复调用安全", () => {
    const harness = createTerminalHarness();
    const manager = createCommandDecorationManager(harness.terminal);

    harness.emit("2");
    harness.emit("A;0");
    harness.emit("2");
    const decorations = [...harness.decorationStubs];

    manager.dispose();
    manager.dispose();

    expect(harness.oscHandlerActive).toBe(false);
    for (const stub of decorations) expect(stub.disposed).toBe(true);

    // handler 注销后注入序列不再生效。
    const markerCount = harness.markers.length;
    harness.emit("2");
    harness.emit("A;0");
    expect(harness.markers).toHaveLength(markerCount);
    expect(harness.decorationStubs).toHaveLength(decorations.length);
  });
});

/** 无 DOM 环境的假元素：只记录 classList 与 dataset 供断言。 */
interface FakeElement {
  classList: { contains(name: string): boolean; add(name: string): void };
  dataset: Record<string, string>;
}

function createFakeElement(): FakeElement {
  const classes = new Set<string>();
  return {
    classList: {
      contains(name) {
        return classes.has(name);
      },
      add(name) {
        classes.add(name);
      },
    },
    dataset: {},
  };
}

/** 假装饰：element 初始为 undefined（与真实 xterm 首次渲染前一致），render() 触发 onRender。 */
interface StubDecoration {
  readonly decoration: IDecoration;
  readonly disposed: boolean;
  /** 模拟 xterm 首次渲染：创建元素、挂到 decoration 并触发 onRender 监听器。 */
  render(): FakeElement;
}

function createStubDecoration(marker: IMarker, preRendered: boolean): StubDecoration {
  const listeners: Array<(element: HTMLElement) => void> = [];
  let disposed = false;
  let element: HTMLElement | undefined;
  const decoration: IDecoration = {
    marker,
    element,
    isDisposed: false,
    options: {},
    onDispose: () => ({ dispose() {} }),
    onRender: (listener) => {
      listeners.push(listener);
      return {
        dispose: () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      };
    },
    dispose: () => {
      disposed = true;
      decoration.isDisposed = true;
    },
  };
  if (preRendered) {
    decoration.element = createFakeElement() as unknown as HTMLElement;
  }
  return {
    decoration,
    get disposed() {
      return disposed;
    },
    render(): FakeElement {
      const created = createFakeElement();
      decoration.element = created as unknown as HTMLElement;
      for (const listener of [...listeners]) listener(created as unknown as HTMLElement);
      listeners.length = 0;
      return created;
    },
  };
}

/** 手写 Terminal stub：捕获 OSC 633 handler 并记录 marker/装饰创建。 */
interface TerminalHarness {
  terminal: Terminal;
  /** 向 OSC handler 注入一条 633 payload。 */
  emit(data: string): boolean;
  readonly markers: IMarker[];
  readonly decorationStubs: StubDecoration[];
  readonly decorationOptions: IDecorationOptions[];
  readonly registerDecorationCalls: number;
  readonly oscHandlerActive: boolean;
  /** 把最后创建的 marker 标记为已 dispose（模拟 marker 随 buffer 滚动失效）。 */
  disposeLastMarker(): void;
}

function createTerminalHarness(
  options: { preRenderedElements?: boolean; registerDecorationUndefined?: boolean } = {},
): TerminalHarness {
  const markers: IMarker[] = [];
  const decorationStubs: StubDecoration[] = [];
  const decorationOptions: IDecorationOptions[] = [];
  let oscHandler: ((data: string) => boolean) | null = null;
  let nextMarkerId = 1;
  let registerDecorationCalls = 0;

  const terminal = {
    parser: {
      registerOscHandler(_ident: number, callback: (data: string) => boolean) {
        oscHandler = callback;
        return {
          dispose: () => {
            oscHandler = null;
          },
        };
      },
    },
    registerMarker(_offset = 0): IMarker {
      const marker: IMarker = {
        id: nextMarkerId,
        line: 0,
        isDisposed: false,
        onDispose: () => ({ dispose() {} }),
        dispose: () => {
          marker.isDisposed = true;
        },
      };
      nextMarkerId += 1;
      markers.push(marker);
      return marker;
    },
    registerDecoration(decorationOptionsValue: IDecorationOptions): IDecoration | undefined {
      registerDecorationCalls += 1;
      if (decorationOptionsValue.marker.isDisposed) return undefined;
      if (options.registerDecorationUndefined) return undefined;
      decorationOptions.push(decorationOptionsValue);
      const stub = createStubDecoration(decorationOptionsValue.marker, options.preRenderedElements ?? false);
      decorationStubs.push(stub);
      return stub.decoration;
    },
  } as unknown as Terminal;

  return {
    terminal,
    emit(data) {
      return oscHandler?.(data) ?? false;
    },
    get markers() {
      return markers;
    },
    get decorationStubs() {
      return decorationStubs;
    },
    get decorationOptions() {
      return decorationOptions;
    },
    get registerDecorationCalls() {
      return registerDecorationCalls;
    },
    get oscHandlerActive() {
      return oscHandler !== null;
    },
    disposeLastMarker() {
      markers[markers.length - 1]?.dispose();
    },
  };
}

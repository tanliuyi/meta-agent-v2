import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveTrayIconPath, TrayController } from "../src/main/tray.ts";

const electron = vi.hoisted(() => {
  const instances: FakeTray[] = [];
  class FakeTray {
    tooltip = "";
    menu: unknown;
    destroyed = false;
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor() {
      instances.push(this);
    }

    setToolTip(tooltip: string): void {
      this.tooltip = tooltip;
    }

    setContextMenu(menu: unknown): void {
      this.menu = menu;
    }

    destroy(): void {
      this.destroyed = true;
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) listener();
    }
  }
  return {
    instances,
    TrayClass: FakeTray,
    buildFromTemplate: vi.fn((template: unknown[]) => template),
    emptyImage: { isEmpty: () => true },
    validImage: { isEmpty: () => false },
  };
});

vi.mock("electron", () => ({
  Tray: electron.TrayClass,
  Menu: { buildFromTemplate: electron.buildFromTemplate },
  nativeImage: {
    createFromPath: (path: string) => (path.includes("missing") ? electron.emptyImage : electron.validImage),
  },
}));

class FakeWindow extends EventEmitter {
  hidden = 0;
  shown = 0;
  restored = 0;
  minimized = false;
  destroyed = false;

  hide(): void {
    this.hidden += 1;
  }

  show(): void {
    this.shown += 1;
  }

  restore(): void {
    this.restored += 1;
  }

  focus(): void {}

  isMinimized(): boolean {
    return this.minimized;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

interface CloseEvent {
  prevented: boolean;
  preventDefault(): void;
}

function emitClose(window: FakeWindow): CloseEvent {
  const event: CloseEvent = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  window.emit("close", event);
  return event;
}

function controllerFor(
  platform: NodeJS.Platform,
  overrides: Partial<ConstructorParameters<typeof TrayController>[0]> = {},
) {
  return new TrayController({
    platform,
    isPackaged: false,
    appDir: "G:/meta-agent-v2/packages/desktop/out/main",
    resourcesPath: "C:/Program Files/Meta Agent/resources",
    quit: vi.fn(),
    ...overrides,
  });
}

describe("resolveTrayIconPath", () => {
  test("win32 开发版读取仓库 build/icon.ico", () => {
    const path = resolveTrayIconPath({
      platform: "win32",
      isPackaged: false,
      appDir: "G:/meta-agent-v2/packages/desktop/out/main",
      resourcesPath: "C:/Program Files/Meta Agent/resources",
    });
    expect(path).toBe("G:/meta-agent-v2/packages/desktop/build/icon.ico".replaceAll("/", "\\"));
  });

  test("win32 发布版读取 resources/tray-icon.ico", () => {
    const path = resolveTrayIconPath({
      platform: "win32",
      isPackaged: true,
      appDir: "G:/meta-agent-v2/packages/desktop/out/main",
      resourcesPath: "C:/Program Files/Meta Agent/resources",
    });
    expect(path).toBe("C:/Program Files/Meta Agent/resources/tray-icon.ico".replaceAll("/", "\\"));
  });

  test("非 Windows 平台返回 undefined", () => {
    const path = resolveTrayIconPath({
      platform: "darwin",
      isPackaged: false,
      appDir: "G:/meta-agent-v2/packages/desktop/out/main",
      resourcesPath: "C:/Program Files/Meta Agent/resources",
    });
    expect(path).toBeUndefined();
  });
});

describe("TrayController", () => {
  beforeEach(() => {
    electron.instances.length = 0;
    electron.buildFromTemplate.mockClear();
  });

  test("非 Windows 平台 attach 返回 false 且不拦截关闭", () => {
    const controller = controllerFor("darwin");
    const window = new FakeWindow();
    expect(controller.attach(window as never)).toBe(false);
    const event = emitClose(window);
    expect(event.prevented).toBe(false);
  });

  test("win32 attach 成功：关闭事件被拦截并隐藏窗口", () => {
    const controller = controllerFor("win32");
    const window = new FakeWindow();
    expect(controller.attach(window as never)).toBe(true);
    const event = emitClose(window);
    expect(event.prevented).toBe(true);
    expect(window.hidden).toBe(1);
    expect(window.destroyed).toBe(false);
  });

  test("托盘图标加载失败时 attach 返回 false 且不拦截关闭", () => {
    const controller = controllerFor("win32", { isPackaged: true, resourcesPath: "missing-icon" });
    const window = new FakeWindow();
    expect(controller.attach(window as never)).toBe(false);
    const event = emitClose(window);
    expect(event.prevented).toBe(false);
  });

  test("markQuitting 后关闭事件放行", () => {
    const controller = controllerFor("win32");
    const window = new FakeWindow();
    controller.attach(window as never);
    controller.markQuitting();
    const event = emitClose(window);
    expect(event.prevented).toBe(false);
    expect(window.hidden).toBe(0);
  });

  test("重复 attach 只创建一次托盘", () => {
    const controller = controllerFor("win32");
    const window = new FakeWindow();
    controller.attach(window as never);
    controller.attach(window as never);
    expect(electron.instances).toHaveLength(1);
  });

  test("托盘菜单：显示主窗口恢复窗口，退出触发 quit", () => {
    const quit = vi.fn();
    const controller = controllerFor("win32", { quit });
    const window = new FakeWindow();
    controller.attach(window as never);
    const template = electron.buildFromTemplate.mock.calls[0][0] as Array<{
      label?: string;
      click?: () => void;
    }>;
    const show = template.find((item) => item.label === "显示主窗口");
    const exit = template.find((item) => item.label === "退出");
    expect(show).toBeDefined();
    expect(exit).toBeDefined();
    window.minimized = true;
    show?.click?.();
    expect(window.restored).toBe(1);
    expect(window.shown).toBe(1);
    exit?.click?.();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  test("单击托盘图标显示窗口", () => {
    const controller = controllerFor("win32");
    const window = new FakeWindow();
    controller.attach(window as never);
    const tray = electron.instances[0];
    expect(tray).toBeDefined();
    tray.emit("click");
    expect(window.shown).toBe(1);
    expect(tray.tooltip).toBe("Meta Agent");
  });

  test("dispose 销毁托盘且幂等", () => {
    const controller = controllerFor("win32");
    controller.attach(new FakeWindow() as never);
    const tray = electron.instances[0];
    controller.dispose();
    expect(tray.destroyed).toBe(true);
    controller.dispose();
  });
});

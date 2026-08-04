/**
 * WebGL 的 glyph atlas 需要把 CSS 像素换算为设备像素；非整数 DPR 下，canvas 尺寸和
 * atlas 纹理会经过小数缩放，Chromium 可能对小字号边缘做插值。整数 DPR 保留 WebGL，
 * 其余情况使用 xterm 默认 DOM renderer 以优先保证字形清晰度。
 */
export function shouldUseWebglRenderer(devicePixelRatio: number): boolean {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return false;
  return Math.abs(devicePixelRatio - Math.round(devicePixelRatio)) < 0.001;
}

/**
 * WASM 编译能力预检：xterm 图片协议依赖内嵌 wasm 解码器，CSP 未放行
 * `'wasm-unsafe-eval'` 时 `WebAssembly.instantiate` 会在 promise 中失败（
 * try/catch 无法拦截），这里用同步的 `WebAssembly.Module` 编译探测并降级。
 */
export function canCompileWasm(): boolean {
  try {
    new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    return true;
  } catch {
    return false;
  }
}

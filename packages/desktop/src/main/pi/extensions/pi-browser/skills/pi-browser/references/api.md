# pi-browser API

All calls run inside one `plugin_call` program and use the shared Desktop browser session. Arguments are the same structured objects accepted by the original browser tools.

## Navigation

- `browser_open({ url, newTab? })`
- `browser_navigate({ tabId, url })`
- `browser_back({ tabId })`
- `browser_forward({ tabId })`
- `browser_reload({ tabId })`
- `browser_tabs()`
- `browser_close({ tabId })`

## Inspection

- `browser_snapshot({ tabId, withScreenshot? })`
- `browser_content({ tabId })`
- `browser_screenshot({ tabId, fullPage? })`
- `browser_evaluate({ tabId, expression })`
- `browser_console({ tabId, filter?, levels?, limit? })`
- `browser_history({})`（读取当前会话历史，需确认权限）
- `browser_cdp({ tabId, mode?, method?, params?, methods?, limit? })`

Use `browser_snapshot` before clicking or typing. Snapshot element indexes are invalid after page changes; obtain a new snapshot.

## Interaction

- `browser_click({ tabId, elementIndex })`
- `browser_type({ tabId, elementIndex, text, replace?, submit? })`
- `browser_press({ tabId, key })`
- `browser_scroll({ tabId, direction, amount? })`
- `browser_dialog({ tabId, action, text? })`
- `browser_locator({ tabId, by?, selector?, byValue?, frame?, nth?, action, value?, attribute? })`
- `browser_click_at({ tabId, x, y, double?, keys? })`
- `browser_move({ tabId, x, y })`
- `browser_drag({ tabId, points })`

Prefer semantic `browser_locator` or snapshot element indexes over coordinates. Use real user confirmation for destructive or external actions.

## Files and clipboard

- `browser_clipboard({ tabId, action, text? })`
- `browser_upload({ tabId, selector, path })`
- `browser_download({ tabId, url, savePath })`
- `browser_downloads({})`（读取当前活跃标签页的下载记录）

Uploads and downloads access local files. Only perform them when requested or clearly required by the task.

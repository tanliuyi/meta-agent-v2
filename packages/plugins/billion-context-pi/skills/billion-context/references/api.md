# Billion Context API

All methods are called inside one `plugin_call` program through `plugin["pi.billion-context"]`.

## `compress`

```ts
await plugin["pi.billion-context"].compress({
  topic?: string,
  content: Array<{
    startId: string,
    endId: string,
    summary: string,
    topic?: string,
  }>,
  summaryMaxChars?: number,
});
```

## `decompress`

```ts
await plugin["pi.billion-context"].decompress({
  blockId: string,
  full?: boolean,
  toFile?: string,
  inline?: boolean,
});
```

## `search_context`

```ts
await plugin["pi.billion-context"].search_context({
  query: string,
  limit?: number,
});
```

## `acp_status`

```ts
await plugin["pi.billion-context"].acp_status({
  scope?: "compressed" | "uncompressed",
  view?: "ranges" | "messages",
  tool?: string,
  sort?: "size" | "time" | "tool" | "age",
  limit?: number,
});
```

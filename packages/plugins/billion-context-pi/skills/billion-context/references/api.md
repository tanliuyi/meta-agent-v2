# Billion Context API

All methods are native Pi tools and are called directly by name.

## `compress`

```ts
await compress({
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
await decompress({
  blockId: string,
  full?: boolean,
  toFile?: string,
  inline?: boolean,
});
```

## `search_context`

```ts
await search_context({
  query: string,
  limit?: number,
});
```

## `acp_status`

```ts
await acp_status({
  scope?: "compressed" | "uncompressed",
  view?: "ranges" | "messages",
  tool?: string,
  sort?: "size" | "time" | "tool" | "age",
  limit?: number,
});
```

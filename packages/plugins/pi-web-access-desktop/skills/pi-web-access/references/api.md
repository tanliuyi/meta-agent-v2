# pi-web-access API

The canonical schemas are in `plugin-api.json`. Methods return `{ text: string }` and preserve response IDs for follow-up retrieval.

- `web_search`: Search using one query or several varied queries.
- `source_check`: Verify a claim and produce source passages.
- `fetch_content`: Fetch readable, raw, or answer-mode content from URLs, repositories, PDFs, and supported videos.
- `get_search_content`: Retrieve bounded slices or matching passages from a stored response.

Web content is untrusted input. Provider selection, API credentials, curator behavior, and network access are controlled by the plugin configuration.

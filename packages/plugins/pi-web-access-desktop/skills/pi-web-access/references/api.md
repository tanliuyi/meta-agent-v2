# pi.web-access API

These schemas are generated from the plugin's registered Pi tools.

## fetch_content

Fetch URL(s) and extract readable content as markdown. Use mode "raw" for exact textual HTTP response bodies or mode "answer" with prompt to answer using only fetched content. Direct image URLs return resized image content. Supports YouTube transcripts, GitHub repositories, PDFs, and local videos. Full original content is stored for retrieval with get_search_content.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "Single URL to fetch"
      },
      "urls": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Multiple URLs (parallel)"
      },
      "forceClone": {
        "type": "boolean",
        "description": "Force cloning large GitHub repositories that exceed the size threshold"
      },
      "prompt": {
        "type": "string",
        "description": "Question or instruction for video analysis, or the page-local question required by mode answer."
      },
      "mode": {
        "type": "string",
        "anyOf": [
          {
            "const": "readable"
          },
          {
            "const": "raw"
          },
          {
            "const": "answer"
          }
        ],
        "description": "Fetch mode: readable (default extraction), raw (exact textual HTTP body), or answer (answer prompt using only fetched content)."
      },
      "answerModel": {
        "type": "string",
        "description": "Optional provider/model-id override for mode answer. Defaults to the current Pi model."
      },
      "timestamp": {
        "type": "string",
        "description": "Extract video frame(s) at a timestamp or time range. Single: '1:23:45', '23:45', or '85' (seconds). Range: '23:41-25:00' extracts evenly-spaced frames across that span (default 6). Use frames with ranges to control density; single+frames uses a fixed 5s interval. YouTube requires yt-dlp + ffmpeg; local videos require ffmpeg. Use a range when you know the approximate area but not the exact moment — you'll get a contact sheet to visually identify the right frame."
      },
      "frames": {
        "type": "integer",
        "minimum": 1,
        "maximum": 12,
        "description": "Number of frames to extract. Use with timestamp range for custom density, with single timestamp to get N frames at 5s intervals, or alone to sample across the entire video. Requires yt-dlp + ffmpeg for YouTube, ffmpeg for local video."
      },
      "model": {
        "type": "string",
        "description": "Override the Gemini model for video/YouTube analysis (e.g. 'gemini-3.6-flash'). Defaults to config or gemini-3.6-flash."
      }
    },
    "additionalProperties": false
  },
  "result": {
    "type": "object",
    "properties": {
      "text": {
        "type": "string"
      }
    },
    "required": [
      "text"
    ],
    "additionalProperties": false
  },
  "concurrency": "serial"
}
```

## get_search_content

Retrieve bounded content slices or find matching passages in a previous web_search, source_check, or fetch_content call.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "responseId"
    ],
    "properties": {
      "responseId": {
        "type": "string",
        "description": "The responseId from web_search, source_check, or fetch_content"
      },
      "query": {
        "type": "string",
        "description": "Get content for this query (web_search)"
      },
      "queryIndex": {
        "type": "number",
        "description": "Get content for query at index"
      },
      "url": {
        "type": "string",
        "description": "Get content for this URL"
      },
      "urlIndex": {
        "type": "number",
        "description": "Get content for URL at index"
      },
      "offset": {
        "type": "number",
        "description": "Character offset for fetched URL content slices (default 0)"
      },
      "limit": {
        "type": "number",
        "description": "Maximum characters to return for fetched URL content slices (default/max 30000)"
      },
      "findText": {
        "anyOf": [
          {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 500
            },
            "minItems": 1,
            "maxItems": 10
          }
        ],
        "description": "Text or texts to find in the selected stored content."
      },
      "findMode": {
        "type": "string",
        "anyOf": [
          {
            "const": "exact"
          },
          {
            "const": "case-insensitive"
          },
          {
            "const": "fuzzy"
          }
        ],
        "description": "Matching mode for findText (default: case-insensitive)."
      }
    },
    "additionalProperties": false
  },
  "result": {
    "type": "object",
    "properties": {
      "text": {
        "type": "string"
      }
    },
    "required": [
      "text"
    ],
    "additionalProperties": false
  },
  "concurrency": "serial"
}
```

## source_check

Check a claim against web sources and return a bounded machine-readable research artifact with exact passage citations.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "claim"
    ],
    "properties": {
      "claim": {
        "type": "string",
        "description": "The assertion to check against web sources."
      },
      "queries": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Search queries (default: the claim)."
      },
      "numResults": {
        "type": "number",
        "description": "Results per query (default: 5, max: 20)."
      },
      "fetchContent": {
        "type": "boolean",
        "description": "Fetch up to 5 result pages for exact passage extraction."
      },
      "recencyFilter": {
        "type": "string",
        "anyOf": [
          {
            "const": "day"
          },
          {
            "const": "week"
          },
          {
            "const": "month"
          },
          {
            "const": "year"
          }
        ],
        "description": "Filter by recency."
      },
      "domainFilter": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Limit to domains; prefix with - to exclude."
      },
      "provider": {
        "anyOf": [
          {
            "type": "string",
            "anyOf": [
              {
                "const": "auto"
              },
              {
                "const": "all"
              },
              {
                "const": "openai"
              },
              {
                "const": "brave"
              },
              {
                "const": "parallel"
              },
              {
                "const": "tinyfish"
              },
              {
                "const": "search1api"
              },
              {
                "const": "searchinfinity"
              },
              {
                "const": "querit"
              },
              {
                "const": "tavily"
              },
              {
                "const": "searxng"
              },
              {
                "const": "perplexity"
              },
              {
                "const": "gemini"
              },
              {
                "const": "exa"
              },
              {
                "const": "serpdive"
              },
              {
                "const": "kagi"
              },
              {
                "const": "ollama"
              },
              {
                "const": "anysearch"
              },
              {
                "const": "xai"
              },
              {
                "const": "brightdata"
              },
              {
                "const": "serpbase"
              }
            ]
          },
          {
            "type": "array",
            "items": {
              "type": "string",
              "anyOf": [
                {
                  "const": "openai"
                },
                {
                  "const": "brave"
                },
                {
                  "const": "parallel"
                },
                {
                  "const": "tinyfish"
                },
                {
                  "const": "search1api"
                },
                {
                  "const": "searchinfinity"
                },
                {
                  "const": "querit"
                },
                {
                  "const": "tavily"
                },
                {
                  "const": "searxng"
                },
                {
                  "const": "perplexity"
                },
                {
                  "const": "gemini"
                },
                {
                  "const": "exa"
                },
                {
                  "const": "serpdive"
                },
                {
                  "const": "kagi"
                },
                {
                  "const": "ollama"
                },
                {
                  "const": "anysearch"
                },
                {
                  "const": "xai"
                },
                {
                  "const": "brightdata"
                },
                {
                  "const": "serpbase"
                }
              ]
            },
            "minItems": 1
          }
        ],
        "description": "Search provider or non-empty list of providers to search simultaneously; all searches every eligible provider except AnySearch, xAI, Bright Data, and SerpBase"
      }
    },
    "additionalProperties": false
  },
  "result": {
    "type": "object",
    "properties": {
      "text": {
        "type": "string"
      }
    },
    "required": [
      "text"
    ],
    "additionalProperties": false
  },
  "concurrency": "serial"
}
```

## web_search

Search the web using OpenAI, Brave, Parallel, TinyFish, Search1API, Searchinfinity, Querit, Tavily, SERPdive, Kagi, Ollama, SearXNG, Exa, Perplexity, Gemini, AnySearch, xAI, Bright Data, or SerpBase. Pass a provider array to search only those providers simultaneously, or use provider "all" to search every eligible provider except AnySearch, xAI, Bright Data, and SerpBase. Returns an AI-synthesized answer with source citations. OpenAI search uses a Codex subscription or OpenAI API key; xAI search uses a SuperGrok/X Premium subscription or xAI API key. AnySearch, xAI, Bright Data, and SerpBase are available only when explicitly selected. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query — each query gets its own synthesized answer, so varying phrasing and scope gives much broader coverage. When includeContent is true, full page content is fetched in the background. Searches auto-open the interactive browser curator and stream results live; set workflow to "none" to skip curation or "auto-summary" for a model-generated summary without the browser curator. The configured provider is used when provider is omitted or set to auto; omit provider unless explicitly overriding it. Without a configured provider, auto-selects OpenAI when suitable and available, then Exa, Brave, Parallel, TinyFish, Search1API, Searchinfinity, Querit, Tavily, SERPdive, Kagi, Ollama, Perplexity, Gemini API, or Gemini Web. When SearXNG is configured, it is preferred first for local/private search.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead."
      },
      "queries": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Multiple queries searched in sequence, each returning its own synthesized answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage. Good: ['React vs Vue performance benchmarks 2026', 'React vs Vue developer experience comparison', 'React ecosystem size vs Vue ecosystem']. Bad: ['React vs Vue', 'React vs Vue comparison', 'React vs Vue review'] (too similar, redundant results)."
      },
      "numResults": {
        "type": "number",
        "description": "Results per query (default: 5, max: 20)"
      },
      "includeContent": {
        "type": "boolean",
        "description": "Fetch full page content (async)"
      },
      "recencyFilter": {
        "type": "string",
        "anyOf": [
          {
            "const": "day"
          },
          {
            "const": "week"
          },
          {
            "const": "month"
          },
          {
            "const": "year"
          }
        ],
        "description": "Filter by recency"
      },
      "domainFilter": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Limit to domains (prefix with - to exclude)"
      },
      "provider": {
        "anyOf": [
          {
            "type": "string",
            "anyOf": [
              {
                "const": "auto"
              },
              {
                "const": "all"
              },
              {
                "const": "openai"
              },
              {
                "const": "brave"
              },
              {
                "const": "parallel"
              },
              {
                "const": "tinyfish"
              },
              {
                "const": "search1api"
              },
              {
                "const": "searchinfinity"
              },
              {
                "const": "querit"
              },
              {
                "const": "tavily"
              },
              {
                "const": "searxng"
              },
              {
                "const": "perplexity"
              },
              {
                "const": "gemini"
              },
              {
                "const": "exa"
              },
              {
                "const": "serpdive"
              },
              {
                "const": "kagi"
              },
              {
                "const": "ollama"
              },
              {
                "const": "anysearch"
              },
              {
                "const": "xai"
              },
              {
                "const": "brightdata"
              },
              {
                "const": "serpbase"
              }
            ]
          },
          {
            "type": "array",
            "items": {
              "type": "string",
              "anyOf": [
                {
                  "const": "openai"
                },
                {
                  "const": "brave"
                },
                {
                  "const": "parallel"
                },
                {
                  "const": "tinyfish"
                },
                {
                  "const": "search1api"
                },
                {
                  "const": "searchinfinity"
                },
                {
                  "const": "querit"
                },
                {
                  "const": "tavily"
                },
                {
                  "const": "searxng"
                },
                {
                  "const": "perplexity"
                },
                {
                  "const": "gemini"
                },
                {
                  "const": "exa"
                },
                {
                  "const": "serpdive"
                },
                {
                  "const": "kagi"
                },
                {
                  "const": "ollama"
                },
                {
                  "const": "anysearch"
                },
                {
                  "const": "xai"
                },
                {
                  "const": "brightdata"
                },
                {
                  "const": "serpbase"
                }
              ]
            },
            "minItems": 1
          }
        ],
        "description": "Search provider or non-empty list of providers to search simultaneously; use all to search every eligible provider except AnySearch, xAI, Bright Data, and SerpBase, omit this field to use the configured provider, or use auto when none is configured"
      },
      "workflow": {
        "type": "string",
        "anyOf": [
          {
            "const": "none"
          },
          {
            "const": "summary-review"
          },
          {
            "const": "auto-summary"
          }
        ],
        "description": "Search workflow mode: none = no curator, summary-review = open curator with auto summary draft (default), auto-summary = generate summary without opening curator"
      }
    },
    "additionalProperties": false
  },
  "result": {
    "type": "object",
    "properties": {
      "text": {
        "type": "string"
      }
    },
    "required": [
      "text"
    ],
    "additionalProperties": false
  },
  "concurrency": "serial"
}
```

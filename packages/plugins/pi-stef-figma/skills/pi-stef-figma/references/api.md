# pi-stef.figma API

These schemas are generated from the plugin's registered Pi tools.

## figma_auth_status

Check Figma token configuration without printing token values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "fileKey": {
        "type": "string",
        "description": "Optional file key to verify access with a minimal request."
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

## figma_context

Fetch screen-level design context or overview multi-screen Figma flows without MCP.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "url"
    ],
    "properties": {
      "url": {
        "type": "string",
        "description": "Figma browser URL containing a node-id query parameter."
      },
      "mode": {
        "type": "string",
        "anyOf": [
          {
            "const": "screen"
          },
          {
            "const": "overview"
          }
        ],
        "description": "Use screen for a focused frame. Use overview for a page, canvas, worksheet, or multi-screen flow."
      },
      "format": {
        "type": "string",
        "anyOf": [
          {
            "const": "json"
          },
          {
            "const": "markdown"
          }
        ],
        "description": "Output format. Use markdown for compact summaries."
      },
      "includeRaw": {
        "type": "boolean",
        "description": "Include raw Figma node payload."
      },
      "includeHidden": {
        "type": "boolean",
        "description": "Include hidden nodes."
      },
      "includeStyles": {
        "type": "boolean",
        "description": "Include style metadata in parsed nodes."
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0,
        "description": "Max depth to traverse when parsing the node tree."
      },
      "maxScreens": {
        "type": "integer",
        "minimum": 0,
        "description": "Max screens to include in overview mode."
      },
      "maxTextPerScreen": {
        "type": "integer",
        "minimum": 0,
        "description": "Max key text snippets per screen in overview mode."
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

## figma_extract_assets

Return image-fill and renderable asset manifest without writing by default.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
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

## figma_extract_text

Extract visible text nodes from a file or focused node.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
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

## figma_find_nodes_by_name

Find nodes by layer/name text.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input",
      "query"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
      },
      "query": {
        "type": "string",
        "description": "Name or text query."
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

## figma_find_nodes_by_text

Find visible text nodes by text content.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input",
      "query"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
      },
      "query": {
        "type": "string",
        "description": "Name or text query."
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

## figma_get_comments

Fetch compact comments data from the Figma REST API.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
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

## figma_get_component_sets

Fetch compact componentSets data from the Figma REST API.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
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

## figma_get_components

Fetch compact components data from the Figma REST API.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
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

## figma_get_design_context

Return compact file/page/frame context for design understanding.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
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

## figma_get_file_raw

Debugging escape hatch for capped raw file JSON.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
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

## figma_get_image_fills

Return expiring image-fill URLs from Figma. Results are not cached.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
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

## figma_get_implementation_context

Return coding-ready layout, text, typography, and asset hints.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
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

## figma_get_node_summary

Return compact structured summary for a focused node.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
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

## figma_get_nodes_raw

Debugging escape hatch for capped raw node JSON.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
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

## figma_get_styles

Fetch compact styles data from the Figma REST API.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
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

## figma_get_variables

Fetch compact variables data from the Figma REST API.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
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

## figma_parse_url

Parse Figma URLs, bare file keys, and node IDs without calling Figma.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
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

## figma_render_nodes

Return expiring Figma image render URLs for nodes. When outputDir is provided, downloads files under the current working directory with safe-path checks and private file permissions.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
      },
      "format": {
        "type": "string",
        "anyOf": [
          {
            "const": "jpg"
          },
          {
            "const": "png"
          },
          {
            "const": "svg"
          },
          {
            "const": "pdf"
          }
        ]
      },
      "nodeIds": {
        "type": "array",
        "items": {
          "type": "string",
          "description": "Optional node IDs in 1:2 or 1-2 format."
        }
      },
      "scale": {
        "type": "number",
        "minimum": 0.01,
        "maximum": 4
      },
      "outputDir": {
        "type": "string",
        "description": "Optional safe output directory under the current working directory."
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

## figma_search_components

Search compact component metadata by component name.

```json
{
  "parameters": {
    "type": "object",
    "required": [
      "input",
      "query"
    ],
    "properties": {
      "input": {
        "type": "string",
        "description": "Figma URL or bare file key."
      },
      "nodeId": {
        "type": "string",
        "description": "Optional node ID in 1:2 or 1-2 format."
      },
      "depth": {
        "type": "integer",
        "minimum": 0
      },
      "maxDepth": {
        "type": "integer",
        "minimum": 0
      },
      "includeHidden": {
        "type": "boolean"
      },
      "maxResponseChars": {
        "type": "integer",
        "minimum": 1000
      },
      "query": {
        "type": "string",
        "description": "Name or text query."
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

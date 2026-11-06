# v0.6.16

- The request widget defaults to a 340 DIP outer width. Its 2×12 heatmap now uses square cells sized from the narrower content width. TPS, cache, and duration columns are tighter while the provider column stays unchanged.
- Native Gaussian material coverage is restricted to completed hour columns. Future heat cells remain visible but sharp, reducing shader samples and making the heatmap's blurred footprint match elapsed time.
- Dragging no longer writes or repairs preferences for every Electron move event. Position is persisted once after the native drag completes, removing a repeated main-process event/timer path while requests are active.
- The glass capacity width is reduced from 640 to 480 DIP, and the request/heatmap material masks are aligned to the compact layout.
- Codex model catalogs keep the full 100% effective context window and trigger auto-compaction separately at the configured 90% token threshold.
- The OpenAI API quota UI links to the official Usage and Billing pages instead of probing unsupported automatic balance endpoints with a normal model key.

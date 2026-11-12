# Provider marks

These files are faithful copies of the provider assets already shipped by BotFleet under `/Users/jay/Code/BotFleet/ios/App/Assets.xcassets/ProviderMark*.imageset/`.  They are bundled for local display only and remain subject to their source project licenses.

`gemini.png` is a Quick Look rasterization of the retained BotFleet `gemini.svg`, used because AppKit's direct SVG decoder renders that gradient mark incorrectly at menu bar size.

`cursor.png` is the existing BotFleet raster asset because that source tree does not provide a Cursor SVG.  Antigravity uses the existing Gemini mark, and Grok CLI/Grok Bot use the existing Grok mark; no new artwork was created.

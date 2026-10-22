# Brand icons (web)

Source: iOS **Usage Monitor Client** AppIcon  
`ios/UsageMonitor/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`

| File | Use |
|------|-----|
| `icon-1024.png` | Master |
| `icon-512.png` / `icon-192.png` | PWA (`/pwa-icon/*` route + manifest) |
| `icon-64.png` | Nav + login mark |

App Router also serves `src/app/icon.png` (favicon) and `src/app/apple-icon.png`
(Apple touch) resized from the same master.

Refresh:

```bash
SRC=ios/UsageMonitor/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png
cp "$SRC" public/brand/icon-1024.png
sips -z 64 64   "$SRC" --out public/brand/icon-64.png
sips -z 192 192 "$SRC" --out public/brand/icon-192.png
sips -z 512 512 "$SRC" --out public/brand/icon-512.png
sips -z 32 32   "$SRC" --out src/app/icon.png
sips -z 180 180 "$SRC" --out src/app/apple-icon.png
```

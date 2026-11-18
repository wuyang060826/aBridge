# Windows PC client

Windows x64 client with a WPF tray application and a strict TypeScript runtime. It connects directly to the existing aBridge Server and provides screen, input, shell, and files capabilities. It does not replace the Swift macOS client.

## Build

```powershell
npm install --ignore-scripts --no-audit --no-fund
npm run build
npm run package:windows
npm run desktop:windows
```

Packaging requires .NET SDK 10.0.404 (PATH or `.local/dotnet/`) and verifies the pinned portable Node 24.22.3 archive. The output is `dist/releases/aBridge-<version>-windows-x64-unsigned.zip`; version comes from the root manifest. The package includes Node and self-contained .NET, but no credentials, desktop SDK or private deployment configuration. The portable package is unsigned and does not implement automatic updates.

## Connect and use

Enter the existing Server URL, then complete browser authorization or enter a Device Token. Enable only the required local capabilities. The runtime preserves the existing server binding, private credentials and pause state on reconnect. Stop and pause remain local controls; unknown operations are never replayed.

An unlocked interactive Windows desktop is required. UIA references and screenshot coordinates are checked against current window identity, focus, geometry, occlusion and human input. Elevated windows, secure desktop and the client's own controls are excluded. Unsupported background input is rejected; request foreground clicks for Windows. Platform-specific coordinate normalization and scroll locations remain client-side contracts; callers must use arguments supported by their Server's tool schema.

## Validation

```powershell
npm run check
node --import tsx --test --test-concurrency=4 apps/windows/tests/*.test.ts
```

Tests use synthetic identities and local fixtures. Actual system input is opt-in via `ABRIDGE_WINDOWS_LIVE=1` and requires the dedicated test window. Unit tests do not establish multi-monitor, UAC or end-to-end Yuxi acceptance. No real accounts or remote services are required by CI.

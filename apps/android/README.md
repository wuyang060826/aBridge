# aBridge for Android

Android 13 and newer. The app registers as an independent computer device and connects directly to the server. Use a computer Device Key whose grant includes the capabilities you intend to enable.

```sh
npm run build
apps/android/gradlew -p apps/android assembleDebug
```

The Android build requires JDK 17 and Android SDK Platform 36. Gradle consumes the device contract generated from the shared protocol by `npm run build`. The debug APK is under `apps/android/build/outputs/apk/debug/`.

Open the app, enter the HTTPS server address and Device Key, and enable the aBridge accessibility service in Android Settings. Enable the desired capabilities, choose a directory for file access, and resume the connection from the app. Pause and capability switches take effect locally before server state updates. Debug builds also permit loopback HTTP for the emulator.

| Capability | Supported requests                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen     | `computer_observe` with `desktop=true`. Returns a bounded accessibility tree and optional JPEG. Images and coordinates use the current display orientation.                                                                     |
| Input      | `computer_act` with a current observation. Primary click, long press, drag, scroll, text replacement, and supported Android system and editor keys. Click and long press accept an element reference or screenshot coordinates. |
| Files      | `files_list`, `file_read`, and `file_write` under `/workspace`, which maps to the directory selected in Android's system picker. Reads and writes use UTF-8 and a one MiB limit.                                                |

Observations expire after 120 seconds and are invalidated after input and on window changes. Input requires a verified current foreground window. Physical pointer movement, right-click, modifier combinations, and desktop window selection return an unsupported response. Protected windows can refuse capture. Directory providers control filename and write behavior. The app retains accepted operation IDs across restarts and refuses additional work if its bounded journal is full.

See the [public benchmark procedure](../../docs/benchmarks/android-world.md) for emulator setup and result interpretation.

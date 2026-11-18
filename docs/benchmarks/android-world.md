# AndroidWorld public subset

This benchmark runs the 15 task/seed pairs in [suite.json](../../tools/android-world/suite.json) on a dedicated Pixel 6 emulator with Android 13 (API 33). The controller uses the pinned public AndroidWorld task registry, parameter generators, setup, teardown, and success checks. It opens each task's declared app before handing control to the agent. The emulator clock remains synchronized with the host because aBridge dispatches have real-time deadlines.

The agent sees the public goal and a single aBridge session. Its gateway allows only `computer_observe` and `computer_act`. The controller alone uses AndroidWorld and ADB for provisioning, initialization, and grading. This suite measures end-to-end screen and input operations, including file management through the Android Files app. Direct aBridge file API access has separate authorization and is outside this suite's scoring scope.

Use a disposable AVD named `AndroidWorldAvd` with a Pixel 6 profile and the API 33 Google APIs ARM64 image. Launch with `-port 5562 -no-snapshot -grpc 8554` and install the aBridge debug APK. Keep the emulator and its gRPC port on a trusted test host.

Check out the [pinned upstream source](https://github.com/google-research/android_world/tree/55ddaf5edc6f6c25673aed343907d5b9dca66f84). Follow its Python 3.11 dependency and Protobuf generation steps. Run the controller from the aBridge repository root with the upstream checkout on `PYTHONPATH`.

```sh
python tools/android-world/run.py --setup --adb /absolute/path/to/adb --out .local/android/setup
python tools/android-world/run.py --adb /absolute/path/to/adb \
  --model-catalog /absolute/path/to/model-catalog.json --out .local/android/run-01
```

The controller creates an isolated server and uses ADB reverse to connect the disposable APK. It records each result and writes the aggregate to `results.json`. A strict success requires an upstream reward of 1 and a normal actor exit within both budgets and within its tool grant. Failures, timeouts and tool refusals stay visible. Raw agent traces and disposable credentials remain under `.local/`. This subset should be reported with its exact tasks, seeds, environment and model.

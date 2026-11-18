# AndroidWorld public subset

This benchmark runs the 15 task/seed pairs in [suite.json](../../tools/android-world/suite.json) on a dedicated Pixel 6 emulator with Android 13 (API 33). The controller uses the pinned public AndroidWorld task registry, parameter generators, setup, teardown, and success checks. It opens each task's declared app before handing control to the agent. The public initializer controls the emulator wall clock. aBridge checks dispatch expiry against the server clock advanced with Android monotonic time.

The agent sees the public goal and a single aBridge session. Its gateway allows only `computer_observe` and `computer_act`. The controller alone uses AndroidWorld and ADB for provisioning, initialization, and grading. This suite measures end-to-end screen and input operations, including file management through the Android Files app. Direct aBridge file API access has separate authorization and is outside this suite's scoring scope.

Use a disposable AVD named `AndroidWorldAvd` with a Pixel 6 profile and the API 33 Google APIs ARM64 image. Launch with `-port 5562 -no-snapshot -grpc 8554` and install the aBridge debug APK. Keep the emulator and its gRPC port on a trusted test host.

Check out the [pinned upstream source](https://github.com/google-research/android_world/tree/55ddaf5edc6f6c25673aed343907d5b9dca66f84). Follow its Python 3.11 dependency and Protobuf generation steps. Run the controller from the aBridge repository root with the upstream checkout on `PYTHONPATH`.

```sh
python tools/android-world/run.py --setup --adb /absolute/path/to/adb --out .local/android/setup
python tools/android-world/run.py --adb /absolute/path/to/adb \
  --model-catalog /absolute/path/to/model-catalog.json --out .local/android/run-01
```

The controller creates an isolated loopback server that explicitly accepts the emulator host alias `10.0.2.2`. The disposable APK connects to that server. It records each result and writes the aggregate to `results.json`. A strict success requires an upstream reward of 1 and a normal actor exit within both budgets and within its tool grant. Each member of a bulk click consumes one action unit from the existing 45-unit limit. The report also records the number of MCP calls. Failures, timeouts and tool refusals stay visible. Raw agent traces and disposable credentials remain under `.local/`. This subset should be reported with its exact tasks, seeds, environment and model.

The optional two-emulator run keeps the same 15 pairs. Assign Files tasks to `AndroidWorldAvd` on console/gRPC ports 5562/8554 and Markor tasks to `AndroidWorldAvdMarkor` on ports 5564/8556. Both use the same Pixel 6 profile and system image. Run setup separately for each emulator with its group and ports, then run the two groups with the same model catalog. Each group runs sequentially. Merge results only after both complete.

```sh
python tools/android-world/run.py --adb /absolute/path/to/adb --group files \
  --model-catalog /absolute/path/to/model-catalog.json --out .local/android/run-files
python tools/android-world/run.py --adb /absolute/path/to/adb --group markor --port 5564 --grpc 8556 \
  --model-catalog /absolute/path/to/model-catalog.json --out .local/android/run-markor
python tools/android-world/merge-results.py .local/android/run-files/results.json \
  .local/android/run-markor/results.json --out .local/android/results.json
```

In a separate deterministic file API check, the controller used the public `MarkorCreateNote` generator and grader with seeds 0, 1 and 2. On the API 33 emulator, the three cases each passed official grading and verified aBridge directory listing, write, read-back, default overwrite refusal and traversal refusal. This probe uses the task parameters as inputs and is outside the agent score.

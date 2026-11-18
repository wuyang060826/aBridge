"""Run the pinned public AndroidWorld subset through aBridge on a disposable AVD."""

import argparse
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import traceback

from android_world import registry
from android_world.env import adb_utils, env_launcher
from android_world.env.setup_device import apps, setup
import numpy as np


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SUITE = json.loads((HERE / "suite.json").read_text())
AVDS = {"all": "AndroidWorldAvd", "files": "AndroidWorldAvd", "markor": "AndroidWorldAvdMarkor"}
GROUPS = {
    "all": SUITE["tasks"],
    "files": [task for task in SUITE["tasks"] if task.startswith("Files")],
    "markor": [task for task in SUITE["tasks"] if task.startswith("Markor")],
}


def git(directory, *args):
    return subprocess.check_output(["git", "-C", directory, *args], text=True).strip()


def run_suite(args, env, output):
    tasks = registry.TaskRegistry()
    public = tasks.get_registry(tasks.ANDROID_WORLD_FAMILY)
    records = []
    report = {
        "protocol": SUITE,
        "sourceCommit": git(ROOT, "rev-parse", "HEAD"),
        "group": args.group,
        "avd": AVDS[args.group],
        "fingerprint": args.fingerprint,
        "workingTreeDirty": bool(git(ROOT, "status", "--porcelain")),
        "catalogSha256": None,
        "episodes": records,
    }

    def save():
        pending = output / "results.pending.json"
        pending.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        pending.replace(output / "results.json")

    with (output / "actor.stderr.log").open("w") as errors, subprocess.Popen(
        ["node", "--import", "tsx", str(HERE / "actor.ts"), args.adb,
         f"emulator-{args.port}", str(output), str(args.model_catalog.resolve()), AVDS[args.group]],
        cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, text=True,
    ) as actor:
        try:
            ready = json.loads(actor.stdout.readline() or "{}")
            if ready.get("ready") is not True:
                raise RuntimeError("aBridge Android failed to register. See actor.stderr.log")
            report["catalogSha256"] = ready["catalogSha256"]
            save()
            for task_name in GROUPS[args.group]:
                task_type = public[task_name]
                for seed in SUITE["seeds"]:
                    record = {"task": task_name, "seed": seed, "reward": None, "success": False,
                              "outcome": "setup_error", "upstreamCleanup": False}
                    task = None
                    initialized = False
                    try:
                        random.seed(seed)
                        np.random.seed(seed)
                        env.reset(go_home=True)
                        task = task_type(task_type.generate_random_params())
                        task.initialize_task(env)
                        initialized = True
                        # Begin in the task's declared app for every episode. Actor has no ADB access.
                        adb_utils.launch_app(task.app_names[0], env.controller)
                        record["outcome"] = "actor_error"
                        actor.stdin.write(json.dumps({"task": task_name, "seed": seed, "goal": task.goal}) + "\n")
                        actor.stdin.flush()
                        outcome = json.loads(actor.stdout.readline())
                        record.update(outcome)
                        if outcome["timedOut"] or outcome["budgetExceeded"] or outcome["toolViolations"]:
                            record["outcome"] = (
                                "timeout" if outcome["timedOut"] else "tool_budget"
                                if outcome["budgetExceeded"] else "tool_violation"
                            )
                        elif outcome["exitCode"] == 0:
                            record["outcome"] = "grader_error"
                            record["reward"] = float(task.is_successful(env))
                            record["success"] = record["reward"] == 1
                            record["outcome"] = "success" if record["success"] else "goal_not_met"
                    except Exception:
                        with (output / "controller-errors.log").open("a") as error_log:
                            print(f"{task_name}:{seed} ({record['outcome']})", file=error_log)
                            traceback.print_exc(file=error_log)
                    finally:
                        if initialized:
                            try:
                                task.tear_down(env)
                                record["upstreamCleanup"] = True
                            except Exception:
                                with (output / "controller-errors.log").open("a") as error_log:
                                    print(f"{task_name}:{seed} (cleanup)", file=error_log)
                                    traceback.print_exc(file=error_log)
                        records.append(record)
                        save()
                        print(f"{task_name}:{seed} {record['outcome']} reward={record['reward']}", flush=True)
            denominator = len(GROUPS[args.group]) * len(SUITE["seeds"])
            succeeded = sum(e["success"] for e in records)
            report["summary"] = {"passed": succeeded, "total": denominator, "rate": succeeded / denominator}
            save()
            print(f"Strict success: {succeeded}/{denominator}", flush=True)
            return 1 if any(e["outcome"] in {"setup_error", "grader_error", "actor_error"} for e in records) else 0
        finally:
            actor.stdin.close()
            try:
                actor.wait(timeout=15)
            except subprocess.TimeoutExpired:
                actor.kill()
                actor.wait()



def verify_emulator(args):
    serial = f"emulator-{args.port}"
    def adb(*command):
        return subprocess.check_output([args.adb, "-s", serial, *command], text=True, timeout=15).strip()
    if (AVDS[args.group] not in adb("emu", "avd", "name").splitlines()
        or adb("shell", "getprop", "ro.build.version.sdk") != str(SUITE["emulator"]["api"])
        or adb("shell", "getprop", "ro.product.cpu.abi") != SUITE["emulator"]["arch"]):
        raise RuntimeError("The required disposable AndroidWorld API 33 ARM64 emulator is unavailable")
    return adb("shell", "getprop", "ro.build.fingerprint")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb", required=True, type=lambda value: str(Path(value).expanduser().resolve()))
    parser.add_argument("--port", default=5562, type=int)
    parser.add_argument("--grpc", default=8554, type=int)
    parser.add_argument("--model-catalog", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--setup", action="store_true")
    parser.add_argument("--group", choices=AVDS, default="all")
    args = parser.parse_args()
    if not args.setup and args.model_catalog is None:
        parser.error("--model-catalog is required to run the suite")
    upstream = Path(registry.__file__).resolve().parent.parent
    if git(upstream, "rev-parse", "HEAD") != SUITE["upstream"] or git(upstream, "status", "--porcelain", "--untracked-files=no"):
        raise RuntimeError("Use the clean pinned AndroidWorld checkout from suite.json")
    args.fingerprint = verify_emulator(args)
    os.umask(0o077)
    args.out.mkdir(parents=True, exist_ok=False)
    # The public task initializer sets the task-specific time for each episode.
    env = env_launcher.load_and_setup_env(console_port=args.port, grpc_port=args.grpc,
                                           adb_path=args.adb, freeze_datetime=False)
    try:
        if args.setup:
            setup.setup_apps(env, (apps.AndroidWorldApp, apps.FilesApp, apps.MarkorApp))
            print("Public task apps installed and initialized", flush=True)
            return 0
        return run_suite(args, env, args.out.resolve())
    finally:
        env.close()


if __name__ == "__main__":
    sys.exit(main())

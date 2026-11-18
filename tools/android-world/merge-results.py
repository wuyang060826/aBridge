"""Check coverage of two completed AndroidWorld partitions and combine their results."""

import argparse
import json
from pathlib import Path
import statistics

BASE = Path(__file__).resolve().parent
REGRESSION = json.loads((BASE / "suite.json").read_text())
CHALLENGE = json.loads((BASE / "challenge.json").read_text())


def merge(files_path, markor_path):
    shards = [json.loads(p.read_text()) for p in (files_path, markor_path)]
    challenge = shards[0]["group"] == "challenge-a"
    suite = CHALLENGE if challenge else REGRESSION
    groups = suite.get("groups") or {
        "files": [task for task in suite["tasks"] if task.startswith("Files")],
        "markor": [task for task in suite["tasks"] if task.startswith("Markor")],
    }
    all_tasks = [task for tasks in groups.values() for task in tasks]
    if sorted(all_tasks) != sorted(suite["tasks"]):
        raise ValueError("Groups must partition the frozen tasks")
    for (label, tasks), shard in zip(groups.items(), shards, strict=True):
        expected = ([(task, seed) for seed in suite["seeds"] for task in tasks] if challenge
                    else [(task, seed) for task in tasks for seed in suite["seeds"]])
        measured = [(case["task"], case["seed"]) for case in shard["episodes"]]
        if shard["group"] != label or shard["protocol"] != suite or shard["workingTreeDirty"] or expected != measured:
            raise ValueError(f"{label} results do not match the fixed plan and clean source")
        if shard["summary"]["total"] != len(measured):
            raise ValueError(f"{label} results are incomplete")
    for key in ("sourceCommit", "catalogSha256", "fingerprint"):
        if not shards[0][key] or shards[0][key] != shards[1][key]:
            raise ValueError(f"Run provenance differs: {key}")
    episodes = [case for shard in shards for case in shard["episodes"]]
    for case in episodes:
        strict = (
            case["reward"] == 1 and case.get("exitCode") == 0 and not case.get("timedOut")
            and not case.get("budgetExceeded") and case.get("toolViolations") == 0
        )
        if case["success"] != strict:
            raise ValueError("Inconsistent strict success record")
    passed = sum(e["success"] for e in episodes)
    elapsed = [e["elapsedMs"] for e in episodes if "elapsedMs" in e]
    return {
        "protocol": suite,
        "sourceCommit": shards[0]["sourceCommit"],
        "catalogSha256": shards[0]["catalogSha256"],
        "fingerprint": shards[0]["fingerprint"],
        "concurrency": 2,
        "environments": [{"group": part["group"], "avd": part["avd"]} for part in shards],
        "summary": {
            "passed": passed,
            "total": len(episodes),
            "rate": passed / len(episodes),
            "toolCalls": sum(e.get("toolCalls", 0) for e in episodes),
            "agentLatencyP50Ms": statistics.median(elapsed) if elapsed else None,
        },
        "episodes": episodes,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", type=Path)
    parser.add_argument("markor", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = merge(args.files, args.markor)
    with args.out.open("x") as output:
        output.write(json.dumps(result, indent=2) + "\n")
    print(f"Public subset: {result['summary']['passed']}/{result['summary']['total']}")

import { checkUpdate, prepareUpdate, installUpdate, applyUpdate } from "./updater.js";
const [command, ...args] = process.argv.slice(2);
try {
  if (command === "check") console.log(JSON.stringify({ update: await checkUpdate(args[0]!) }));
  else if (command === "download")
    console.log(JSON.stringify({ plan: await prepareUpdate(args[0]!, args[1]!, args[2]!, args[3]!) }));
  else if (command === "install") {
    await installUpdate(args[0]!, Number(args[1]));
    console.log(JSON.stringify({ ready: true }));
  } else if (command === "apply") await applyUpdate(args[0]!);
  else throw Error("Unknown updater command");
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}

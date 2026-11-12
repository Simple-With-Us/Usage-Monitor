import { spawn } from "node:child_process";
import { hubBootstrapPlan } from "./snapshot-config.mjs";

let plan;
try { plan = await hubBootstrapPlan(); }
catch (error) { console.error(error.message); process.exit(2); }
const child = spawn(plan.command, plan.args, { stdio: "inherit", env: plan.env });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { console.error("Hub Infisical bootstrap could not start"); process.exit(1); });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

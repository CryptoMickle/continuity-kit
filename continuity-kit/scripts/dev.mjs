import { startDemo } from "./start-demo.mjs";

await startDemo({ physical: process.argv.includes("--physical") });

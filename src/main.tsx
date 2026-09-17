import { Command } from "commander";

const program = new Command();

program
  .name("star")
  .description("Star CLI — an AI agent command-line interface")
  .version("0.1.0")
  .option("-m, --model <model>", "model to use")
  .option("--permission-mode <mode>", "permission mode: auto | ask | readonly")
  .option("-p, --print <prompt>", "non-interactive print mode")
  .option("-r, --resume <sessionId>", "resume a previous session")
  .action(async (opts) => {
    console.log("star-cli scaffold OK", opts);
  });

program.parse(process.argv);

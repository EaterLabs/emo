#!/usr/bin/env node
const program = require('commander');
const cli = require("../lib/cli");

async function main() {
  program
    .version('1.0.0')
    .option('-c, --cache <cache-dir>', 'Where to store cache data for emo');

  await cli(program);

  program.parse(process.argv);
}

main().catch((err) => console.error(err));
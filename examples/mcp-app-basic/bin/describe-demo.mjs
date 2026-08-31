#!/usr/bin/env node

process.stdout.write(
  JSON.stringify({
    message: "declared command complete",
    argument: process.argv[2] ?? "",
  }),
);

import process from "process";

const debugEnabled = process.argv.includes("--debug");

export function debug(...args: unknown[]) {
  if (debugEnabled) {
    console.log(...args);
  }
}

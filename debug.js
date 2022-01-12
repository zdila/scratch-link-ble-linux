const debugEnabled = process.argv.includes("--debug");

function debug(...args) {
  if (debugEnabled) {
    console.log(...args);
  }
}

module.exports = { debug };

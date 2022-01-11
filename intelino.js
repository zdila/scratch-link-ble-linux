module.exports = { intelino };

const directions = ["current", "forward", "backward", "stop", "invert"];

const colors = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "unknown",
];

const decisions = [
  "none",
  "left",
  "right",
  "steer",
  "straight",
  undefined,
  undefined,
  "all",
];

/**
 *
 * @param {Buffer} b
 */
function intelino(b) {
  // const msgLen = b.readUInt8(1);

  if (b.readUInt8(0) === 0x07) {
    // 07 09 01 0a 01 00 01 03 01 03 00
    console.log("TrainMsgVersionDetail", {
      api: [b.readUInt8(6), b.readUInt8(7)],
      firmware: [b.readUInt8(8), b.readUInt8(9), b.readUInt8(10)],
    });
  } else if (b.readUInt8(0) === 0x42) {
    console.log("TrainMsgMacAddress", {
      mac: b.slice(2).toString("hex").replace(/(..)/g, "$1 ").trim(),
    });
  } else if (b.readUInt8(0) === 0x43) {
    console.log("TrainMsgTrainUuid", {
      mac: b.slice(2).toString("hex").replace(/(..)/g, "$1 ").trim(),
    });
  } else if (b.readUInt8(0) === 0x3e) {
    console.log("TrainMsgStatsLifetimeOdometer", {
      odoCm: b.readUInt32BE(2),
    });
  } else if (b.readUInt8(0) === 0xb7) {
    const dir = directions[b.readUInt8(2)];

    const speed = b.readUInt16BE(3);

    const pwm = b.readUInt8(5);

    const speedControl = Boolean(b.readUInt8(6));

    const desiredSpeed = b.readUInt16BE(7);

    const pauseTime = b.readUInt8(9);

    const nextDecision = b.readUInt8(10);

    const odo = b.readUInt32BE(14);

    console.log("TrainMsgMovement", {
      dir,
      speed,
      desiredSpeed,
      pwm,
      speedControl,
      pauseTime,
      nextDecision: decisions[nextDecision] ?? "?" + nextDecision,
      odo,
    });
  } else if (b.readUInt8(0) === 0xe0) {
    const cmd = b.readUInt8(2);

    const ts = b.readUInt32BE(3) / 1000;

    if (cmd === 0x01) {
      console.log("MOVEMENT_DIRECTION_CHANGED", {
        ts,
        direction: directions[b.readUInt8(7)] ?? "?" + b.readUInt8(7),
      });
    } else if (cmd === 0x02) {
      console.log("LOW_BATTERY", { ts });
    } else if (cmd === 0x03) {
      console.log("BATTERY_CUT_OFF", { ts });
    } else if (cmd === 0x04) {
      console.log("CHARGING_STATE_CHANGED", {
        ts,
        charging: Boolean(b.readUInt8(7)),
      });
    } else if (cmd === 0x05) {
      console.log("BUTTON_PRESS_DETECTED", {
        ts,
        type:
          [undefined, "short", "long"][b.readUInt8(7)] ?? "?" + b.readUInt8(7),
      });
    } else if ((cmd === 0x06, cmd === 0x09)) {
      const counter = b.readUInt8(7);
      const c1 = colors[b.readUInt8(8)];
      const c2 = colors[b.readUInt8(9)];
      const c3 = colors[b.readUInt8(10)];
      const c4 = colors[b.readUInt8(11)];

      console.log(
        "%s ",
        cmd === 0x06 ? "SNAP_COMMAND_EXECUTED" : "SNAP_COMMAND_DETECTED",
        { ts, counter, c1, c2, c3, c4 }
      );
    } else if ([0x07, 0x08].includes(cmd)) {
      console.log("COLOR_CHANGED", {
        ts,
        sensor: cmd === 0x07 ? "front" : cmd === 0x08 ? "rear" : "?",
        color: colors[b.readUInt8(11)] ?? "?" + b.readUInt8(11),
        dist: b.readUInt32BE(7),
      });
    } else if (cmd === 0x0a) {
      console.log("SPLIT_DECISION", {
        ts,
        decision: decisions[b.readUInt8(7)] ?? "?" + b.readUInt8(7),
        dist: b.readUInt32BE(8),
      });
    } else {
      console.log(b.toString("hex").replace(/(..)/g, "$1 ").trim());
    }
  } else {
    console.log(b.toString("hex").replace(/(..)/g, "$1 ").trim());
  }
}

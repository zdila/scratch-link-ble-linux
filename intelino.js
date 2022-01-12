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
 * @param {DataView} dv
 * @returns
 */
function toHex(dv, separator = " ", offset = 0) {
  return [
    ...new Uint8Array(
      dv.buffer,
      dv.byteOffset + offset,
      dv.byteLength - offset
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join(separator);
}

/**
 *
 * @param {DataView} b
 */
function intelino(b) {
  const mt = b.getUint8(0);

  // const msgLen = b.getUint8(1);

  if (mt === 0x07) {
    // 07 09 01 0a 01 00 01 03 01 03 00
    console.log("TrainMsgVersionDetail", {
      api: [b.getUint8(6), b.getUint8(7)],
      firmware: [b.getUint8(8), b.getUint8(9), b.getUint8(10)],
    });
  } else if (mt === 0x42) {
    console.log("TrainMsgMacAddress", {
      mac: toHex(b, ":", 2),
    });
  } else if (mt === 0x43) {
    console.log("TrainMsgTrainUuid", {
      uuid: toHex(b, "", 2),
    });
  } else if (mt === 0x3e) {
    console.log("TrainMsgStatsLifetimeOdometer", {
      odoCm: b.getUint32(2),
    });
  } else if (mt === 0xb7) {
    const dir = directions[b.getUint8(2)];

    const speed = b.getUint16(3);

    const pwm = b.getUint8(5);

    const speedControl = Boolean(b.getUint8(6));

    const desiredSpeed = b.getUint16(7);

    const pauseTime = b.getUint8(9);

    const nextDecision = b.getUint8(10);

    const odo = b.getUint32(14);

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
  } else if (mt === 0xe0) {
    const cmd = b.getUint8(2);

    const ts = b.getUint32(3) / 1000;

    if (cmd === 0x01) {
      console.log("MOVEMENT_DIRECTION_CHANGED", {
        ts,
        direction: directions[b.getUint8(7)] ?? "?" + b.getUint8(7),
      });
    } else if (cmd === 0x02) {
      console.log("LOW_BATTERY", { ts });
    } else if (cmd === 0x03) {
      console.log("BATTERY_CUT_OFF", { ts });
    } else if (cmd === 0x04) {
      console.log("CHARGING_STATE_CHANGED", {
        ts,
        charging: Boolean(b.getUint8(7)),
      });
    } else if (cmd === 0x05) {
      console.log("BUTTON_PRESS_DETECTED", {
        ts,
        pressDuration:
          [undefined, "short", "long"][b.getUint8(7)] ?? "?" + b.getUint8(7),
      });
    } else if ((cmd === 0x06, cmd === 0x09)) {
      const counter = b.getUint8(7);
      const c1 = colors[b.getUint8(8)];
      const c2 = colors[b.getUint8(9)];
      const c3 = colors[b.getUint8(10)];
      const c4 = colors[b.getUint8(11)];

      console.log(
        "%s ",
        cmd === 0x06 ? "SNAP_COMMAND_EXECUTED" : "SNAP_COMMAND_DETECTED",
        { ts, counter, c1, c2, c3, c4 }
      );
    } else if ([0x07, 0x08].includes(cmd)) {
      console.log("COLOR_CHANGED", {
        ts,
        sensor: cmd === 0x07 ? "front" : cmd === 0x08 ? "rear" : "?",
        color: colors[b.getUint8(11)] ?? "?" + b.getUint8(11),
        dist: b.getUint32(7),
      });
    } else if (cmd === 0x0a) {
      console.log("SPLIT_DECISION", {
        ts,
        decision: decisions[b.getUint8(7)] ?? "?" + b.getUint8(7),
        dist: b.getUint32(8),
      });
    } else {
      console.log("UNKNOWN", toHex(b));
    }
  } else {
    console.log("UNKNOWN", toHex(b));
  }
}

import { initBle, Session } from "./ble";
import {
  Color,
  colors,
  Direction,
  directions,
  FeedbackType,
  feedbackTypes,
  intelinoBufferToJson,
} from "./intelino";

initBle()
  .then(({ createSession }) => startSession(createSession()))
  .catch((err) => {
    console.error(err);
  });

function getCommands(session: Session) {
  async function sendCommand(command: number, ...bytes: number[]) {
    await session.write(
      "43dfd9e9-17e5-4860-803d-9df8999b0d7a",
      "40c540d0-344c-4d0d-a1da-9cc260b82d43",
      Buffer.from([command, bytes.length, ...bytes]),
      true
    );
  }

  async function startStreaming() {
    // TODO params
    await sendCommand(0xb7, 0x07, 0x0a);
  }

  async function setTopLedColor(r: number, g: number, b: number) {
    await sendCommand(0xb1, 1, r, g, b);
  }

  async function driveWithConstantPwm(
    pwm: number,
    direction: Direction = "forward",
    playFeedback: boolean
  ) {
    await sendCommand(
      0xbc,
      directions.indexOf(direction),
      0xff - (pwm & 0xff),
      Number(playFeedback)
    );
  }

  async function pauseDriving(duration: number, playFeedback: boolean) {
    await sendCommand(0xbe, duration, Number(playFeedback));
  }

  async function stopDriving(feedbackType: FeedbackType) {
    await sendCommand(0xb9, feedbackTypes.indexOf(feedbackType));
  }

  async function setSnapCommandExecution(on: boolean) {
    await sendCommand(0x41, Number(on));
  }

  async function decoupleWagon(playFeedback: boolean, durationMs = 512) {
    await sendCommand(
      0x80,
      durationMs >> 8,
      durationMs & 0xff,
      Number(playFeedback)
    );
  }

  async function clearCustomSnapCommands() {
    const clrs: Color[] = ["black", "red", "green", "yellow", "blue"];

    for (const color of clrs) {
      await sendCommand(0x64, colors.indexOf(color), 0x00);
    }
  }

  async function setSnapCommandFeedback(sound: boolean, lights: boolean) {
    await sendCommand(0x65, Number(sound) | (Number(lights) << 1));
  }

  return {
    startStreaming,
    setTopLedColor,
    driveWithConstantPwm,
    pauseDriving,
    stopDriving,
    setSnapCommandExecution,
    decoupleWagon,
    clearCustomSnapCommands,
    setSnapCommandFeedback,
  };
}

async function startSession(session: Session) {
  const connPromise = new Promise((resolve, reject) => {
    session.on("didDiscoverPeripheral", (dev) => {
      session.connect(dev.peripheralId).then(resolve, reject);
    });
  });

  await session.discover([{ namePrefix: "intelino" }]);

  await connPromise;

  console.log("Conencted");

  session.on("characteristicDidChange", (value) => {
    console.log(
      intelinoBufferToJson(
        new DataView(
          value.message.buffer,
          value.message.byteOffset,
          value.message.byteLength
        )
      )
    );
  });

  ////////////////////////////////////////////////////

  // also read it (should be 00)
  await session.startNotifications(
    "4dad4922-5c86-4ba7-a2e1-0f240537bd08",
    "a4b80869-a84c-4160-a3e0-72fa58ff480e"
  );

  const { setTopLedColor } = getCommands(session);

  // // get version
  // await sendCommand(0x07);

  await setTopLedColor(255, 0, 255);

  // await pauseDriving(10, true);
}

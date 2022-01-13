import { initBle, Session } from "./ble";
import { directions, intelinoBufferToJson } from "./intelino";

const feedbackTypes = { none: 0, movementStop: 1, endRoute: 2 };

initBle()
  .then(({ createSession }) => startSession(createSession()))
  .catch((err) => {
    console.error(err);
  });

async function startSession(session: Session) {
  const connPromise = new Promise((resolve, reject) => {
    session.on("didDiscoverPeripheral", (dev) => {
      session.connect(dev.peripheralId).then(resolve, reject);
    });
  });

  await session.discover([{ namePrefix: "intelino" }]);

  await connPromise;

  console.log("Conencted");

  async function sendCommand(command: number, ...bytes: number[]) {
    await session.write(
      "43dfd9e9-17e5-4860-803d-9df8999b0d7a",
      "40c540d0-344c-4d0d-a1da-9cc260b82d43",
      Buffer.from([command, bytes.length, ...bytes]),
      true
    );
  }

  async function driveWithConstantPwm(
    pwm: number,
    direction: typeof directions[number] = "forward",
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

  async function stopDriving(
    feedbackType: keyof typeof feedbackTypes = "movementStop"
  ) {
    await sendCommand(0xb9, feedbackTypes[feedbackType]);
  }

  // start streaming; TODO
  await sendCommand(0xb7, 0x07, 0x0a);

  // also read it (should be 00)
  await session.startNotifications(
    "4dad4922-5c86-4ba7-a2e1-0f240537bd08",
    "a4b80869-a84c-4160-a3e0-72fa58ff480e"
  );

  // get version
  await sendCommand(0x07);

  // snap execution on
  await sendCommand(0x41, 0x01);

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

  await setTopLedColor(255, 0, 255);

  // await pauseDriving(10, true);
}

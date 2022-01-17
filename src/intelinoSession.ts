import { DiscoverParams, initBle, Session } from "./ble";
import { createEventTarget } from "./eventTarget";
import {
  Color,
  colors,
  Direction,
  directions,
  FeedbackType,
  feedbackTypes,
  intelinoBufferToJson,
  MacAddressMessage,
  Message,
  StatsLifetimeOdometerMessage,
  TrainUuidMessage,
  VersionDetailMessage,
} from "./intelino";

export async function toIntelinoSession(session: Session) {
  const callMap = new Map<number, (res: any) => void>();

  const { on, off, fire } = createEventTarget<{
    disconnect: void;
    discover: DiscoverParams;
    message: Message;
  }>();

  session.on("disconnect", () => {
    fire("disconnect", undefined);
  });

  session.on("discover", (params) => {
    fire("discover", params);
  });

  session.on("characteristicChange", (value) => {
    const { message } = value;

    const im = intelinoBufferToJson(
      new DataView(message.buffer, message.byteOffset, message.byteLength)
    );

    const b0 = message.readUInt8(0);

    const resolve = callMap.get(b0);
    if (resolve) {
      callMap.delete(b0);

      resolve(im);
    }

    fire("message", im);
  });

  await session.startNotifications(
    "4dad4922-5c86-4ba7-a2e1-0f240537bd08",
    "a4b80869-a84c-4160-a3e0-72fa58ff480e"
  );

  async function sendCommand(command: number, ...bytes: number[]) {
    await session.write(
      "43dfd9e9-17e5-4860-803d-9df8999b0d7a",
      "40c540d0-344c-4d0d-a1da-9cc260b82d43",
      Buffer.from([command, bytes.length, ...bytes]),
      true
    );
  }

  async function sendCommandWithResponse<T extends Message>(
    command: number,
    ...bytes: number[]
  ) {
    return new Promise<T>((resolve, reject) => {
      callMap.set(command, resolve);

      sendCommand(command, ...bytes).then(() => {
        setTimeout(() => {
          callMap.delete(command);
          reject(new Error("timeout"));
        }, 3000);
      }, reject);
    });
  }

  async function getVersionInfo() {
    return sendCommandWithResponse<VersionDetailMessage>(0x07);
  }

  async function getMacAddress() {
    return sendCommandWithResponse<MacAddressMessage>(0x42);
  }

  async function getUuid() {
    return sendCommandWithResponse<TrainUuidMessage>(0x43);
  }

  async function getStatsLifetimeOdometer() {
    return sendCommandWithResponse<StatsLifetimeOdometerMessage>(0x3e);
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

  async function driveAtSpeedLevel(
    speedLevel: 0 | 1 | 2 | 3,
    direction: Direction = "forward",
    playFeedback = true
  ) {
    await sendCommand(
      0xb8,
      directions.indexOf(direction),
      speedLevel,
      Number(playFeedback)
    );
  }

  async function pauseDriving(duration: number, playFeedback: boolean) {
    await sendCommand(0xbe, duration, Number(playFeedback));
  }

  async function stopDriving(feedbackType: FeedbackType = "none") {
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

  async function setHeadlightColor(
    front: [r: number, g: number, b: number] | null | undefined,
    back: [r: number, g: number, b: number] | null | undefined
  ) {
    sendCommand(
      0xb4,
      (front ? 0b010 : 0) | (back ? 0b100 : 0),
      ...(front ?? [0, 0, 0]),
      ...(back ?? [0, 0, 0])
    );
  }

  async function setNextSplitSteeringDecision(
    nextDecision: "left" | "right" | "straight"
  ) {
    sendCommand(
      0xbf,
      nextDecision === "left" ? 0b01 : nextDecision === "right" ? 0b10 : 0b11
    );
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
    driveAtSpeedLevel,
    setHeadlightColor,
    setNextSplitSteeringDecision,
    getVersionInfo,
    getMacAddress,
    getUuid,
    getStatsLifetimeOdometer,
    on,
    off,
  };
}

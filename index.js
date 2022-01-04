const { createServer } = require("https");
const { readFileSync } = require("fs");
const { WebSocketServer } = require("ws");
const dbus = require("dbus-next");
const { matchesFilter } = require("./filterMatcher");

const Variant = dbus.Variant;

const bus = dbus.systemBus();

const server = createServer(
  {
    cert: readFileSync("scratch-device-manager.cer"),
    key: readFileSync("scratch-device-manager.key"),
  },
  (req, res) => {
    res.writeHead(200);
    res.end("OK");
  }
);

const wss = new WebSocketServer({ server });

server.listen(20110);

let devicePath = undefined;

const charMap = new Map();

const serviceMap = new Map();

let discovering = false;

let connected = false;

let deviceObj = undefined;

let bluez;

let hci0Obj;

let adapterIface;

let objectManagerIface;

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    data = JSON.parse(data.toString("UTF-8"));

    console.log("Message:", data);

    if (data.method === "getVersion") {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: data.id,
          result: JSON.stringify({ protocol: "1.3" }),
        })
      );
    } else if (data.method === "discover") {
      discover(ws, data.params.filters);

      ws.send(JSON.stringify({ jsonrpc: "2.0", id: data.id, result: null }));
    } else if (data.method === "connect") {
      connect(ws, data.params.peripheralId).then(
        () => {
          ws.send(
            JSON.stringify({ jsonrpc: "2.0", id: data.id, result: null })
          );
        },
        (err) => {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: data.id,
              error: { code: -32603, message: String(err) },
            })
          );
        }
      );
    } else if (data.method === "write") {
      const msg =
        data.params.encoding === "base64"
          ? [...Buffer.from(data.params.message, "base64").values()]
          : data.params.message;

      write(
        data.params.serviceId,
        data.params.characteristicId,
        msg,
        data.params.withResponse
      ).then(
        () => {
          ws.send(
            JSON.stringify({ jsonrpc: "2.0", id: data.id, result: msg.length })
          );
        },
        (err) => {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: data.id,
              error: { code: -32603, message: String(err) },
            })
          );
        }
      );
    } else if (data.method === "read") {
      read(
        ws,
        data.params.serviceId,
        data.params.characteristicId,
        data.params.startNotifications
      ).then(
        (result) => {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: data.id,
              result: Buffer.from(result).toString("base64"),
              encoding: "base64",
            })
          );
        },
        (err) => {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: data.id,
              error: { code: -32603, message: String(err) },
            })
          );
        }
      );
    } else if (data.method === "startNotifications") {
      startNotifications(
        data.params.serviceId,
        data.params.characteristicId
      ).then(
        () => {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: data.id,
              result: null,
            })
          );
        },
        (err) => {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: data.id,
              error: { code: -32603, message: String(err) },
            })
          );
        }
      );
    } else if (data.method === "stopNotifications") {
      stopNotifications(
        data.params.serviceId,
        data.params.characteristicId
      ).then(
        () => {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: data.id,
              result: null,
            })
          );
        },
        (err) => {
          ws.send(
            JSON.stringify({ jsonrpc: "2.0", id: data.id, error: String(err) })
          );
        }
      );
    } else if (data.method === "getServices") {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: data.id,
          result: serviceMap.values().map((s) => s.uuid),
        })
      );
    } else if (data.method === "getCharacteristics") {
      const s = serviceMap
        .values()
        .find((s) => s.uuid === data.params.serviceId);

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: data.id,
          result: s
            ? charMap
                .values()
                .filter((c) => c.path.startsWith(s.path))
                .map((c) => c.uuid)
            : [],
        })
      );
    } else {
      console.error("unknown method");

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: data.id,
          error: {
            code: -32601,
            message: "Method not found",
          },
        })
      );
    }
  });

  ws.on("close", () => {
    if (connected && deviceObj) {
      console.log("DISCONNECTING");

      const deviceIface = deviceObj.getInterface("org.bluez.Device1");

      deviceIface.Disconnect();
    }
  });
});

process.on("SIGINT", async () => {
  console.log("Caught interrupt signal");

  try {
    if (discovering) {
      await adapterIface.StopDiscovery();
    }

    if (connected && deviceObj) {
      console.log("DISCONNECTING");

      const deviceIface = deviceObj.getInterface("org.bluez.Device1");

      await deviceIface.Disconnect();
    }
  } catch (err) {
    console.error("FOO", err);
  } finally {
    process.exit();
  }
});

let ws, filters;

async function init() {
  bluez = await bus.getProxyObject("org.bluez", "/");

  hci0Obj = await bus.getProxyObject("org.bluez", "/org/bluez/hci0");

  adapterIface = hci0Obj.getInterface("org.bluez.Adapter1");

  const propertiesIface = hci0Obj.getInterface(
    "org.freedesktop.DBus.Properties"
  );

  objectManagerIface = bluez.getInterface("org.freedesktop.DBus.ObjectManager");

  discovering = (await propertiesIface.Get("org.bluez.Adapter1", "Discovering"))
    .value;

  propertiesIface.on("PropertiesChanged", (iface, changed) => {
    console.log("Adapter prop changed", iface, changed);

    if ((iface === "org.bluez.Adapter1", changed["Discovering"])) {
      discovering = changed["Discovering"].value;

      if (!discovering) {
        objectManagerIface.off("InterfacesAdded", handleInterfaceAdded);
      }
    }
  });

  await adapterIface.SetDiscoveryFilter({
    // RSSI: new Variant("n", -120),
    Transport: new Variant("s", "le"),
    DuplicateData: new Variant("b", true),
  });
}

init().catch((err) => {
  console.error(err);
});

async function discover(_ws, _filters) {
  ws = _ws;
  filters = _filters;

  if (!discovering) {
    await adapterIface.StartDiscovery();
  }

  objectManagerIface.on("InterfacesAdded", handleInterfaceAdded);

  for (const [path, props] of Object.entries(
    await objectManagerIface.GetManagedObjects()
  )) {
    await handleInterfaceAdded(path, props);
  }
}

async function handleInterfaceAdded(path, props) {
  const device = props?.["org.bluez.Device1"];

  console.log("iface", path, device?.Name?.value);

  if (device && filters.some((filter) => matchesFilter(device, filter))) {
    const deviceObj = await bus.getProxyObject("org.bluez", path);

    const propertiesIface = deviceObj.getInterface(
      "org.freedesktop.DBus.Properties"
    );

    const handleDevicePropsChanged = (iface, changed) => {
      console.log("Device property", iface, changed);

      if (iface === "org.bluez.Device1" && changed["RSSI"]) {
        propertiesIface.off("PropertiesChanged", handleDevicePropsChanged);

        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "didDiscoverPeripheral",
            params: {
              peripheralId: path,
              name: device?.Name?.value,
              rssi: changed["RSSI"].value,
            },
          })
        );
      }
    };

    propertiesIface.on("PropertiesChanged", handleDevicePropsChanged);
  } else if (
    path.startsWith(devicePath + "/service") &&
    /\/char[0-9a-z]*$/.test(path)
  ) {
    const obj = await bus.getProxyObject("org.bluez", path);

    const iface = obj.getInterface("org.bluez.GattCharacteristic1");

    const properties = obj.getInterface("org.freedesktop.DBus.Properties");

    const uuid = await properties.Get("org.bluez.GattCharacteristic1", "UUID");

    console.log("char:", uuid.value);

    charMap.set(path, { uuid: uuid.value, path, iface, obj });
  } else if (path.startsWith(devicePath) && /\/service[0-9a-z]*$/.test(path)) {
    const obj = await bus.getProxyObject("org.bluez", path);

    const iface = obj.getInterface("org.bluez.GattService1");

    const properties = obj.getInterface("org.freedesktop.DBus.Properties");

    const [uuid, isPrimary] = await Promise.all([
      properties.Get("org.bluez.GattService1", "UUID"),
      properties.Get("org.bluez.GattService1", "Primary"),
    ]);

    console.log("svc:", uuid.value);

    serviceMap.set(path, { uuid: uuid.value, path, iface, obj, isPrimary });
  }
}

async function connect(ws, path) {
  console.log("CONNECTING");

  devicePath = path;

  deviceObj = await bus.getProxyObject("org.bluez", path);

  const propertiesIface = deviceObj.getInterface(
    "org.freedesktop.DBus.Properties"
  );

  const srPromise = new Promise((resolve) => {
    propertiesIface.on("PropertiesChanged", (iface, changed) => {
      if (iface === "org.bluez.Device1") {
        if (changed["ServicesResolved"]?.value) {
          resolve();
        } else if (changed["Connected"]) {
          connected = changed["Connected"].value;

          if (!connected) {
            ws.close();

            devicePath = undefined;

            deviceObj = undefined;

            serviceMap.clear();

            charMap.clear();
          }
        }
      }
    });
  });

  const deviceIface = deviceObj.getInterface("org.bluez.Device1");

  await deviceIface.Connect();

  await srPromise;

  if (discovering) {
    await adapterIface.StopDiscovery();
  }
}

// TODO optimize from O(n)
function getChar(serviceId, characteristicId) {
  const service = [...serviceMap.values()].find(
    serviceId ? (s) => s.uuid === serviceId : (s) => s.isPrimary
  );

  if (service) {
    for (const char of [...charMap.values()]) {
      if (
        char.uuid === characteristicId &&
        char.path.startsWith(service.path)
      ) {
        return char;
      }
    }
  }

  return undefined;
}

async function write(serviceId, characteristicId, msg, withResponse) {
  await getChar(serviceId, characteristicId).iface.WriteValue(msg, {
    type: new Variant("s", withResponse ? "request" : "command"),
  });
}

async function startNotifications(serviceId, characteristicId) {
  const { iface } = await getChar(serviceId, characteristicId);

  await iface.StartNotify();
}

async function stopNotifications(serviceId, characteristicId) {
  const { iface } = await getChar(serviceId, characteristicId);

  await iface.StopNotify();
}

async function read(ws, serviceId, characteristicId, startNotifications) {
  const { iface, obj } = await getChar(serviceId, characteristicId);

  const result = iface.ReadValue({});

  if (startNotifications) {
    await iface.StartNotify();

    const propertiesIface = obj.getInterface("org.freedesktop.DBus.Properties");

    propertiesIface.on("PropertiesChanged", (iface, changed) => {
      if (iface === "org.bluez.GattCharacteristic1" && changed["Value"]) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "characteristicDidChange",
            params: {
              serviceId,
              characteristicId,
              message: Buffer.from(changed["Value"].value).toString("base64"),
              encoding: "base64",
            },
          })
        );
      }
    });
  }

  return result;
}

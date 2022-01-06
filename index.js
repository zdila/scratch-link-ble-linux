const { createServer } = require("https");
const { readFileSync } = require("fs");
const { WebSocketServer } = require("ws");
const dbus = require("dbus-next");
const { matchesFilter } = require("./filterMatcher");

const debug = process.argv.includes("--debug");

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

let discovering = false;

let bluez;

let hci0Obj;

let adapterIface;

let objectManagerIface;

const deviceObjs = new Set();

function dbg(...args) {
  if (debug) {
    console.log(...args);
  }
}

wss.on("connection", (ws) => {
  dbg("WebSocket connection");

  let deviceObj = undefined;

  const charMap = new Map();

  const serviceMap = new Map();

  let filters;

  const connectCleanupTasks = [];

  const closeCleanupTasks = [];

  const send = (data) => {
    dbg("RPC Sending:", data);

    return ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        ...data,
      })
    );
  };

  ws.on("message", (data) => {
    const { id, method, params } = JSON.parse(data.toString("UTF-8"));

    dbg("RPC Received:", { id, method, params });

    const reply = (data) => {
      return send({
        id,
        ...data,
      });
    };

    if (method === "getVersion") {
      reply({ result: { protocol: "1.3" } });
    } else if (method === "discover") {
      filters = params.filters;

      discover().catch((err) => {
        console.error(err);
      });

      reply({ result: null });
    } else if (method === "connect") {
      connect(params.peripheralId).then(
        () => reply({ result: null }),
        (err) => reply({ error: { code: -32603, message: String(err) } })
      );
    } else if (method === "write") {
      const msg =
        params.encoding === "base64"
          ? [...Buffer.from(params.message, "base64").values()]
          : params.message;

      write(
        params.serviceId,
        params.characteristicId,
        msg,
        params.withResponse
      ).then(
        () => reply({ result: msg.length }),
        (err) => reply({ error: { code: -32603, message: String(err) } })
      );
    } else if (method === "read") {
      read(
        params.serviceId,
        params.characteristicId,
        params.startNotifications
      ).then(
        (result) =>
          reply({
            result: Buffer.from(result).toString("base64"),
            encoding: "base64",
          }),
        (err) => reply({ error: { code: -32603, message: String(err) } })
      );
    } else if (method === "startNotifications") {
      startNotifications(params.serviceId, params.characteristicId).then(
        () => reply({ result: null }),
        (err) => reply({ error: { code: -32603, message: String(err) } })
      );
    } else if (method === "stopNotifications") {
      stopNotifications(params.serviceId, params.characteristicId).then(
        () => reply({ result: null }),
        (err) => reply({ error: String(err) })
      );
    } else if (method === "getServices") {
      reply({ result: serviceMap.values().map((s) => s.uuid) });
    } else if (method === "getCharacteristics") {
      const s = serviceMap.values().find((s) => s.uuid === params.serviceId);

      reply({
        result: s
          ? charMap
              .values()
              .filter((c) => c.path.startsWith(s.path))
              .map((c) => c.uuid)
          : [],
      });
    } else {
      console.error("unknown method");

      reply({
        error: {
          code: -32601,
          message: "Method not found",
        },
      });
    }
  });

  ws.on("close", () => {
    for (const task of closeCleanupTasks) {
      task();
    }

    if (deviceObj) {
      dbg("Disconnecting device");

      const deviceIface = deviceObj.getInterface("org.bluez.Device1");

      deviceIface
        .Disconnect()
        .catch((err) => console.error("Error Disconnect:", err));

      deviceObjs.delete(deviceObj);
    }
  });

  async function discover() {
    if (!discovering) {
      dbg("Starting discovery");

      await adapterIface.StartDiscovery();
    }

    const handle = (...params) => {
      handleInterfaceAdded(...params).catch((err) => {
        console.error(err);
      });
    };

    objectManagerIface.on("InterfacesAdded", handle);

    closeCleanupTasks.push(() => {
      objectManagerIface.off("InterfacesAdded", handle);
    });

    for (const [path, props] of Object.entries(
      await objectManagerIface.GetManagedObjects()
    )) {
      await handleInterfaceAdded(path, props);
    }
  }

  async function handleInterfaceAdded(path, props) {
    const device = props?.["org.bluez.Device1"];

    dbg("iface", path, device?.Name?.value);

    if (device && filters?.some((filter) => matchesFilter(device, filter))) {
      const deviceObj = await bus.getProxyObject("org.bluez", path);

      const propertiesIface = deviceObj.getInterface(
        "org.freedesktop.DBus.Properties"
      );

      const handleDevicePropsChanged = (iface, changed) => {
        dbg("Device property", iface, changed);

        if (iface === "org.bluez.Device1" && changed["RSSI"]) {
          // propertiesIface.off("PropertiesChanged", handleDevicePropsChanged);

          send({
            method: "didDiscoverPeripheral",
            params: {
              peripheralId: path,
              name: device?.Name?.value,
              rssi: changed["RSSI"].value,
            },
          });
        }
      };

      propertiesIface.on("PropertiesChanged", handleDevicePropsChanged);

      connectCleanupTasks.push(() => {
        propertiesIface.off("PropertiesChanged", handleDevicePropsChanged);
      });
    } else if (
      deviceObj &&
      path.startsWith(deviceObj.path + "/service") &&
      /\/char[0-9a-z]*$/.test(path)
    ) {
      const obj = await bus.getProxyObject("org.bluez", path);

      const iface = obj.getInterface("org.bluez.GattCharacteristic1");

      const properties = obj.getInterface("org.freedesktop.DBus.Properties");

      const uuid = await properties.Get(
        "org.bluez.GattCharacteristic1",
        "UUID"
      );

      dbg("Found GATT Characteristics:", uuid.value);

      charMap.set(path, { uuid: uuid.value, path, iface, obj });
    } else if (
      deviceObj &&
      path.startsWith(deviceObj.path) &&
      /\/service[0-9a-z]*$/.test(path)
    ) {
      const obj = await bus.getProxyObject("org.bluez", path);

      const iface = obj.getInterface("org.bluez.GattService1");

      const properties = obj.getInterface("org.freedesktop.DBus.Properties");

      const [uuid, isPrimary] = await Promise.all([
        properties.Get("org.bluez.GattService1", "UUID"),
        properties.Get("org.bluez.GattService1", "Primary"),
      ]);

      dbg("Found GATT Service:", uuid.value);

      serviceMap.set(path, { uuid: uuid.value, path, iface, obj, isPrimary });
    }
  }

  async function connect(path) {
    if (discovering) {
      dbg("Stopping discovery");

      await adapterIface.StopDiscovery();
    }

    for (const task of connectCleanupTasks) {
      task();
    }

    dbg("Connecting to device", path);

    deviceObj = await bus.getProxyObject("org.bluez", path);

    deviceObjs.add(deviceObj);

    const propertiesIface = deviceObj.getInterface(
      "org.freedesktop.DBus.Properties"
    );

    const srPromise = new Promise((resolve) => {
      const handlePropertiesChanges = (iface, changed) => {
        if (iface === "org.bluez.Device1") {
          if (changed["ServicesResolved"]) {
            const { value } = changed["ServicesResolved"];

            dbg("ServicesResolved:", value);

            resolve();
          }

          if (changed["Connected"]) {
            const { value } = changed["Connected"];

            dbg("Connected:", value);

            if (!value) {
              ws.close();

              deviceObj = undefined;
            }
          }
        }
      };

      propertiesIface.on("PropertiesChanged", handlePropertiesChanges);

      closeCleanupTasks.push(() => {
        propertiesIface.off("PropertiesChanged", handlePropertiesChanges);
      });
    });

    const deviceIface = deviceObj.getInterface("org.bluez.Device1");

    await deviceIface.Connect();

    await srPromise;
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

    dbg("No such char", serviceId, characteristicId);

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

  async function read(serviceId, characteristicId, startNotifications) {
    const { iface, obj } = await getChar(serviceId, characteristicId);

    const result = iface.ReadValue({});

    if (startNotifications) {
      await iface.StartNotify();

      const propertiesIface = obj.getInterface(
        "org.freedesktop.DBus.Properties"
      );

      propertiesIface.on("PropertiesChanged", (iface, changed) => {
        if (iface === "org.bluez.GattCharacteristic1" && changed["Value"]) {
          send({
            jsonrpc: "2.0",
            method: "characteristicDidChange",
            params: {
              serviceId,
              characteristicId,
              message: Buffer.from(changed["Value"].value).toString("base64"),
              encoding: "base64",
            },
          });
        }
      });
    }

    return result;
  }
});

process.on("SIGINT", () => {
  dbg("Caught interrupt signal");

  const promises = [];

  try {
    if (discovering) {
      dbg("Stopping discovery");

      promises.push(
        adapterIface.StopDiscovery().catch((err) => {
          console.err("Error StopDiscovery:", err);
        })
      );
    }

    for (const deviceObj of deviceObjs) {
      dbg("Disconnecting");

      const deviceIface = deviceObj.getInterface("org.bluez.Device1");

      promises.push(
        deviceIface.Disconnect().catch((err) => {
          console.err("Error Disconnect:", err);
        })
      );
    }
  } finally {
    Promise.all(promises).finally(() => process.exit());
  }
});

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

  dbg("Discovering", discovering);

  propertiesIface.on("PropertiesChanged", (iface, changed) => {
    dbg("Adapter prop changed", iface, changed);

    if ((iface === "org.bluez.Adapter1", changed["Discovering"])) {
      discovering = changed["Discovering"].value;

      dbg("Discovering", discovering);
    }
  });

  await adapterIface.SetDiscoveryFilter({
    Transport: new Variant("s", "le"),
  });
}

init().catch((err) => {
  console.error(err);
});

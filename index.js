const { createServer } = require("https");
const { readFileSync } = require("fs");
const { WebSocketServer } = require("ws");
const dbus = require("dbus-next");
const { matchesFilter } = require("./filterMatcher");

const GS1 = "org.bluez.GattService1";

const GC1 = "org.bluez.GattCharacteristic1";

const D1 = "org.bluez.Device1";

const PROPS = "org.freedesktop.DBus.Properties";

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

    if (ws.readyState !== ws.OPEN) {
      console.warn("Can't send, WeboSocket is not open");

      return;
    }

    return ws.send(JSON.stringify({ jsonrpc: "2.0", ...data }), {}, (err) => {
      if (err) {
        console.error("Error sending data to WebSocket:", err);
      }
    });
  };

  ws.on("message", (data) => {
    const { id, method, params } = JSON.parse(data.toString("UTF-8"));

    dbg("RPC Received:", { id, method, params });

    const reply = (data) => {
      return send({ id, ...data });
    };

    const replyError = (err) => {
      console.error(err);

      return reply({ error: { code: -32603, message: String(err) } });
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
        replyError
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
      ).then(() => reply({ result: msg.length }), replyError);
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
        replyError
      );
    } else if (method === "startNotifications") {
      startNotifications(params.serviceId, params.characteristicId).then(
        () => reply({ result: null }),
        replyError
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
    for (const task of [...connectCleanupTasks, ...closeCleanupTasks]) {
      task();
    }

    for (const fn of notifMap.values()) {
      fn();
    }

    if (deviceObj) {
      dbg("Disconnecting device");

      const deviceIface = deviceObj.getInterface(D1);

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

    connectCleanupTasks.push(() => {
      objectManagerIface.off("InterfacesAdded", handle);
    });

    for (const [path, props] of Object.entries(
      await objectManagerIface.GetManagedObjects()
    )) {
      await handleInterfaceAdded(path, props);
    }
  }

  async function handleInterfaceAdded(path, props) {
    const device = props?.[D1];

    if (device && filters?.some((filter) => matchesFilter(device, filter))) {
      const deviceObj = await bus.getProxyObject("org.bluez", path);

      const propertiesIface = deviceObj.getInterface(PROPS);

      const handleDevicePropsChanged = (iface, changed) => {
        dbg("Device %s props changed:", iface, changed);

        if (iface === D1 && changed.RSSI) {
          // propertiesIface.off("PropertiesChanged", handleDevicePropsChanged);

          send({
            method: "didDiscoverPeripheral",
            params: {
              peripheralId: path,
              name: device?.Name?.value,
              rssi: changed.RSSI.value,
            },
          });
        }
      };

      propertiesIface.on("PropertiesChanged", handleDevicePropsChanged);

      connectCleanupTasks.push(() => {
        propertiesIface.off("PropertiesChanged", handleDevicePropsChanged);
      });
    }
  }

  async function connect(devicePath) {
    if (discovering) {
      dbg("Stopping discovery");

      await adapterIface.StopDiscovery();
    }

    for (const task of connectCleanupTasks) {
      task();
    }

    connectCleanupTasks.length = 0;

    dbg("Connecting to device", devicePath);

    deviceObj = await bus.getProxyObject("org.bluez", devicePath);

    deviceObjs.add(deviceObj);

    const propertiesIface = deviceObj.getInterface(PROPS);

    const srPromise = new Promise((resolve) => {
      const handlePropertiesChanges = (iface, changed) => {
        if (iface === D1) {
          if (changed.ServicesResolved) {
            const { value } = changed.ServicesResolved;

            dbg("ServicesResolved:", value);

            resolve();
          }

          if (changed.Connected) {
            const { value } = changed.Connected;

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

    const deviceIface = deviceObj.getInterface(D1);

    await deviceIface.Connect();

    await srPromise;

    for (const [path, props] of Object.entries(
      await objectManagerIface.GetManagedObjects()
    )) {
      if (
        path.startsWith(devicePath + "/service") &&
        /\/char[0-9a-z]*$/.test(path)
      ) {
        const uuid = props[GC1].UUID.value;

        dbg("Found GATT Characteristics", uuid);

        const obj = await bus.getProxyObject("org.bluez", path);

        const iface = obj.getInterface(GC1);

        charMap.set(path, { uuid, path, iface, obj });
      } else if (
        path.startsWith(devicePath) &&
        /\/service[0-9a-z]*$/.test(path)
      ) {
        const uuid = props[GS1].UUID.value;

        dbg("Found GATT Service", uuid);

        const isPrimary = props[GS1].Primary.value;

        const obj = await bus.getProxyObject("org.bluez", path);

        const iface = obj.getInterface(GS1);

        serviceMap.set(path, { uuid, path, iface, obj, isPrimary });
      }
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

    dbg("No such characteristic", serviceId, characteristicId);

    throw new Error("no such characteristic");
  }

  async function write(serviceId, characteristicId, msg, withResponse) {
    await getChar(serviceId, characteristicId).iface.WriteValue(msg, {
      type: new Variant("s", withResponse ? "request" : "command"),
    });
  }

  const notifMap = new Map();

  async function startNotifications(serviceId, characteristicId) {
    const key = serviceId + ":" + characteristicId;

    if (notifMap.has(key)) {
      console.warn("Duplicate notification subscription request for ", key);

      return;
    }

    const { iface, obj } = await getChar(serviceId, characteristicId);

    await iface.StartNotify();

    const propertiesIface = obj.getInterface(PROPS);

    const handleNotif = (iface, changed) => {
      if (iface === GC1 && changed.Value) {
        send({
          method: "characteristicDidChange",
          params: {
            serviceId,
            characteristicId,
            message: Buffer.from(changed.Value.value).toString("base64"),
            encoding: "base64",
          },
        });
      }
    };

    propertiesIface.on("PropertiesChanged", handleNotif);

    notifMap.set(key, async () => {
      propertiesIface.off("PropertiesChanged", handleNotif);

      await iface.StopNotify();
    });
  }

  async function stopNotifications(serviceId, characteristicId) {
    await notifMap.get(serviceId + ":" + characteristicId)?.();
  }

  async function read(serviceId, characteristicId, startNotif) {
    const { iface } = await getChar(serviceId, characteristicId);

    const result = iface.ReadValue({});

    if (startNotif) {
      await startNotifications(serviceId, characteristicId);
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

      const deviceIface = deviceObj.getInterface(D1);

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

  const propertiesIface = hci0Obj.getInterface(PROPS);

  objectManagerIface = bluez.getInterface("org.freedesktop.DBus.ObjectManager");

  discovering = (await propertiesIface.Get("org.bluez.Adapter1", "Discovering"))
    .value;

  dbg("Discovering:", discovering);

  propertiesIface.on("PropertiesChanged", (iface, changed) => {
    dbg("Adapter %s props changed:", iface, changed);

    if ((iface === "org.bluez.Adapter1", changed.Discovering)) {
      discovering = changed.Discovering.value;

      dbg("Discovering:", discovering);
    }
  });

  await adapterIface.SetDiscoveryFilter({
    Transport: new Variant("s", "le"),
  });
}

init().catch((err) => {
  console.error(err);
});

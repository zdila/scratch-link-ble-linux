const dbus = require("dbus-next");

const { debug } = require("./debug");

const { matchesFilter } = require("./filterMatcher");

const GS1 = "org.bluez.GattService1";

const GC1 = "org.bluez.GattCharacteristic1";

const D1 = "org.bluez.Device1";

const PROPS = "org.freedesktop.DBus.Properties";

const Variant = dbus.Variant;

const bus = dbus.systemBus();

let discovering = false;

let bluez;

let hci0Obj;

let adapterIface;

let objectManagerIface;

const deviceObjs = new Set();

function createSession() {
  const eventListeners = new Map();

  function on(type, callback) {
    let s = eventListeners.get(type);

    if (!s) {
      s = new Set();

      eventListeners.set(type, s);
    }

    s.add(callback);

    return () => {
      off(type, callback);
    };
  }

  function off(type, callback) {
    eventListeners.get(type).delete(callback);
  }

  function fire(type, params) {
    for (const callback of eventListeners.get(type) ?? []) {
      callback(params);
    }
  }

  let deviceObj = undefined;

  const charMap = new Map();

  const serviceMap = new Map();

  let filters;

  const connectCleanupTasks = [];

  const closeCleanupTasks = [];

  function getServices() {
    return serviceMap.values().map((s) => s.uuid);
  }

  function getCharacteristics(serviceId) {
    const service = serviceMap.values().find((s) => s.uuid === serviceId);

    service
      ? charMap
          .values()
          .filter((c) => c.path.startsWith(service.path))
          .map((c) => c.uuid)
      : [];
  }

  async function close() {
    for (const task of [...connectCleanupTasks, ...closeCleanupTasks]) {
      task();
    }

    await Promise.all([...notifMap.values()].map((fn) => fn()));

    if (deviceObj) {
      debug("Disconnecting device");

      const deviceIface = deviceObj.getInterface(D1);

      await deviceIface.Disconnect();

      deviceObjs.delete(deviceObj);
    }
  }

  async function discover(filtersParam) {
    filters = filtersParam;

    if (!discovering) {
      debug("Starting discovery");

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
        debug("Device %s props changed:", iface, changed);

        if (iface === D1 && changed.RSSI) {
          fire("didDiscoverPeripheral", {
            peripheralId: path,
            name: device?.Name?.value,
            rssi: changed.RSSI.value,
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
      debug("Stopping discovery");

      await adapterIface.StopDiscovery();
    }

    for (const task of connectCleanupTasks) {
      task();
    }

    connectCleanupTasks.length = 0;

    debug("Connecting to device", devicePath);

    deviceObj = await bus.getProxyObject("org.bluez", devicePath);

    deviceObjs.add(deviceObj);

    const propertiesIface = deviceObj.getInterface(PROPS);

    const srPromise = new Promise((resolve) => {
      const handlePropertiesChanges = (iface, changed) => {
        if (iface === D1) {
          if (changed.ServicesResolved) {
            const { value } = changed.ServicesResolved;

            debug("ServicesResolved:", value);

            resolve();
          }

          if (changed.Connected) {
            const { value } = changed.Connected;

            debug("Connected:", value);

            if (!value) {
              fire("disconnected");

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

        debug("Found GATT Characteristics", uuid);

        const obj = await bus.getProxyObject("org.bluez", path);

        const iface = obj.getInterface(GC1);

        charMap.set(path, { uuid, path, iface, obj });
      } else if (
        path.startsWith(devicePath) &&
        /\/service[0-9a-z]*$/.test(path)
      ) {
        const uuid = props[GS1].UUID.value;

        debug("Found GATT Service", uuid);

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

    debug("No such characteristic", serviceId, characteristicId);

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
        fire("characteristicDidChange", {
          serviceId,
          characteristicId,
          message: changed.Value.value,
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

  return {
    on,
    off,
    close,
    discover,
    connect,
    write,
    read,
    startNotifications,
    stopNotifications,
    getServices,
    getCharacteristics,
  };
}

async function initBle() {
  if (bluez) {
    throw new Error("already initialized");
  }

  bluez = await bus.getProxyObject("org.bluez", "/");

  hci0Obj = await bus.getProxyObject("org.bluez", "/org/bluez/hci0");

  adapterIface = hci0Obj.getInterface("org.bluez.Adapter1");

  const propertiesIface = hci0Obj.getInterface(PROPS);

  objectManagerIface = bluez.getInterface("org.freedesktop.DBus.ObjectManager");

  discovering = (await propertiesIface.Get("org.bluez.Adapter1", "Discovering"))
    .value;

  debug("Discovering:", discovering);

  propertiesIface.on("PropertiesChanged", (iface, changed) => {
    debug("Adapter %s props changed:", iface, changed);

    if ((iface === "org.bluez.Adapter1", changed.Discovering)) {
      discovering = changed.Discovering.value;

      debug("Discovering:", discovering);
    }
  });

  await adapterIface.SetDiscoveryFilter({
    Transport: new Variant("s", "le"),
  });

  process.on("SIGINT", () => {
    debug("Caught interrupt signal");

    const promises = [];

    try {
      if (discovering) {
        debug("Stopping discovery");

        promises.push(
          adapterIface.StopDiscovery().catch((err) => {
            console.err("Error StopDiscovery:", err);
          })
        );
      }

      for (const deviceObj of deviceObjs) {
        debug("Disconnecting");

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

  return { createSession };
}

module.exports = { initBle };

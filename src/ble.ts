import dbus, { Variant } from "dbus-next";
import { debug } from "./debug";
import { createEventTarget } from "./eventTarget";
import { Device, Filter, matchesFilter } from "./filterMatcher";

const GS1 = "org.bluez.GattService1";

const GC1 = "org.bluez.GattCharacteristic1";

const D1 = "org.bluez.Device1";

const PROPS = "org.freedesktop.DBus.Properties";

const bus = dbus.systemBus();

let discovering = false;

let bluez: dbus.ProxyObject;

let hci0Obj: dbus.ProxyObject;

let adapterIface: dbus.ClientInterface;

let objectManagerIface: dbus.ClientInterface;

const deviceObjs = new Set<dbus.ProxyObject>();

type EventName = "disconnected" | "discover" | "characteristicDidChange";

type CharacteristicChangeParams = {
  serviceId: string | null;
  characteristicId: string;
  message: Buffer;
};

export type DiscoverParams = {
  peripheralId: string;
  name?: string;
  rssi: number;
};

export type Session = ReturnType<typeof createSession>;

function createSession() {
  const { fire, on, off } = createEventTarget<{
    disconnect: void;
    discover: DiscoverParams;
    characteristicChange: CharacteristicChangeParams;
  }>();

  let deviceObj: dbus.ProxyObject | undefined;

  const charMap = new Map<
    string,
    {
      uuid: string;
      path: string;
      iface: dbus.ClientInterface;
      obj: dbus.ProxyObject;
    }
  >();

  const serviceMap = new Map<
    string,
    {
      uuid: string;
      path: string;
      iface: dbus.ClientInterface;
      obj: dbus.ProxyObject;
      isPrimary: boolean;
    }
  >();

  let filters: Filter[] | undefined;

  const connectCleanupTasks: (() => void)[] = [];

  const closeCleanupTasks: (() => void)[] = [];

  function getServices() {
    return [...serviceMap.values()].map((s) => s.uuid);
  }

  function getCharacteristics(serviceId: string) {
    const service = [...serviceMap.values()].find((s) => s.uuid === serviceId);

    service
      ? [...charMap.values()]
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

    // bus.disconnect();
  }

  async function discover(filtersParam: Filter[]) {
    filters = filtersParam;

    if (!discovering) {
      debug("Starting discovery");

      await adapterIface.StartDiscovery();
    }

    const handle = (path: string, props?: Record<string, unknown>) => {
      handleInterfaceAdded(path, props).catch((err: unknown) => {
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
      await handleInterfaceAdded(path, props as any);
    }
  }

  async function handleInterfaceAdded(
    path: string,
    props?: Record<string, unknown>
  ) {
    const device = props?.[D1] as Device | undefined;

    if (
      device &&
      filters?.some((filter) => matchesFilter(device as any, filter))
    ) {
      const deviceObj = await bus.getProxyObject("org.bluez", path);

      const propertiesIface = deviceObj.getInterface(PROPS);

      const handleDevicePropsChanged = (
        iface: string,
        changed: { RSSI?: unknown }
      ) => {
        debug("Device %s props changed:", iface, changed);

        if (iface === D1 && changed.RSSI) {
          fire("discover", {
            peripheralId: path,
            name: device?.Name?.value,
            rssi:
              changed.RSSI instanceof Variant
                ? Number(changed.RSSI.value)
                : 127,
          });
        }
      };

      propertiesIface.on("PropertiesChanged", handleDevicePropsChanged);

      connectCleanupTasks.push(() => {
        propertiesIface.off("PropertiesChanged", handleDevicePropsChanged);
      });
    }
  }

  async function connect(devicePath: string) {
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

    const srPromise = new Promise<void>((resolve) => {
      const handlePropertiesChanges = (
        iface: string,
        changed: Record<string, unknown>
      ) => {
        if (iface === D1) {
          if (changed.ServicesResolved instanceof Variant) {
            const { value } = changed.ServicesResolved;

            debug("ServicesResolved:", value);

            if (value) {
              resolve();
            }
          }

          if (changed.Connected instanceof Variant) {
            const { value } = changed.Connected;

            debug("Connected:", value);

            if (!value) {
              fire("disconnect", undefined);

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

    for (const [path, props0] of Object.entries(
      await objectManagerIface.GetManagedObjects()
    )) {
      const props = props0 as Record<string, Record<string, Variant>>;

      if (
        path.startsWith(devicePath + "/service") &&
        /\/char[0-9a-z]*$/.test(path)
      ) {
        const uuid: string = props[GC1].UUID.value;

        debug("Found GATT Characteristics", uuid);

        const obj = await bus.getProxyObject("org.bluez", path);

        const iface = obj.getInterface(GC1);

        charMap.set(path, { uuid, path, iface, obj });
      } else if (
        path.startsWith(devicePath) &&
        /\/service[0-9a-z]*$/.test(path)
      ) {
        const uuid: string = props[GS1].UUID.value;

        debug("Found GATT Service", uuid);

        const isPrimary = props[GS1].Primary.value;

        const obj = await bus.getProxyObject("org.bluez", path);

        const iface = obj.getInterface(GS1);

        serviceMap.set(path, { uuid, path, iface, obj, isPrimary });
      }
    }
  }

  // TODO optimize from O(n)
  function getChar(serviceId: string | null, characteristicId: string) {
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

  async function write(
    serviceId: string | null,
    characteristicId: string,
    msg: Buffer,
    withResponse: boolean
  ) {
    await getChar(serviceId, characteristicId).iface.WriteValue(msg, {
      type: new Variant("s", withResponse ? "request" : "command"),
    });
  }

  const notifMap = new Map<string, () => void>();

  async function startNotifications(
    serviceId: string | null,
    characteristicId: string
  ) {
    const key = serviceId + ":" + characteristicId;

    if (notifMap.has(key)) {
      console.warn("Duplicate notification subscription request for ", key);

      return;
    }

    const { iface, obj } = getChar(serviceId, characteristicId);

    await iface.StartNotify();

    const propertiesIface = obj.getInterface(PROPS);

    const handleNotif = (iface: string, changed: Record<string, unknown>) => {
      if (iface === GC1 && changed.Value instanceof Variant) {
        fire("characteristicChange", {
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

  async function stopNotifications(
    serviceId: string | null,
    characteristicId: string
  ) {
    await notifMap.get(serviceId + ":" + characteristicId)?.();
  }

  async function read(
    serviceId: string | null,
    characteristicId: string,
    startNotif = false
  ) {
    const { iface } = getChar(serviceId, characteristicId);

    const result = await iface.ReadValue({});

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

export async function initBle() {
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

  propertiesIface.on(
    "PropertiesChanged",
    (iface, changed: Record<string, unknown>) => {
      debug("Adapter %s props changed:", iface, changed);

      if (
        iface === "org.bluez.Adapter1" &&
        changed.Discovering instanceof Variant
      ) {
        discovering = changed.Discovering.value;

        debug("Discovering:", discovering);
      }
    }
  );

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
          adapterIface.StopDiscovery().catch((err: unknown) => {
            console.error("Error StopDiscovery:", err);
          })
        );
      }

      for (const deviceObj of deviceObjs) {
        debug("Disconnecting");

        const deviceIface = deviceObj.getInterface(D1);

        promises.push(
          deviceIface.Disconnect().catch((err: unknown) => {
            console.error("Error Disconnect:", err);
          })
        );
      }
    } finally {
      Promise.all(promises).finally(() => process.exit());
    }
  });

  return { createSession };
}

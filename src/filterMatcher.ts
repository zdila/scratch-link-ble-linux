import { Buffer } from "buffer";
import { Variant } from "dbus-next";

export type Filter = {
  name?: string;
  namePrefix?: string;
  services?: string[];
  manufacturerData?: Record<
    string,
    {
      mask: number[];
      dataPrefix: number[];
    }
  >;
};

export type Device = {
  Name?: Variant<string>;
  Alias?: Variant<string>;
  UUIDs?: Variant<string[]>;
  ManufacturerData?: Variant<Record<string, Variant<Buffer>>>;
};

export function matchesFilter(device: Device, filter: Filter) {
  return (
    (filter.name === undefined ||
      device.Name?.value === filter.name ||
      device.Alias?.value === filter.name) &&
    (filter.namePrefix === undefined ||
      (device.Name?.value ?? "").startsWith(filter.namePrefix) ||
      (device.Alias?.value ?? "").startsWith(filter.namePrefix)) &&
    !filter.services?.some(
      (uuid) => !(device.UUIDs?.value ?? []).includes(uuid)
    ) &&
    (filter.manufacturerData === undefined ||
      (device.ManufacturerData &&
        !Object.entries(filter.manufacturerData).some(([id, value]) => {
          const buff = device.ManufacturerData!.value[id]?.value;

          return (
            !buff ||
            value.mask.length > buff.length ||
            value.mask.some(
              (_, i) =>
                (buff.readUInt8(i) & value.mask[i]) !== value.dataPrefix[i]
            )
          );
        })))
  );
}

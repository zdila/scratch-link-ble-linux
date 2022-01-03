function matchesFilter(device, filter) {
  for (const prop of ["name", "namePrefix", "services", "manufacturerData"]) {
    if (!filter[prop]) {
      continue;
    }

    switch (prop) {
      case "name":
        if (
          device.Name?.value !== filter[prop] &&
          device.Alias?.value !== filter[prop]
        ) {
          return false;
        }

        break;
      case "namePrefix":
        if (
          !(device.Name?.value ?? "").startsWith(filter[prop]) &&
          !(device.Alias?.value ?? "").startsWith(filter[prop])
        ) {
          return false;
        }

        break;
      case "services":
        if (
          filter[prop].some(
            (uuid) => !(device.UUIDs?.value ?? []).includes(uuid)
          )
        ) {
          return false;
        }

        break;

      case "manufacturerData":
        if (
          !device.ManufacturerData ||
          Object.entries(filter[prop]).some(([id, value]) => {
            const buff = device.ManufacturerData.value[id]?.value;

            return (
              !buff ||
              value.mask.length > buff.length ||
              value.mask.some(
                (_, i) =>
                  (buff.readUInt8(i) & value.mask[i]) !== value.dataPrefix[i]
              )
            );
          })
        ) {
          return false;
        }

        break;
    }
  }

  return true;
}

module.exports = { matchesFilter };

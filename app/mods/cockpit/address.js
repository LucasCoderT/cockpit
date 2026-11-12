// Terminal addresses crossing the runner and desktop boundary keep their frontend handle prefix.

export function toRunner(address, machine) {
  if (!machine || typeof address !== "string") return address;
  const prefix = address.startsWith("app:") ? "app:" : "";
  const raw = address.slice(prefix.length);
  if (!raw.includes("/")) return address;
  if (!raw.startsWith(`${machine}/`) || raw.slice(machine.length + 1).includes("/")) throw new Error(`${address} is on another machine than ${machine}`);
  return prefix + raw.slice(machine.length + 1);
}

export function toDesktop(address, machine) {
  if (!machine || typeof address !== "string") return address;
  const prefix = address.startsWith("app:") ? "app:" : "";
  const raw = address.slice(prefix.length);
  if (raw.includes("/")) { toRunner(address, machine); return address; }
  return `${prefix}${machine}/${raw}`;
}

export function argsToRunner(value, machine) {
  if (Array.isArray(value)) return value.map(v => argsToRunner(v,machine));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,v]) =>
    [key,["terminal","address","handle"].includes(key) && typeof v === "string" ? toRunner(v,machine) : argsToRunner(v,machine)]));
  return value;
}

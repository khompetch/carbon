const modules = [
  "Accounting",
  "Documents",
  "Inventory",
  "Invoicing",
  "Parts",
  "Production",
  "Purchasing",
  "Resources",
  "Sales",
  "Settings",
  "Users"
] as const;

export type Module = (typeof modules)[number];

export { modules };

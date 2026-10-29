// Cloud services offered next to machines: the runtimes page's cloud group and
// "+ Add" menu, and the runtime step of agent creation. Both read these lists,
// so hiding or re-enabling a service is one change here.

export const QODER_CLOUD_PROVIDER = "qoder_cloud";

/** Services that are listed but cannot be connected yet. */
export const COMING_SOON_SERVICES = [
  { provider: "cursor", name: "Cursor Cloud Agents", vendor: "Cursor" },
  { provider: "claude", name: "Claude Managed Agents", vendor: "Anthropic" },
] as const;

// Claude only for now. Qoder and Cursor are hidden but kept, so turning them
// back on is a one-line change.
export const VISIBLE_CLOUD_PROVIDERS: ReadonlySet<string> = new Set(["claude"]);

export const SHOW_QODER_CLOUD = VISIBLE_CLOUD_PROVIDERS.has(QODER_CLOUD_PROVIDER);

export const VISIBLE_COMING_SOON_SERVICES = COMING_SOON_SERVICES.filter((service) =>
  VISIBLE_CLOUD_PROVIDERS.has(service.provider),
);

// Coming-soon services tagged "not yet available" instead of "coming soon".
// Their rows also drop the "By {vendor}" subtitle.
export const NOT_YET_AVAILABLE_PROVIDERS: ReadonlySet<string> = new Set(["claude"]);

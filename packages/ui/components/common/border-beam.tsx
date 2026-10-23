/**
 * Decorative highlight that sweeps around the host's rounded border. Render it
 * as a child of a positioned (`relative`), rounded host; the ring inherits the
 * host's border radius.
 *
 * `brand` is the multicolor sweep; `ink` is a monochrome foreground stroke for
 * surfaces that follow the black-and-white theme.
 */
export function BorderBeam({ variant = "brand" }: { variant?: "brand" | "ink" }) {
  return (
    <span className="border-beam-ring" data-variant={variant} aria-hidden="true">
      <span className="border-beam-light" />
    </span>
  );
}

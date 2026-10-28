import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-24 text-center">
      <span className="text-label font-medium tracking-[0.04em] text-muted-foreground">404</span>
      <h1 className="text-[1.625rem] font-semibold">Page not found</h1>
      <p className="text-body text-muted-foreground">
        The page you are looking for doesn&apos;t exist.
      </p>
      <Link
        href="/"
        className="mt-2 inline-flex h-10 items-center rounded-full bg-primary px-5 text-body font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Back to docs
      </Link>
    </main>
  );
}

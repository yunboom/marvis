import { InboxPage } from "@marvis/views/inbox";

// A wrapper, not a re-export: InboxPage takes props for the message box, and a
// Next.js page component may only take route params.
export default function Page() {
  return <InboxPage />;
}

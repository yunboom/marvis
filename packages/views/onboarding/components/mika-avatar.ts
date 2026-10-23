import mikaAvatar from "./mika-avatar.svg";

// Next.js types static imports as `{ src }` while Vite types them as a URL
// string; widening to both keeps either app's typecheck honest.
const avatar = mikaAvatar as string | { src: string };

/** Mirrors server/internal/handler/mika_avatar.svg, the artwork stored on the
 *  created agent — these two must move together or onboarding and the
 *  Runtimes page show one face and the created agent another. */
export const MIKA_AVATAR_SRC = typeof avatar === "string" ? avatar : avatar.src;

// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { BootstrapLoginError, bootstrapLogin } from "./bootstrap-login";

describe("bootstrapLogin", () => {
  it("posts the token and email and returns the session token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: "jwt", user: { id: "u1" } }), { status: 200 }));

    await expect(bootstrapLogin("http://127.0.0.1:13840", "tok", "admin@example.com", fetchImpl as unknown as typeof fetch)).resolves.toBe("jwt");

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:13840/auth/bootstrap",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "tok", email: "admin@example.com" }),
      }),
    );
  });

  it.each([
    [410, true],
    [401, false],
    [500, false],
  ])("HTTP %i throws BootstrapLoginError with tokenUsed=%s", async (status, tokenUsed) => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status }));
    const err = await bootstrapLogin("http://x", "tok", "a@b.co", fetchImpl as unknown as typeof fetch).catch((e) => e);
    expect(err).toBeInstanceOf(BootstrapLoginError);
    expect(err.tokenUsed).toBe(tokenUsed);
  });

  it("rejects a response without a token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ user: {} }), { status: 200 }));
    await expect(bootstrapLogin("http://x", "tok", "a@b.co", fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(BootstrapLoginError);
  });
});

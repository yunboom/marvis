import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateNotification, changelogUrl } from "./update-notification";

const PRODUCTION_APP_URL = "https://omniai.shoplazza.site/marvis";

const mocks = vi.hoisted(() => ({
  installUpdate: vi.fn(),
  openExternal: vi.fn(),
}));

type UpdateDownloadedListener = (info: {
  version: string;
  releaseNotes?: string;
}) => void;

describe("UpdateNotification", () => {
  let updateDownloaded: UpdateDownloadedListener;

  beforeEach(() => {
    mocks.installUpdate.mockReset().mockResolvedValue(undefined);
    mocks.openExternal.mockReset().mockResolvedValue(undefined);

    Object.defineProperty(window, "desktopAPI", {
      configurable: true,
      value: {
        openExternal: mocks.openExternal,
        runtimeConfig: { ok: true, config: { appUrl: PRODUCTION_APP_URL } },
      },
    });
    Object.defineProperty(window, "updater", {
      configurable: true,
      value: {
        onUpdateDownloaded: (listener: UpdateDownloadedListener) => {
          updateDownloaded = listener;
          return vi.fn();
        },
        installUpdate: mocks.installUpdate,
      },
    });
  });

  it("opens the downloaded version's changelog from the update prompt", () => {
    render(<UpdateNotification />);
    act(() => updateDownloaded({ version: "0.4.27" }));

    expect(screen.queryByRole("button", { name: "Later" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "See changelog" }));

    expect(mocks.openExternal).toHaveBeenCalledWith(
      "https://omniai.shoplazza.site/marvis/changelog#release-0-4-27",
    );
  });

  it("hides the changelog link when the server has no web app", () => {
    window.desktopAPI.runtimeConfig = { ok: true, config: { appUrl: "" } } as never;
    render(<UpdateNotification />);
    act(() => updateDownloaded({ version: "0.4.27" }));

    expect(screen.queryByRole("button", { name: "See changelog" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart now" })).toBeInTheDocument();
  });

  it("still installs the update immediately from the primary action", () => {
    render(<UpdateNotification />);
    act(() => updateDownloaded({ version: "0.4.27" }));

    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));

    expect(mocks.installUpdate).toHaveBeenCalledOnce();
  });
});

describe("changelogUrl", () => {
  it("appends /changelog after the deployment path prefix", () => {
    expect(changelogUrl(PRODUCTION_APP_URL, "0.0.1")).toBe(
      "https://omniai.shoplazza.site/marvis/changelog#release-0-0-1",
    );
    expect(changelogUrl(`${PRODUCTION_APP_URL}/`, "0.0.1")).toBe(
      "https://omniai.shoplazza.site/marvis/changelog#release-0-0-1",
    );
  });

  it("works for a root-path deployment", () => {
    expect(changelogUrl("http://localhost:3000", "1.2.3")).toBe(
      "http://localhost:3000/changelog#release-1-2-3",
    );
  });

  it("returns null without a web app address", () => {
    expect(changelogUrl("", "0.0.1")).toBeNull();
  });
});

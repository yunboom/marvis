import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@marvis/core/i18n/react";
import enProjects from "../../locales/en/projects.json";
import { ProjectIcon } from "./project-icon";
import { ProjectIconPicker } from "./project-icon-picker";

vi.mock("@marvis/ui/components/common/emoji-picker", () => ({
  EmojiPicker: ({ onSelect }: { onSelect: (emoji: string) => void }) => (
    <button type="button" onClick={() => onSelect("🚀")}>
      emoji-picker
    </button>
  ),
}));

function renderPicker(icon: string | null, onChange = vi.fn()) {
  render(
    <I18nProvider locale="en" resources={{ en: { projects: enProjects } }}>
      <ProjectIconPicker icon={icon} label="Change icon" onChange={onChange} />
    </I18nProvider>,
  );
  return onChange;
}

describe("ProjectIcon", () => {
  it.each([null, "", "icon:unknown"])("falls back to the folder glyph for %j", (icon) => {
    const { container } = render(<ProjectIcon project={{ icon }} />);
    expect(container.querySelector("[data-project-glyph]")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("renders a stored glyph as a line icon", () => {
    const { container } = render(<ProjectIcon project={{ icon: "icon:rocket" }} />);
    expect(container.querySelector("svg.lucide-rocket")).not.toBeNull();
  });

  it("keeps rendering emoji icons", () => {
    const { container } = render(<ProjectIcon project={{ icon: "🚀" }} />);
    expect(container.querySelector("[data-project-glyph]")).toBeNull();
    expect(container.textContent).toBe("🚀");
  });
});

describe("ProjectIconPicker", () => {
  it("opens on the icon tab and stores the chosen glyph", async () => {
    const user = userEvent.setup();
    const onChange = renderPicker(null);

    await user.click(screen.getByRole("button", { name: "Change icon" }));
    await user.click(screen.getByRole("button", { name: "Rocket" }));

    expect(onChange).toHaveBeenCalledWith("icon:rocket");
    expect(screen.queryByRole("button", { name: "Rocket" })).toBeNull();
  });

  it("marks the current glyph as selected", async () => {
    const user = userEvent.setup();
    renderPicker("icon:leaf");

    await user.click(screen.getByRole("button", { name: "Change icon" }));

    expect(screen.getByRole("button", { name: "Leaf" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Rocket" })).toHaveAttribute("aria-pressed", "false");
  });

  it("opens on the emoji tab for an emoji icon and still accepts emoji", async () => {
    const user = userEvent.setup();
    const onChange = renderPicker("🎯");

    await user.click(screen.getByRole("button", { name: "Change icon" }));
    await user.click(screen.getByRole("button", { name: "emoji-picker" }));

    expect(onChange).toHaveBeenCalledWith("🚀");
  });
});

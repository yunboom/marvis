import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@marvis/core/i18n/react";
import enProjects from "../../locales/en/projects.json";
import { ProjectIcon } from "./project-icon";
import { ProjectIconPicker } from "./project-icon-picker";

function renderPicker(icon: string | null, onChange = vi.fn()) {
  render(
    <I18nProvider locale="en" resources={{ en: { projects: enProjects } }}>
      <ProjectIconPicker icon={icon} label="Change icon" onChange={onChange} />
    </I18nProvider>,
  );
  return onChange;
}

describe("ProjectIcon", () => {
  it.each([null, "", "unicorn", "📁"])("falls back to the folder glyph for %j", (icon) => {
    const { container } = render(<ProjectIcon project={{ icon }} />);
    expect(container.querySelector("svg.lucide-folder")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("renders a stored key as its line icon", () => {
    const { container } = render(<ProjectIcon project={{ icon: "git-branch" }} />);
    expect(container.querySelector("svg.lucide-git-branch")).not.toBeNull();
  });
});

describe("ProjectIconPicker", () => {
  it("stores the chosen icon key and closes", async () => {
    const user = userEvent.setup();
    const onChange = renderPicker(null);

    await user.click(screen.getByRole("button", { name: "Change icon" }));
    await user.click(screen.getByRole("button", { name: "Rocket" }));

    expect(onChange).toHaveBeenCalledWith("rocket");
    expect(screen.queryByRole("button", { name: "Rocket" })).toBeNull();
  });

  it("marks the current icon as selected and offers no emoji", async () => {
    const user = userEvent.setup();
    renderPicker("leaf");

    await user.click(screen.getByRole("button", { name: "Change icon" }));

    expect(screen.getByRole("button", { name: "Leaf" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Rocket" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("tab")).toBeNull();
  });
});

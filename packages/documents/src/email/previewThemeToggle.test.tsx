import { render } from "@react-email/components";
import { afterEach, describe, expect, it } from "vitest";
import { EmailThemeProvider } from "./components/Theme";

const originalValue = process.env.EMAIL_DEV_PREVIEW;

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env.EMAIL_DEV_PREVIEW;
  } else {
    process.env.EMAIL_DEV_PREVIEW = originalValue;
  }
});

describe("preview theme toggle", () => {
  it("is absent from real sends (EMAIL_DEV_PREVIEW unset)", async () => {
    delete process.env.EMAIL_DEV_PREVIEW;
    const html = await render(
      <EmailThemeProvider>
        <div>hello</div>
      </EmailThemeProvider>
    );
    expect(html).not.toContain("__preview-dark-toggle");
  });

  it("renders in the preview server (EMAIL_DEV_PREVIEW=1)", async () => {
    process.env.EMAIL_DEV_PREVIEW = "1";
    const html = await render(
      <EmailThemeProvider>
        <div>hello</div>
      </EmailThemeProvider>
    );
    expect(html).toContain("__preview-dark-toggle");
    expect(html).toContain("prefers-color-scheme");
  });

  it("is suppressed when dark mode is disabled for the email", async () => {
    process.env.EMAIL_DEV_PREVIEW = "1";
    const html = await render(
      <EmailThemeProvider disableDarkMode>
        <div>hello</div>
      </EmailThemeProvider>
    );
    expect(html).not.toContain("__preview-dark-toggle");
  });
});

import { describe, it, expect } from "vitest";
import {
  STARTER_GOALS,
  WRITER_TONES,
  buildStarterTemplate,
  convertPersonalDraftToTemplate,
  reviewTemplateDraft,
  type StarterGoal,
  type WriterField,
  type WriterTone,
} from "./template-writer.js";
import { validateTemplate } from "./merge.js";

const fields: WriterField[] = [
  { name: "firstName", label: "First name", coverage: 0.9, custom: false },
  { name: "email", label: "Email", coverage: 1, custom: false },
  { name: "company", label: "Company", coverage: 0.6, custom: false },
  { name: "city", label: "city", coverage: 0.5, custom: true },
];

describe("buildStarterTemplate", () => {
  it("produces a valid template for every goal and tone, with fallbacks on partial fields", () => {
    for (const goal of Object.keys(STARTER_GOALS) as StarterGoal[]) {
      for (const tone of Object.keys(WRITER_TONES) as WriterTone[]) {
        const t = buildStarterTemplate({ goal, tone, fields, signOff: "Asha\nFocusRealm" });
        expect(validateTemplate({ subject: t.subject, bodyHtml: t.body })).toEqual([]);
        expect(reviewTemplateDraft(t, fields, 100)).toEqual([]);
        expect(t.body.endsWith("Asha\nFocusRealm")).toBe(true);
      }
    }
  });

  it("only uses fields the workspace has", () => {
    const bare = buildStarterTemplate({ goal: "introduction", tone: "warm", fields: [{ name: "email", label: "Email", coverage: 1, custom: false }] });
    expect(bare.body).not.toMatch(/\{\{/);
    expect(bare.body).toMatch(/^Hi there,/);
    const rich = buildStarterTemplate({ goal: "introduction", tone: "warm", fields });
    expect(rich.body).toContain("{{company|your team}} is building in {{city|your area}}");
  });

  it("produces distinct copy across warm, professional, concise, and upbeat tones", () => {
    for (const goal of Object.keys(STARTER_GOALS) as StarterGoal[]) {
      const bodies = (Object.keys(WRITER_TONES) as WriterTone[]).map(
        (tone) => buildStarterTemplate({ goal, tone, fields }).body
      );
      // All 4 tones must be distinct from each other
      const uniqueBodies = new Set(bodies);
      expect(uniqueBodies.size).toBe(4);
    }
  });

  it("uses a custom organisation column when there's no company", () => {
    const hotels: WriterField[] = [
      { name: "company", label: "Company", coverage: 0, custom: false },
      { name: "hotelName", label: "hotelName", coverage: 1, custom: true },
    ];
    expect(buildStarterTemplate({ goal: "meeting", tone: "warm", fields: hotels }).subject).toBe("15 minutes with {{hotelName|your team}} next week?");
  });
});

describe("reviewTemplateDraft", () => {
  it("flags unknown fields, missing fallbacks, placeholders and markdown", () => {
    const warnings = reviewTemplateDraft({ subject: "Hello {{company}}", body: "Hi {{nickname}},\n\n**Big news** about [your offer].\n\nUnsubscribe here" }, fields, 50);
    expect(warnings).toHaveLength(5);
    expect(warnings.join(" ")).toMatch(/nickname.*isn't a field/);
    expect(warnings.join(" ")).toMatch(/company.*no fallback, and 40%/);
    expect(warnings.join(" ")).toMatch(/bracketed/);
    expect(warnings.join(" ")).toMatch(/markdown/);
    expect(warnings.join(" ")).toMatch(/unsubscribe line is added automatically/);
  });

  it("is quiet for a clean draft", () => {
    expect(reviewTemplateDraft({ subject: "An idea for {{company|your team}}", body: "Hi {{firstName|there}},\n\nThanks!" }, fields, 50)).toEqual([]);
  });
});

describe("convertPersonalDraftToTemplate", () => {
  it("converts raw ChatGPT drafts with bracketed placeholders into a single mail-merge template", () => {
    const rawChatGPT = `
Sure! Here is a cold email draft for your outreach:

Subject: Exploring collaboration with [Company Name]

Hi [First Name],

I hope you're having a great week. I've been following [Company Name]'s hospitality work and wanted to connect.

At FocusRealm, we are building Mise Hotel to help teams streamline operations. We would love to explore a joint [Initiative] with your team.

Would you be open for a quick 15-minute call next week?

Best regards,
[Your Name]
Founder & CEO

Hope this helps! Let me know if you need any adjustments.

Option 2:
Subject: Quick question
Different email here...
`;

    const res = convertPersonalDraftToTemplate(rawChatGPT, fields, 100, { signOff: "Frank Lopes\nFocusRealm" });

    // Strictly ONE email format
    expect(res.subject).toBe("Exploring collaboration with {{company|your team}}");
    expect(res.body).not.toContain("Sure! Here is a cold email draft");
    expect(res.body).not.toContain("Hope this helps");
    expect(res.body).not.toContain("Option 2");
    expect(res.body).not.toContain("Different email here");

    // Placeholders mapped
    expect(res.body).toContain("Hi {{firstName|there}},");
    expect(res.body).toContain("{{company|your team}}'s hospitality work");
    expect(res.body).toContain('{{initiativeHeadline|"More Bookings, Better Operations"}}');
    expect(res.body).toContain("Frank Lopes");

    // Rules checklist
    expect(res.rules.find((r) => r.id === "single_format")?.passed).toBe(true);
    expect(res.rules.find((r) => r.id === "has_merge_tags")?.passed).toBe(true);
    expect(res.rules.find((r) => r.id === "fallback_safety")?.passed).toBe(true);
    expect(res.rules.find((r) => r.id === "no_raw_placeholders")?.passed).toBe(true);
  });

  it("handles snake_case {{first_name}} and {{company_name}} tags safely converting them to camelCase", () => {
    const draft = `Subject: Re: {{first_name|there}}, quick question for {{company_name|your hotel}}

Hi {{first_name|there}},

Hope all is well at {{company_name}}. We'd love to chat.
`;
    const res = convertPersonalDraftToTemplate(draft, fields, 100);
    expect(res.subject).toBe("Re: {{firstName|there}}, quick question for {{company|your hotel}}");
    expect(res.body).toContain("Hi {{firstName|there}},");
    expect(res.body).toContain("Hope all is well at {{company|your team}}.");
  });
});

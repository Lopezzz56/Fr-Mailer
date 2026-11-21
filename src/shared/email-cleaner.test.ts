import { describe, it, expect } from "vitest";
import { extractNewReplyContent } from "./email-cleaner.js";

describe("extractNewReplyContent", () => {
  it("preserves initial outreach messages without quotes", () => {
    const raw = `Hi Ajay,\n\nI’m reaching out from FocusRealm...\n\nBest regards,\nFrank Lopes\nFounder’s Office | FocusRealm\nfocusrealm.org\nmisehotel.com\n\n--\nYou received this email from Frank Lopes. Unsubscribe: https://example.com/u/123`;
    const res = extractNewReplyContent(raw);
    expect(res.cleanBody).toBe(raw);
    expect(res.quotedText).toBeNull();
  });

  it("extracts clean content from inline Outlook/SpaceMail header (Ajay Msg 2)", () => {
    const raw = `Frank, Thank you. Perhaps an initial 5 minutes just to understand what you plan and what you expect of me. Good luck, ajay From: Frank Lopes <founderoffice@focusrealm.org> Date: Friday, 13 November 2026 at 2:13 AM To: Ajay K. Bakaya <ajay@sarovarhotels.com> Subject: Exploring an`;
    const res = extractNewReplyContent(raw);
    expect(res.cleanBody).toBe("Frank, Thank you. Perhaps an initial 5 minutes just to understand what you plan and what you expect of me. Good luck, ajay");
    expect(res.quotedText).toContain("From: Frank Lopes <founderoffice@focusrealm.org>");
  });

  it("extracts clean content from multi-line From/Date header (Ajay Msg 3)", () => {
    const raw = `Perhaps tomorrow Frank?\nWhat time zone are you in?\n\nFrom: founderoffice@focusrealm.org <founderoffice@focusrealm.org>\nDate: Tuesday, 17 November 2026 at 4:32 PM\nTo: Ajay K. Bakaya <ajay@sarovarhotels.com>\nSubject: Re: Exploring an Advisory Role with MISE\nHi Ajay,\nThank you so much...`;
    const res = extractNewReplyContent(raw);
    expect(res.cleanBody).toBe("Perhaps tomorrow Frank?\nWhat time zone are you in?");
    expect(res.quotedText).toContain("From: founderoffice@focusrealm.org");
  });

  it("extracts clean content from final meeting confirmation (Ajay Msg 4)", () => {
    const raw = `3pm please Frank.\n\najay\n\nFrom: founderoffice@focusrealm.org <founderoffice@focusrealm.org>\nDate: Tuesday, 17 November 2026 at 4:52 PM\nTo: Ajay K. Bakaya <ajay@sarovarhotels.com>\nSubject: Re: Exploring an Advisory Role with MISE\nTommorrow works, I'm in India(IST).`;
    const res = extractNewReplyContent(raw);
    expect(res.cleanBody).toBe("3pm please Frank.\n\najay");
    expect(res.quotedText).toContain("From: founderoffice@focusrealm.org");
  });

  it("extracts clean content from Gmail style 'On <date>, <person> wrote:'", () => {
    const raw = `Sounds great, let's connect tomorrow.\n\nOn Tue, Nov 17, 2026 at 4:32 PM Frank Lopes <founderoffice@focusrealm.org> wrote:\n> Hi Ajay,\n> Would 3pm work for you?`;
    const res = extractNewReplyContent(raw);
    expect(res.cleanBody).toBe("Sounds great, let's connect tomorrow.");
    expect(res.quotedText).toContain("On Tue, Nov 17, 2026 at 4:32 PM");
  });

  it("extracts clean content from Apple Mail style 'On <date>, at <time>, <person> wrote:'", () => {
    const raw = `Thanks Frank, I'll review the deck.\n\nOn 17 Nov 2026, at 14:22, Frank Lopes <founderoffice@focusrealm.org> wrote:\n\n> Here is the attached deck.`;
    const res = extractNewReplyContent(raw);
    expect(res.cleanBody).toBe("Thanks Frank, I'll review the deck.");
    expect(res.quotedText).toContain("On 17 Nov 2026, at 14:22");
  });

  it("extracts clean content above horizontal divider and Original Message header", () => {
    const raw = `Let's discuss this next week.\n\n________________________________\nFrom: Frank Lopes\nSent: 17 November 2026 14:22\nTo: Ajay\nSubject: MISE Platform\n\nOriginal text here`;
    const res = extractNewReplyContent(raw);
    expect(res.cleanBody).toBe("Let's discuss this next week.");
    expect(res.quotedText).toContain("From: Frank Lopes");
  });

  it("extracts clean content above standard > quote lines", () => {
    const raw = `I am available anytime after 2pm.\n\n> When are you free?\n> Let me know your availability.`;
    const res = extractNewReplyContent(raw);
    expect(res.cleanBody).toBe("I am available anytime after 2pm.");
    expect(res.quotedText).toBe("> When are you free?\n> Let me know your availability.");
  });

  it("does not destroy content if the entire email looks like a quote", () => {
    const raw = `> Only a quoted question with no other text`;
    const res = extractNewReplyContent(raw);
    expect(res.cleanBody).toBe(raw);
  });

  it("handles null, undefined and empty input gracefully", () => {
    expect(extractNewReplyContent(null).cleanBody).toBe("");
    expect(extractNewReplyContent(undefined).cleanBody).toBe("");
    expect(extractNewReplyContent("").cleanBody).toBe("");
  });
});


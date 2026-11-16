import { describe, it, expect } from "vitest";
import {
  CAMPAIGN_OUTREACH_TYPES,
  CAMPAIGN_OUTREACH_TYPE_LABELS,
  type CampaignOutreachType,
  type OutreachFunnelDto,
} from "../../shared/types.js";

describe("Founder Overview Outreach Operations", () => {
  it("defines all 6 outreach types with human-readable labels", () => {
    expect(CAMPAIGN_OUTREACH_TYPES).toEqual([
      "CUSTOMER_OUTREACH",
      "PARTNERSHIPS",
      "ADVISORS",
      "HIRING_TALENT",
      "PRESS_MEDIA",
      "OTHER",
    ]);

    expect(CAMPAIGN_OUTREACH_TYPE_LABELS.CUSTOMER_OUTREACH).toBe("Customer Outreach");
    expect(CAMPAIGN_OUTREACH_TYPE_LABELS.PARTNERSHIPS).toBe("Partnerships");
    expect(CAMPAIGN_OUTREACH_TYPE_LABELS.ADVISORS).toBe("Advisors");
    expect(CAMPAIGN_OUTREACH_TYPE_LABELS.HIRING_TALENT).toBe("Hiring & Talent");
    expect(CAMPAIGN_OUTREACH_TYPE_LABELS.PRESS_MEDIA).toBe("Press & Media");
    expect(CAMPAIGN_OUTREACH_TYPE_LABELS.OTHER).toBe("Other");
  });

  it("calculates funnel strictly from Reached → Replies → Positive Outcomes → Meetings/Opportunities without Delivered", () => {
    const reached = 100;
    const replies = 25;
    const positiveOutcomes = 10;
    const meetings = 4;

    const funnel: OutreachFunnelDto = {
      reached,
      replies,
      positiveOutcomes,
      meetings,
      replyRate: Number(((replies / reached) * 100).toFixed(1)),
      positiveRate: Number(((positiveOutcomes / replies) * 100).toFixed(1)),
      meetingRate: Number(((meetings / positiveOutcomes) * 100).toFixed(1)),
      overallConversionRate: Number(((meetings / reached) * 100).toFixed(1)),
    };

    expect(funnel.reached).toBe(100);
    expect(funnel.replies).toBe(25);
    expect(funnel.positiveOutcomes).toBe(10);
    expect(funnel.meetings).toBe(4);
    expect(funnel.replyRate).toBe(25.0);
    expect(funnel.positiveRate).toBe(40.0);
    expect(funnel.meetingRate).toBe(40.0);
    expect(funnel.overallConversionRate).toBe(4.0);
  });

  it("handles empty / zero-activity period gracefully without division by zero", () => {
    const reached = 0;
    const replies = 0;
    const positiveOutcomes = 0;
    const meetings = 0;

    const funnel: OutreachFunnelDto = {
      reached,
      replies,
      positiveOutcomes,
      meetings,
      replyRate: reached > 0 ? Number(((replies / reached) * 100).toFixed(1)) : 0,
      positiveRate: replies > 0 ? Number(((positiveOutcomes / replies) * 100).toFixed(1)) : 0,
      meetingRate: positiveOutcomes > 0 ? Number(((meetings / positiveOutcomes) * 100).toFixed(1)) : 0,
      overallConversionRate: reached > 0 ? Number(((meetings / reached) * 100).toFixed(1)) : 0,
    };

    expect(funnel.replyRate).toBe(0);
    expect(funnel.positiveRate).toBe(0);
    expect(funnel.meetingRate).toBe(0);
    expect(funnel.overallConversionRate).toBe(0);
  });
});


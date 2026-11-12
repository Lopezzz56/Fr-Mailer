// SpaceMail / SMTP delivery error diagnosis and troubleshooting guidance

export interface DeliveryDiagnosis {
  isSenderMismatch: boolean;
  code?: string;
  title: string;
  summary: string;
  explanation: string;
  steps: string[];
  smtpDetails: string;
}

export function diagnoseDeliveryError(rawError: string | null | undefined): DeliveryDiagnosis | null {
  if (!rawError) return null;
  const isJellyfishMismatch = /554 5\.7\.1|JFE040011|<From> and <envelope-from>|sender (address )?rejected|not owned by user/i.test(rawError);
  if (isJellyfishMismatch) {
    return {
      isSenderMismatch: true,
      code: "JFE040011",
      title: "SpaceMail Sender Address Mismatch (JFE040011)",
      summary: "SpaceMail Jellyfish antispam rejected this message because the sender address in the email headers does not match the authenticated mailbox account.",
      explanation:
        "Namecheap SpaceMail strictly prohibits sending with an external or mismatched 'From:' domain. The authenticated SMTP account and the technical sender (<envelope-from>) must match. When they differ, Jellyfish terminates the connection to prevent unauthorized domain spoofing.",
      steps: [
        "Header Alignment Applied: Our mail delivery engine now automatically uses your authenticated mailbox account for the technical sender, while preserving your desired display name and setting your custom email as the Reply-To address.",
        "Retry Message: Click 'Retry sending' to dispatch this message. It will pass SpaceMail's security checks and all recipient replies will route to your inbox.",
        "Custom Domain Mailbox: If you prefer recipients to see your custom domain directly in the From address (e.g. @focusrealm.org), update your SMTP credentials in Settings > Mailbox to log in with an account on that domain.",
      ],
      smtpDetails: rawError,
    };
  }
  return null;
}


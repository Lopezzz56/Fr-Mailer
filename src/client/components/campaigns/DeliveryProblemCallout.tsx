import { useState } from "react";
import { AlertCircle, ChevronDown, ChevronUp, ExternalLink, RotateCcw, Settings } from "lucide-react";
import { diagnoseDeliveryError } from "../../../shared/delivery-errors";
import { Button, ButtonLink } from "../ui/Button";
import { Callout } from "../ui/Feedback";

interface DeliveryProblemCalloutProps {
  error: string;
  onRetry?: () => void;
  isRetrying?: boolean;
}

export function DeliveryProblemCallout({ error, onRetry, isRetrying }: DeliveryProblemCalloutProps) {
  const [showTechnical, setShowTechnical] = useState(false);
  const diagnosis = diagnoseDeliveryError(error);

  if (!diagnosis) {
    return (
      <div className="space-y-2">
        <Callout tone="danger" title="Delivery problem">
          <p className="whitespace-pre-wrap">{error}</p>
          {onRetry && (
            <div className="mt-3">
              <Button size="sm" variant="primary" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={onRetry} loading={isRetrying}>
                Retry sending
              </Button>
            </div>
          )}
        </Callout>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-red-200 bg-red-50/70 p-4 shadow-xs dark:border-red-900/40 dark:bg-red-950/20">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400">
          <AlertCircle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-[14px] font-bold text-red-950 dark:text-red-200">
              {diagnosis.title}
            </h4>
            <span className="rounded-md bg-red-100 px-2 py-0.5 text-2xs font-semibold text-red-800 dark:bg-red-900/60 dark:text-red-300">
              Error JFE040011
            </span>
          </div>

          <p className="mt-1 text-xs text-red-900/90 leading-relaxed dark:text-red-300/90">
            {diagnosis.summary}
          </p>

          <div className="mt-3 rounded-lg border border-red-200/80 bg-white/80 p-3 text-xs text-ink dark:border-red-900/30 dark:bg-[#0E1729]/80">
            <p className="font-semibold text-ink mb-1.5">How to resolve this:</p>
            <ol className="list-decimal space-y-1.5 pl-4 text-xs text-ink-muted leading-relaxed">
              <li>
                <span className="font-medium text-ink">Mailer auto-alignment:</span> We have configured our mail delivery engine to automatically dispatch via your authenticated mailbox login while setting your preferred sender email as <span className="font-mono font-medium">Reply-To</span>.
              </li>
              <li>
                <span className="font-medium text-ink">Retry delivery:</span> Click the button below to re-dispatch this message with compliant headers. SpaceMail's antispam check will pass.
              </li>
              <li>
                <span className="font-medium text-ink">Custom domain sending:</span> If you want your custom domain displayed directly in the <span className="font-mono">From</span> line, update your SMTP credentials in Settings &gt; Mailbox to authenticate with an account on that domain.
              </li>
            </ol>
          </div>

          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            {onRetry && (
              <Button
                size="sm"
                variant="primary"
                icon={<RotateCcw className="h-3.5 w-3.5" />}
                onClick={onRetry}
                loading={isRetrying}
              >
                Retry sending now
              </Button>
            )}
            <ButtonLink
              to="/settings/mailbox"
              size="sm"
              variant="secondary"
              icon={<Settings className="h-3.5 w-3.5" />}
            >
              Mailbox Settings
            </ButtonLink>
            <button
              type="button"
              onClick={() => setShowTechnical((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-subtle hover:bg-red-100/50 hover:text-ink dark:hover:bg-red-900/30"
            >
              {showTechnical ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {showTechnical ? "Hide technical details" : "View technical SMTP details"}
            </button>
          </div>

          {showTechnical && (
            <div className="mt-3 rounded-md bg-red-100/60 p-2.5 font-mono text-2xs text-red-950 dark:bg-red-950/60 dark:text-red-300">
              <p className="font-semibold mb-1">Raw SMTP Error:</p>
              <pre className="whitespace-pre-wrap break-all">{diagnosis.smtpDetails}</pre>
              <a
                href="https://www.namecheap.com/support/knowledgebase/article.aspx/10664/2216/jellyfish-error-codes/"
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-2xs font-semibold text-brand hover:underline"
              >
                Namecheap Jellyfish Knowledgebase <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


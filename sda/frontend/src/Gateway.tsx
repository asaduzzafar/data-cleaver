import { Button, Icon, type IconName } from "./ui";
import type { GatewayFinding, GatewayReview } from "./types";

/**
 * What the gateway decided, and what to do about it.
 *
 * A refusal that does not say what to try instead just teaches people to
 * distrust the tool, so every finding carries its own suggestions and they
 * are shown, not hidden behind a details toggle.
 *
 * The severity distinction is load-bearing and deliberately visible, and it
 * never rests on colour: each has its own mark and its own words.
 *   deny  -- a safety decision. No override exists, and none is offered.
 *   block -- a cost judgement. The analyst may know better; "Run it anyway"
 *            is right there once they have read why.
 *   warn  -- advisory. The query already ran.
 */

const SEVERITY: Record<GatewayFinding["severity"], {
  icon: IconName; label: string; frame: string; ink: string;
}> = {
  deny: { icon: "stop", label: "Refused",
          frame: "border-stop/40 bg-stop-wash", ink: "text-stop" },
  block: { icon: "alert", label: "Stopped before running",
           frame: "border-stop/40 bg-stop-wash", ink: "text-stop" },
  warn: { icon: "info", label: "Worth knowing",
          frame: "border-ref/30 bg-ref-wash", ink: "text-ref" },
};

function FindingBlock({ finding }: { finding: GatewayFinding }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold text-ink">{finding.title}</span>
        <span className="font-mono text-[12px] text-muted">
          {finding.rule.replace(/_/g, " ")}
        </span>
      </p>
      <p className="text-ink-2">{finding.detail}</p>
      {finding.suggestions.length > 0 && (
        <div className="mt-1">
          <p className="text-[12px] font-semibold text-ink-2">Try instead:</p>
          <ul className="mt-0.5 flex list-disc flex-col gap-0.5 pl-5 text-ink-2
                         marker:text-muted">
            {finding.suggestions.map((s, i) => (
              <li key={i}>
                {/* Code only when it starts as code -- "LIMIT 1000",
                    "count(...)" -- not prose that mentions SELECT. */}
                <span className={/^([A-Z_]{3,}\b|\w+\()/.test(s)
                  ? "font-mono text-[12px]" : ""}>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function GatewayNotice({ review, onConfirm, onDismiss }: {
  review: GatewayReview | null;
  /** Only rendered when the review is an overridable cost block. */
  onConfirm?: () => void;
  onDismiss?: () => void;
}) {
  if (!review || review.findings.length === 0) return null;
  const worst: GatewayFinding["severity"] =
    review.findings.find((f) => f.severity === "deny")?.severity ??
    review.findings.find((f) => f.severity === "block")?.severity ?? "warn";
  const sev = SEVERITY[worst];

  return (
    // A refusal answers the Run the analyst just pressed, so it is announced;
    // an advisory note sits beside results and waits to be read.
    <div role={worst === "warn" ? "status" : "alert"}
         className={`flex gap-2.5 rounded-lg border px-3.5 py-3 ${sev.frame}`}>
      <Icon name={sev.icon} size={16} className={`mt-0.5 shrink-0 ${sev.ink}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className={`font-semibold ${sev.ink}`}>{sev.label}</span>
          {review.estimated_rows > 0 && worst !== "warn" && (
            <span className="text-[12px] text-ink-2">
              about {review.estimated_rows.toLocaleString()} rows estimated
            </span>
          )}
        </p>

        {review.findings.map((f) => <FindingBlock key={f.rule} finding={f} />)}

        {(onConfirm || onDismiss) && worst !== "warn" && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
            {worst === "block" && review.overridable && onConfirm ? (
              <>
                <Button variant="danger" onClick={onConfirm}>Run it anyway</Button>
                <span className="text-[12px] text-ink-2">
                  It will hold a query slot while it runs.
                </span>
              </>
            ) : (
              <span className="text-[12px] text-ink-2">
                {worst === "deny"
                  ? "This is a safety rule, so there is no override."
                  : "This one cannot be overridden from here."}
              </span>
            )}
            {onDismiss && <Button variant="ghost" onClick={onDismiss}>Dismiss</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

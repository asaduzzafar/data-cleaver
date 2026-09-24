/**
 * The wait after MAKE IT SO is the Making it so panel; any other wait (a
 * page turn, the first automatic run) stays a status line.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { JobStatus } from "../../src/jobs";

const RUNNING = { id: "q", kind: "query", label: "", state: "running",
                  progress: null, error: null, position: 0, ahead: 0, queued_ms: 0,
                  elapsed_ms: 4200 } as const;

describe("JobStatus", () => {
  it("shows a job started from the action key as the Making it so panel", async () => {
    const cancel = vi.fn();
    render(<JobStatus job={RUNNING as never} onCancel={cancel} loud />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/Making it so/);
    expect(status).toHaveTextContent("Running · 4.2s");
    expect(screen.getByRole("img", { name: /Picard/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalled();
  });

  it("keeps any other wait to a status line", () => {
    render(<JobStatus job={RUNNING as never} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Running/);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

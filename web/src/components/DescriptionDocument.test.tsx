import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DescriptionDocument } from "./DescriptionDocument";

afterEach(cleanup);

it("keeps the description visible when an autolink contains an invalid port", () => {
  render(<DescriptionDocument
    value={"https://web-v4-home-seo.atomutest.com:31300；H5=390x844。共享服务已退出，31300/31301已独立检查无监听。\n\nVisible description"}
    referenceTasks={[]}
    onOpenTask={vi.fn()}
  />);

  expect(screen.getByText("Visible description")).toBeTruthy();
  fireEvent.click(screen.getByRole("link"));
  expect(screen.getByText("Visible description")).toBeTruthy();
});

it("still renders and opens a valid attachment link", () => {
  const attachment = {
    id: "file-1", taskId: "task-1", commentId: null, kind: "attachment" as const,
    filename: "report.pdf", contentType: "application/pdf", size: 1024, createdAt: "2026-10-08T00:00:00Z",
  };
  const onOpenAttachment = vi.fn();
  render(<DescriptionDocument
    value="[Download report](/api/attachments/file-1/download)"
    referenceTasks={[]}
    attachments={[attachment]}
    onOpenTask={vi.fn()}
    onOpenAttachment={onOpenAttachment}
  />);

  fireEvent.click(screen.getByRole("link", { name: /report\.pdf/ }));
  expect(onOpenAttachment).toHaveBeenCalledWith(expect.anything(), attachment);
});

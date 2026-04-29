type ApprovalRequest = { id: string; type: string };

const queue: ApprovalRequest[] = [];
let openWindowId: number | null = null;

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === openWindowId) {
    openWindowId = null;
    // Bump activity on close so auto-lock doesn't fire while we open the next.
    void import("./auto-lock").then(({ bumpActivity }) => bumpActivity());
    void openNext();
  }
});

export function isApprovalWindowOpen(): boolean {
  return openWindowId !== null;
}

export async function enqueueApproval(req: ApprovalRequest): Promise<void> {
  if (queue.find((r) => r.id === req.id)) return;
  queue.push(req);
  if (openWindowId === null) await openNext();
}

async function openNext(): Promise<void> {
  const next = queue.shift();
  if (!next) return;
  const url = chrome.runtime.getURL(
    `approval/index.html?requestId=${encodeURIComponent(next.id)}`,
  );
  const win = await chrome.windows.create({
    url,
    type: "popup",
    width: 400,
    height: 600,
    focused: true,
  });
  openWindowId = win.id ?? null;
}

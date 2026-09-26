import type {
  BrowserArchiveMode,
  BrowserArchiveResult,
  BrowserLogger,
  BrowserResearchMode,
  ChromeClient,
} from "../types.js";

export interface BrowserArchiveDecision {
  mode: BrowserArchiveMode;
  shouldArchive: boolean;
  reason: string;
}

export function isProjectChatgptUrl(url?: string | null): boolean {
  return /\/project(?:[/?#]|$)/i.test(url ?? "");
}

export function isTemporaryChatgptUrl(url?: string | null): boolean {
  try {
    const parsed = new URL(url ?? "");
    return (parsed.searchParams.get("temporary-chat") ?? "").trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

export function resolveBrowserArchiveDecision({
  mode = "auto",
  chatgptUrl,
  conversationUrl,
  researchMode,
  followUpCount,
}: {
  mode?: BrowserArchiveMode;
  chatgptUrl?: string | null;
  conversationUrl?: string | null;
  researchMode?: BrowserResearchMode;
  followUpCount?: number;
}): BrowserArchiveDecision {
  if (mode === "never") {
    return { mode, shouldArchive: false, reason: "disabled" };
  }
  if (!conversationUrl) {
    return { mode, shouldArchive: false, reason: "missing-conversation-url" };
  }
  if (isTemporaryChatgptUrl(chatgptUrl) || isTemporaryChatgptUrl(conversationUrl)) {
    return { mode, shouldArchive: false, reason: "temporary-chat" };
  }
  if (mode === "always") {
    return { mode, shouldArchive: true, reason: "forced" };
  }
  if (isProjectChatgptUrl(chatgptUrl) || isProjectChatgptUrl(conversationUrl)) {
    return { mode, shouldArchive: false, reason: "project-conversation" };
  }
  if (researchMode === "deep") {
    return { mode, shouldArchive: false, reason: "deep-research" };
  }
  if ((followUpCount ?? 0) > 0) {
    return { mode, shouldArchive: false, reason: "multi-turn" };
  }
  return { mode, shouldArchive: true, reason: "successful-one-shot" };
}

export async function archiveChatGptConversation(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  {
    mode,
    conversationUrl,
    input,
    page,
    client,
  }: {
    mode: BrowserArchiveMode;
    conversationUrl?: string | null;
    input?: ChromeClient["Input"];
    page?: ChromeClient["Page"];
    client?: ChromeClient;
  },
): Promise<BrowserArchiveResult> {
  const value = (
    input?.dispatchMouseEvent
      ? await archiveWithTrustedInput(Runtime, input, page, conversationUrl, client)
      : (
          await Runtime.evaluate({
            expression: buildArchiveConversationExpression(),
            awaitPromise: true,
            returnByValue: true,
          })
        ).result?.value
  ) as
    | { status: "archived"; conversationUrl?: string | null }
    | { status: "skipped"; reason: string; conversationUrl?: string | null }
    | { status: "failed"; error: string; conversationUrl?: string | null }
    | undefined;
  const resolvedUrl = value?.conversationUrl ?? conversationUrl ?? undefined;
  if (value?.status === "archived") {
    logger("[browser] Archived ChatGPT conversation after saving local artifacts.");
    return { mode, attempted: true, archived: true, conversationUrl: resolvedUrl };
  }
  const reason = value?.status === "skipped" ? value.reason : "archive-failed";
  const error = value?.status === "failed" ? value.error : undefined;
  logger(`[browser] ChatGPT archive skipped (${error ?? reason}).`);
  return {
    mode,
    attempted: true,
    archived: false,
    reason,
    conversationUrl: resolvedUrl,
    error,
  };
}

interface ArchiveClickPoint {
  x: number;
  y: number;
}

async function readArchiveClickPoint(
  Runtime: ChromeClient["Runtime"],
  expression: string,
): Promise<ArchiveClickPoint | null> {
  const evaluated = await Runtime.evaluate({ expression, returnByValue: true });
  const value = evaluated.result?.value as ArchiveClickPoint | null | undefined;
  return value && Number.isFinite(value.x) && Number.isFinite(value.y) ? value : null;
}

async function clickArchivePoint(
  Input: ChromeClient["Input"],
  point: ArchiveClickPoint,
): Promise<void> {
  await Input.dispatchMouseEvent({ type: "mouseMoved", ...point });
  await Input.dispatchMouseEvent({
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
  });
  await Input.dispatchMouseEvent({
    type: "mouseReleased",
    ...point,
    button: "left",
    clickCount: 1,
  });
}

export function buildTrustedArchiveMenuPointExpressionForTest(
  conversationUrl?: string | null,
): string {
  const conversationLiteral = JSON.stringify(conversationUrl ?? "");
  return `(() => {
    const current = new URL(${conversationLiteral} || location.href, location.href);
    const link = Array.from(document.querySelectorAll('a[href]')).find((element) => {
      try {
        const url = new URL(element.getAttribute('href') ?? '', location.href);
        return url.origin === current.origin && url.pathname === current.pathname;
      } catch { return false; }
    });
    const row = link?.closest('div.group[aria-label]');
    if (link && (!row || row.querySelectorAll('a[href*="/c/"]').length !== 1)) return null;
    let button = row?.querySelector('button[aria-label="Chat actions"]') ?? null;
    if (link && !button) return null;
    if (!link) {
      button = Array.from(document.querySelectorAll('button[aria-label="More"]'))
        .find((element) => element.getBoundingClientRect().top < 180) ?? null;
    }
    if (!(button instanceof HTMLElement)) return null;
    button.scrollIntoView({ block: 'center' });
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
}

async function archiveWithTrustedInput(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  Page: ChromeClient["Page"] | undefined,
  conversationUrl?: string | null,
  Client?: ChromeClient,
): Promise<
  | { status: "archived"; conversationUrl?: string | null }
  | { status: "skipped"; reason: string; conversationUrl?: string | null }
> {
  await Page?.bringToFront?.();
  const conversationLiteral = JSON.stringify(conversationUrl ?? "");
  const menuPoint = await readArchiveClickPoint(
    Runtime,
    buildTrustedArchiveMenuPointExpressionForTest(conversationUrl),
  );
  if (!menuPoint) {
    return { status: "skipped", reason: "conversation-menu-not-found", conversationUrl };
  }
  const resourceBaseline = await Runtime.evaluate({
    expression: `performance.getEntriesByType('resource').filter((entry) =>
      entry.name.includes('/backend-api/conversation/') &&
      entry.name.includes(new URL(${conversationLiteral} || location.href).pathname.split('/').at(-1))
    ).length`,
    returnByValue: true,
  });
  const baselineCount = Number(resourceBaseline.result?.value) || 0;
  await clickArchivePoint(Input, menuPoint);
  let archivePoint: ArchiveClickPoint | null = null;
  for (let i = 0; i < 12 && !archivePoint; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    archivePoint = await readArchiveClickPoint(
      Runtime,
      `(() => {
        const roots = Array.from(document.querySelectorAll('[role="menu"]'));
        const items = roots.flatMap((root) => Array.from(root.querySelectorAll('[role="menuitem"],button')));
        const item = items.find((element) => {
          const label = (element.innerText || element.getAttribute('aria-label') || '').trim().toLowerCase();
          return !/unarchive|restore|アーカイブを解除/.test(label) &&
            /archive|archiwizuj|アーカイブ/.test(label);
        });
        if (!(item instanceof HTMLElement)) return null;
        const rect = item.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
    );
  }
  if (!archivePoint) {
    return { status: "skipped", reason: "archive-menu-item-not-found", conversationUrl };
  }
  await clickArchivePoint(Input, archivePoint);
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const result = await Runtime.evaluate({
      expression: `(() => {
        const current = new URL(${conversationLiteral} || location.href, location.href);
        const sidebarLinkPresent = Array.from(document.querySelectorAll('a[href]')).some((element) => {
          try {
            const url = new URL(element.getAttribute('href') ?? '', location.href);
            return url.origin === current.origin && url.pathname === current.pathname;
          } catch { return false; }
        });
        const resources = performance.getEntriesByType('resource').filter((entry) =>
          entry.name.includes('/backend-api/conversation/') &&
          entry.name.includes(current.pathname.split('/').at(-1))
        ).slice(${baselineCount});
        return { sidebarLinkPresent, saved: resources.some((entry) =>
          entry.responseStatus >= 200 && entry.responseStatus < 300
        ) };
      })()`,
      returnByValue: true,
    });
    const state = result.result?.value as
      | { sidebarLinkPresent?: boolean; saved?: boolean }
      | undefined;
    if (state?.saved && state.sidebarLinkPresent === false) {
      // The sidebar removes a chat optimistically. Reload before claiming the
      // backend kept the archive; a 200 PATCH alone is not durable proof.
      if (!Page?.reload) {
        return { status: "skipped", reason: "archive-readback-unavailable", conversationUrl };
      }
      const conversationId = new URL(conversationUrl ?? "https://chatgpt.com").pathname
        .split("/")
        .at(-1);
      // The current page loads the plural detail route; older Oracle readers
      // also use the singular route. Accept either authenticated readback.
      const detailPaths = new Set([
        `/backend-api/conversations/${conversationId}`,
        `/backend-api/conversation/${conversationId}`,
      ]);
      const detailResponses: string[] = [];
      const finishedDetailResponses = new Set<string>();
      const onDetailResponse = (event: {
        requestId: string;
        response: { url: string; status: number };
      }) => {
        try {
          const url = new URL(event.response.url);
          if (detailPaths.has(url.pathname) && event.response.status === 200) {
            detailResponses.push(event.requestId);
          }
        } catch {
          /* Ignore malformed resource URLs. */
        }
      };
      const onDetailFinished = (event: { requestId: string }) => {
        if (detailResponses.includes(event.requestId)) {
          finishedDetailResponses.add(event.requestId);
        }
      };
      Client?.on("Network.responseReceived", onDetailResponse);
      Client?.on("Network.loadingFinished", onDetailFinished);
      await Page.reload({ ignoreCache: true });
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      // A responseReceived event is not a readable body yet. Give the matching
      // loadingFinished event a bounded chance to arrive before readback.
      const bodyDeadline = Date.now() + 2_000;
      while (
        detailResponses.length > 0 &&
        finishedDetailResponses.size === 0 &&
        Date.now() < bodyDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      for (const requestId of detailResponses) {
        const body = Client
          ? await Client.Network.getResponseBody({ requestId }).catch(() => null)
          : null;
        if (!body?.body) continue;
        let detail: { is_archived?: unknown };
        try {
          detail = JSON.parse(body.body) as { is_archived?: unknown };
        } catch {
          continue;
        }
        if (detail.is_archived === true) {
          return { status: "archived", conversationUrl };
        }
      }
      // ChatGPT often reloads the conversation before its sidebar list has
      // arrived. Give that list time to hydrate before treating readback as
      // inconclusive; a missing link in an empty sidebar proves nothing.
      const sidebarDeadline = Date.now() + 15_000;
      while (Date.now() < sidebarDeadline) {
        const readback = await Runtime.evaluate({
          expression: `(() => {
            const current = new URL(${conversationLiteral} || location.href, location.href);
            const links = Array.from(document.querySelectorAll('a[href]'));
            const recentCount = links.filter((element) => {
              try { return new URL(element.getAttribute('href') ?? '', location.href).pathname.startsWith('/c/'); }
              catch { return false; }
            }).length;
            const currentPresent = links.some((element) => {
              try {
                const url = new URL(element.getAttribute('href') ?? '', location.href);
                return url.origin === current.origin && url.pathname === current.pathname;
              } catch { return false; }
            });
            return { recentCount, currentPresent };
          })()`,
          returnByValue: true,
        }).catch(() => null);
        const fresh = readback?.result?.value as
          | { recentCount?: number; currentPresent?: boolean }
          | undefined;
        if ((fresh?.recentCount ?? 0) >= 3) {
          return fresh?.currentPresent === false
            ? { status: "archived", conversationUrl }
            : { status: "skipped", reason: "archive-readback-current-still-recent", conversationUrl };
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return { status: "skipped", reason: "archive-readback-pending", conversationUrl };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { status: "skipped", reason: "archive-not-confirmed", conversationUrl };
}

export function buildArchiveConversationExpressionForTest(): string {
  return buildArchiveConversationExpression();
}

function buildArchiveConversationExpression(): string {
  return `(() => {
    const conversationUrl = typeof location === 'object' ? location.href : null;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const normalize = (value) =>
      String(value ?? '')
        .replace(/\\s+/g, ' ')
        .trim()
        .toLowerCase();
    const isVisible = (element) => {
      if (!element || !(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const labelFor = (element) =>
      normalize([
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
        element.textContent,
      ].filter(Boolean).join(' '));
	    const click = (element) => {
	      const rect = element.getBoundingClientRect();
	      const eventInit = {
	        bubbles: true,
	        cancelable: true,
	        view: window,
	        clientX: rect.left + rect.width / 2,
	        clientY: rect.top + rect.height / 2,
	        button: 0,
	      };
	      if (typeof PointerEvent === 'function') {
	        element.dispatchEvent(new PointerEvent('pointerdown', {
	          ...eventInit,
	          buttons: 1,
	          pointerId: 1,
	          pointerType: 'mouse',
	          isPrimary: true,
	        }));
	      }
	      element.dispatchEvent(new MouseEvent('mousedown', { ...eventInit, buttons: 1 }));
	      if (typeof PointerEvent === 'function') {
	        element.dispatchEvent(new PointerEvent('pointerup', {
	          ...eventInit,
	          buttons: 0,
	          pointerId: 1,
	          pointerType: 'mouse',
	          isPrimary: true,
	        }));
	      }
	      element.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0 }));
	      element.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0 }));
	    };
    const currentUrl = new URL(conversationUrl ?? location.href, location.href);
    const findCurrentConversationLink = () =>
      Array.from(document.querySelectorAll('a[href]')).find((element) => {
        try {
          const url = new URL(element.getAttribute('href') ?? '', location.href);
          return url.origin === currentUrl.origin && url.pathname === currentUrl.pathname;
        } catch {
          return false;
        }
      });
    let sidebarConversationLinkFound = false;
    const findConversationMenuButton = () => {
	      // Recent ChatGPT layouts put Archive in the current chat's sidebar menu,
	      // while the header's More menu only contains actions such as Pin.
	      const currentLink = findCurrentConversationLink();
	      const row = currentLink?.closest('div.group[aria-label]');
	      if (currentLink && (!row || row.querySelectorAll('a[href*="/c/"]').length !== 1)) return null;
	      const sidebarButton = row?.querySelector('button[aria-label="Chat actions"]');
	      if (sidebarButton instanceof HTMLElement) {
	        sidebarConversationLinkFound = true;
	        sidebarButton.scrollIntoView({ block: 'center' });
	        return sidebarButton;
	      }
	      if (currentLink) return null;
	      const buttons = Array.from(document.querySelectorAll('button,[role="button"]'))
        .filter((element) => element instanceof HTMLElement && isVisible(element));
      const labelled = buttons
        .map((element) => ({ element, label: labelFor(element), rect: element.getBoundingClientRect() }))
        .filter(({ label }) =>
          label.includes('more') ||
          label.includes('conversation options') ||
          label.includes('open menu') ||
          label.includes('więcej') ||
          label.includes('opcje') ||
          label === 'その他' ||
          label.includes('会話オプション')
        );
      const headerCandidates = labelled
        .filter(({ rect }) => rect.top < 180 && rect.right > window.innerWidth - 420)
        .sort((a, b) => b.rect.right - a.rect.right);
      return (headerCandidates[0] ?? labelled[0])?.element ?? null;
    };
	    const visibleMenuCandidates = () => {
	      const menuRoots = Array.from(document.querySelectorAll('[role="menu"]'))
	        .filter((element) => element instanceof HTMLElement && isVisible(element));
	      const roots = menuRoots.length > 0 ? menuRoots : [document];
	      return roots.flatMap((root) =>
	        Array.from(root.querySelectorAll('[role="menuitem"],[role="option"],button,div[tabindex],a')),
	      ).filter((element) => element instanceof HTMLElement && isVisible(element));
	    };
	    const findArchiveMenuItem = () => {
	      const candidates = visibleMenuCandidates();
	      return candidates.find((element) => {
	        const label = labelFor(element);
	        if (!label) return false;
	        if (
	          label.includes('unarchive') ||
	          label.includes('restore') ||
	          label.includes('アーカイブを解除')
	        ) return false;
	        return (
	          label.includes('archive') ||
	          label.includes('archiwizuj') ||
	          label === 'アーカイブ' ||
	          label.includes('アーカイブする')
	        );
	      }) ?? null;
	    };
	    const findArchiveConfirmationButton = () => {
	      const candidates = Array.from(document.querySelectorAll('[role="dialog"] button,[role="dialog"] [role="button"]'))
	        .filter((element) => element instanceof HTMLElement && isVisible(element));
	      return candidates.find((element) => {
	        const label = labelFor(element);
	        if (!label) return false;
	        if (
	          label.includes('unarchive') ||
	          label.includes('restore') ||
	          label.includes('アーカイブを解除')
	        ) return false;
	        return (
	          label === 'archive' ||
	          label === 'archiwizuj' ||
	          label.includes('archive conversation') ||
	          label === 'アーカイブ' ||
	          label.includes('アーカイブする')
	        );
	      }) ?? null;
	    };
	    const hasUnarchiveMenuItem = () => {
	      const candidates = visibleMenuCandidates();
	      return candidates.some((element) => {
	        const label = labelFor(element);
	        return (
	          label.includes('unarchive') ||
	          label.includes('restore') ||
	          label.includes('przywróć') ||
	          label.includes('przywroc') ||
	          label.includes('アーカイブを解除')
	        );
	      });
	    };
	    const hasArchiveConfirmation = () => {
	      const visibleText = Array.from(document.querySelectorAll('[role="status"],[role="alert"],[data-testid*="toast"],[class*="toast"],[class*="snackbar"]'))
	        .filter((element) => element instanceof HTMLElement && isVisible(element))
	        .map((element) => labelFor(element))
	        .join(' ');
	      return (
	        visibleText.includes('archived') ||
	        visibleText.includes('conversation archived') ||
	        visibleText.includes('chat archived') ||
	        visibleText.includes('zarchiwizowano') ||
	        visibleText.includes('archiwum') ||
	        visibleText.includes('アーカイブしました') ||
	        visibleText.includes('アーカイブされました')
	      );
	    };
	    const waitForArchiveConfirmation = async () => {
	      const deadline = Date.now() + 3000;
	      while (Date.now() < deadline) {
	        if (conversationUrl && location.href !== conversationUrl) return true;
	        if (hasArchiveConfirmation()) return true;
	        if (sidebarConversationLinkFound && !findCurrentConversationLink()) return true;
	        await sleep(150);
	      }
	      return false;
	    };
	    const verifyArchivedStateFromMenu = async () => {
	      const menuButton = findConversationMenuButton();
	      if (!menuButton) return false;
	      click(menuButton);
	      await sleep(300);
	      const archived = hasUnarchiveMenuItem();
	      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	      return archived;
	    };
	    return (async () => {
	      const menuButton = findConversationMenuButton();
      if (!menuButton) {
        return { status: 'skipped', reason: 'conversation-menu-not-found', conversationUrl };
      }
      click(menuButton);
      await sleep(350);
      const archiveItem = findArchiveMenuItem();
      if (!archiveItem) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { status: 'skipped', reason: 'archive-menu-item-not-found', conversationUrl };
	      }
	      click(archiveItem);
	      await sleep(350);
	      const confirmButton = findArchiveConfirmationButton();
	      if (confirmButton) {
	        click(confirmButton);
	        await sleep(500);
	      }
	      if (await waitForArchiveConfirmation()) {
	        return { status: 'archived', conversationUrl };
	      }
	      if (await verifyArchivedStateFromMenu()) {
	        return { status: 'archived', conversationUrl };
	      }
	      return { status: 'skipped', reason: 'archive-not-confirmed', conversationUrl };
	    })().catch((error) => ({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      conversationUrl,
    }));
  })()`;
}

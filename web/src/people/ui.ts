// The shell owns the one Toast and the one ConfirmDialog. It registers them here once, so a
// person card nested anywhere (a circle inside a talk card, a search result, an inbox card) can
// show a toast or ask for confirmation without threading callbacks through every screen.

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
}

export interface PeopleUi {
  toast: (message: string, action?: { label: string; onClick: () => void }) => void;
  confirm: (data: ConfirmRequest) => void;
}

let ui: PeopleUi | null = null;

export function registerPeopleUi(next: PeopleUi | null): void {
  ui = next;
}

export function toast(message: string, action?: { label: string; onClick: () => void }): void {
  ui?.toast(message, action);
}

export function confirm(data: ConfirmRequest): void {
  if (ui) ui.confirm(data);
  else if (window.confirm(`${data.title}\n\n${data.body}`)) data.onConfirm();
}

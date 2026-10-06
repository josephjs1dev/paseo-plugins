import type { Decision, InboxItem, AnswerResult } from "../shared/models";
import type { Filter } from "../shared/inbox";
import type { RunSelection } from "./run-state";

export interface ViewState {
  section: "agents" | "runs";
  runQuery: string;
  runFilter: "all" | "active" | "blocked" | "completed";
  filter: Filter;
  query: string;
  groupBy: "project" | "workspace";
  selectedKey: string | null;
  runSelection: RunSelection | null;
  showSnoozed: boolean;
  drafts: Readonly<Record<string, Decision>>;
  notices: Readonly<Record<string, AnswerResult["status"] | "sending">>;
}
export class InboxSession {
  private state: ViewState = {
    section: "agents",
    runQuery: "",
    runFilter: "all",
    filter: "attention",
    query: "",
    groupBy: "project",
    selectedKey: null,
    runSelection: null,
    showSnoozed: false,
    drafts: {},
    notices: {},
  };
  private readonly listeners = new Set<() => void>();
  getSnapshot = (): ViewState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update(patch: Partial<ViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }
  select(item: InboxItem): void {
    let draft = this.state.drafts[item.key];
    if (!draft && item.form?.kind === "questions") {
      draft = {
        kind: "answers",
        answers: item.form.questions.map(() => ({ selected: [], text: "" })),
      };
    }
    this.update({
      section: "agents",
      selectedKey: item.key,
      ...(draft ? { drafts: { ...this.state.drafts, [item.key]: draft } } : {}),
    });
  }
  draft(key: string, value: Decision): void {
    this.update({ drafts: { ...this.state.drafts, [key]: value } });
  }
  notice(key: string, value: AnswerResult["status"] | "sending"): void {
    this.update({ notices: { ...this.state.notices, [key]: value } });
  }
  clear(): void {
    this.state = {
      ...this.state,
      drafts: {},
      notices: {},
      selectedKey: null,
      runSelection: null,
    };
    this.listeners.clear();
  }
}

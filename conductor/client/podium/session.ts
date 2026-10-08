import type {
  Decision,
  AgentItem,
  AnswerResult,
} from "../../shared/agents/models";
import type { Filter } from "../../shared/agents/attention";
import type { SymphonySelection } from "../symphonies/selection";

export interface ViewState {
  section: "agents" | "symphonies";
  symphonyQuery: string;
  symphonyFilter: "all" | "active" | "blocked" | "completed";
  filter: Filter;
  query: string;
  groupBy: "project" | "concert";
  selectedKey: string | null;
  symphonySelection: SymphonySelection | null;
  showSnoozed: boolean;
  drafts: Readonly<Record<string, Decision>>;
  notices: Readonly<Record<string, AnswerResult["status"] | "sending">>;
}
export class PodiumSession {
  private state: ViewState = {
    section: "agents",
    symphonyQuery: "",
    symphonyFilter: "all",
    filter: "attention",
    query: "",
    groupBy: "project",
    selectedKey: null,
    symphonySelection: null,
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
  select(item: AgentItem): void {
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
      symphonySelection: null,
    };
    this.listeners.clear();
  }
}
